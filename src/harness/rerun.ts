import type {
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { object, SPAWN_TOOL, validateModelConfig, validateRoute } from "../config.ts";
import { type RecordStore, type ReplayEntry } from "../runtime/records.ts";
import { renderLiveTurns } from "../tui/live-view.ts";
import type { LiveProgressResult } from "../tui/live.ts";

export const RERUN_COMMAND = "router-rerun-last-spawn";
export const RERUN_RESULT = "darknavstar-rerun-result";
type Result = Awaited<ReturnType<ToolDefinition["execute"]>>;
interface Dependencies {
  store(ctx: ExtensionContext): RecordStore;
  busy(): boolean;
  execute(
    id: string,
    source: ReplayEntry,
    ctx: ExtensionContext,
    signal: AbortSignal,
    update: (result: Result) => void,
  ): Promise<Result>;
}

/** Only current-branch calls qualify; never choose the last entry of the global trajectory. */
export function lastSpawn(ctx: ExtensionContext, store: RecordStore) {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const calls = entry.message.content.filter((part) => part.type === "toolCall");
    if (!calls.some((part) => part.name === SPAWN_TOOL)) continue;
    const results = calls.map((call) => {
      let preserved: Extract<ContextEvent["messages"][number], { role: "toolResult" }> | undefined;
      for (const next of branch.slice(i + 1)) {
        if (
          next.type === "message" &&
          next.message.role === "toolResult" &&
          next.message.toolCallId === call.id
        )
          preserved = structuredClone(next.message);
        if (
          next.type === "custom_message" &&
          next.customType === RERUN_RESULT &&
          object(next.details) &&
          next.details.toolCallId === call.id
        ) {
          preserved = {
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content:
              typeof next.content === "string"
                ? [{ type: "text", text: next.content }]
                : next.content,
            details: next.details.resultDetails,
            isError: next.details.isError === true,
            timestamp: Date.parse(next.timestamp),
          };
        }
      }
      if (call.name !== SPAWN_TOOL) {
        if (!preserved) throw new Error(`Missing original result for ${call.name}; rerun refused`);
        return { toolCallId: call.id, toolName: call.name, preserved };
      }
      let runId: string | undefined;
      if (preserved) {
        try {
          const text = preserved.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
          const value = JSON.parse(text);
          if (object(value.receipt) && value.receipt.agent_run_id === store.node.agent_run_id)
            runId = value.receipt.sub_agent_run_id;
        } catch {
          /* Not a router receipt. */
        }
      }
      const recorded = runId
        ? store.node.entries[runId]
        : Object.values(store.node.entries).find(
            (run) => run.tool_call_id === call.id && !run.rerun_of,
          );
      if (!recorded || recorded.status === "running" || !recorded.end_time)
        throw new Error("No finalized execution record for the last spawn");
      const source = structuredClone(recorded);
      const snapshot = source.snapshot;
      if (!snapshot || snapshot.version !== 1)
        throw new Error(
          "This spawn has no replay snapshot; older records cannot be replayed exactly",
        );
      validateRoute(source.route);
      validateModelConfig(source.model_config);
      if (
        snapshot.project_dir !== ctx.cwd ||
        typeof source.task !== "string" ||
        !Array.isArray(snapshot.allowed_tools) ||
        snapshot.allowed_tools.some((name) => typeof name !== "string") ||
        source.task !== call.arguments.task ||
        source.route.category !== call.arguments.category ||
        source.route.role !== call.arguments.role
      )
        throw new Error("Spawn snapshot does not match the selected call or current cwd");
      if (
        snapshot.instructions !== undefined &&
        (!object(snapshot.instructions) ||
          typeof snapshot.instructions.router_category_prompt !== "string" ||
          typeof snapshot.instructions.router_delegation_prompt !== "string")
      )
        throw new Error("Invalid snapshot instructions");
      return { toolCallId: call.id, toolName: call.name, source: source as ReplayEntry };
    });
    return { entryId: entry.id, results };
  }
  throw new Error("No spawn on the current branch");
}

/** Persist as a custom entry through pi's public API; project it to a paired tool result per request. */
export function replayContext(messages: ContextEvent["messages"]): ContextEvent["messages"] {
  if (!messages.some((message) => message.role === "custom" && message.customType === RERUN_RESULT))
    return messages;
  return messages.map((message) => {
    if (message.role !== "custom" || message.customType !== RERUN_RESULT) return message;
    const details = message.details;
    if (!object(details) || typeof details.toolCallId !== "string")
      throw new Error("Invalid rerun result metadata");
    // Compaction may have removed the original call; do not create an orphan tool result.
    const paired = messages.some(
      (item) =>
        item.role === "assistant" &&
        item.content.some(
          (part) =>
            part.type === "toolCall" &&
            part.name === (details.toolName ?? SPAWN_TOOL) &&
            part.id === details.toolCallId,
        ),
    );
    if (!paired) return message;
    return {
      role: "toolResult" as const,
      toolName: typeof details.toolName === "string" ? details.toolName : SPAWN_TOOL,
      details: details.resultDetails,
      toolCallId: details.toolCallId,
      content:
        typeof message.content === "string"
          ? [{ type: "text" as const, text: message.content }]
          : message.content,
      isError: details.isError === true,
      timestamp: message.timestamp,
    };
  });
}

export function registerRerunCommand(pi: ExtensionAPI, deps: Dependencies) {
  let pending = false;
  let navigating = false;
  let generation = 0;
  let controller: AbortController | undefined;
  let executionDone: Promise<void> | undefined;
  let finishExecution: (() => void) | undefined;
  pi.on("session_start", () => {
    generation++;
    controller?.abort();
  });
  pi.on("session_shutdown", () => {
    generation++;
    controller?.abort();
  });
  pi.on("session_before_tree", () => (pending && !navigating ? { cancel: true } : undefined));
  pi.on("session_before_fork", () => (pending ? { cancel: true } : undefined));
  pi.on("session_before_switch", () => (pending ? { cancel: true } : undefined));
  pi.on("session_before_compact", () => (pending ? { cancel: true } : undefined));
  pi.on("input", (_event, ctx) => {
    if (!pending) return;
    ctx.ui.notify(
      "Spawn rerun is in progress; wait or cancel it with /router-interrupt.",
      "warning",
    );
    return { action: "handled" as const };
  });
  pi.registerCommand(RERUN_COMMAND, {
    description:
      "Replay spawns in the last spawn batch; retain other tool results (no side-effect rollback)",
    async handler(args, ctx) {
      if (args.trim() && args.trim() !== "--confirm") {
        ctx.ui.notify(`Usage: /${RERUN_COMMAND} [--confirm]`, "warning");
        return;
      }
      if (!pi.getActiveTools().includes(SPAWN_TOOL)) {
        ctx.ui.notify("Spawn is not active in this session; rerun refused.", "warning");
        return;
      }
      if (pending || deps.busy() || !ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify(
          "Rerun requires an idle session with no running children or queued messages.",
          "warning",
        );
        return;
      }
      pending = true;
      const token = generation;
      const sessionId = ctx.sessionManager.getSessionId();
      const leafId = ctx.sessionManager.getLeafId();
      const current = () => token === generation && ctx.sessionManager.getSessionId() === sessionId;
      let branched: ReturnType<typeof lastSpawn> | undefined;
      try {
        const target = lastSpawn(ctx, deps.store(ctx));
        if (args.trim() !== "--confirm") {
          if (!ctx.hasUI)
            throw new Error(`Use /${RERUN_COMMAND} --confirm to acknowledge repeated side effects`);
          if (
            !(await ctx.ui.confirm(
              "Rerun last spawn?",
              "All spawns in this assistant call batch will be replayed. Other tool results are retained without re-execution. Old spawn results and subsequent messages stay on the old branch. Files and external resources are NOT rolled back; side effects may repeat.",
            ))
          )
            return;
        }
        if (
          !current() ||
          ctx.sessionManager.getLeafId() !== leafId ||
          !ctx.isIdle() ||
          ctx.hasPendingMessages() ||
          deps.busy() ||
          !pi.getActiveTools().includes(SPAWN_TOOL)
        )
          throw new Error("Session changed while confirming; rerun was not started");
        navigating = true;
        try {
          const navigation = await ctx.navigateTree(target.entryId, { summarize: false });
          if (navigation.cancelled) return;
        } finally {
          navigating = false;
        }
        if (!current() || ctx.sessionManager.getLeafId() !== target.entryId)
          throw new Error("Rerun branch point changed; execution refused");
        branched = target;
        const executionController = new AbortController();
        controller = executionController;
        executionDone = new Promise<void>((resolve) => {
          finishExecution = resolve;
        });
        const results = await Promise.all(
          target.results.map(async (item) => {
            if (!item.source) return { item, result: item.preserved! };
            try {
              const result = await deps.execute(
                item.toolCallId,
                item.source,
                ctx,
                executionController.signal,
                (partial) => {
                  if (!current() || ctx.mode !== "tui") return;
                  const details = partial.details as LiveProgressResult["details"];
                  if (!Array.isArray(details?.turns)) return;
                  ctx.ui.setWidget(RERUN_COMMAND, (_tui, theme) =>
                    renderLiveTurns(
                      details.turns,
                      `Replaying spawn ${item.toolCallId}…`,
                      undefined,
                      details.truncated,
                      false,
                      theme,
                    ),
                  );
                },
              );
              return { item, result };
            } catch (error) {
              return {
                item,
                result: {
                  content: [
                    {
                      type: "text" as const,
                      text: `Rerun failed: ${error instanceof Error ? error.message : String(error)}`,
                    },
                  ],
                  isError: true,
                },
                failed: true,
              };
            }
          }),
        );
        if (!current() || ctx.sessionManager.getLeafId() !== target.entryId) return;
        const aborted =
          controller.signal.aborted ||
          results.some(
            ({ result, failed }) =>
              failed ||
              result.content.some(
                (part) =>
                  part.type === "text" &&
                  (() => {
                    try {
                      return JSON.parse(part.text).receipt?.status === "aborted";
                    } catch {
                      return false;
                    }
                  })(),
              ),
          );
        // Publish the complete batch before requesting continuation.
        pending = false;
        for (const [index, { item, result }] of results.entries()) {
          pi.sendMessage(
            {
              customType: RERUN_RESULT,
              content: result.content,
              display: item.toolName === SPAWN_TOOL,
              details: {
                toolCallId: item.toolCallId,
                toolName: item.toolName,
                isError: "isError" in result && result.isError === true,
                resultDetails: "details" in result ? result.details : undefined,
              },
            },
            { triggerTurn: index === results.length - 1 && !aborted },
          );
        }
      } catch (error) {
        if (current()) {
          const reason = error instanceof Error ? error.message : String(error);
          // Even a pre-dispatch error must not leave an unpaired tool call on the new branch.
          if (branched && ctx.sessionManager.getLeafId() === branched.entryId) {
            for (const item of branched.results)
              pi.sendMessage(
                {
                  customType: RERUN_RESULT,
                  display: item.toolName === SPAWN_TOOL,
                  content: item.preserved?.content ?? [
                    { type: "text", text: `Rerun failed: ${reason}` },
                  ],
                  details: {
                    toolCallId: item.toolCallId,
                    toolName: item.toolName,
                    isError: item.preserved?.isError ?? true,
                    resultDetails: item.preserved?.details,
                  },
                },
                { triggerTurn: false },
              );
          }
          ctx.ui.notify(reason, "error");
        }
      } finally {
        if (current() && ctx.mode === "tui") ctx.ui.setWidget(RERUN_COMMAND, undefined);
        controller = undefined;
        pending = false;
        finishExecution?.();
        finishExecution = undefined;
        executionDone = undefined;
      }
    },
  });
  return {
    async cancelAndWait() {
      controller?.abort();
      await executionDone;
    },
  };
}
