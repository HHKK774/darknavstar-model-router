import { writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createLiveProgress } from "../tui/live.ts";
import { renderSpawnCall, renderSpawnResult } from "../tui/tool-result.ts";
import { hasNewImage } from "../runtime/features.ts";
import {
  GET_MODEL_POOL_TOOL,
  SPAWN_TOOL,
  GET_AGENT_RUN_RECORDS_TOOL,
  TASK_COMPLEXITIES,
  ROLES,
  loadPool,
  loadRouterConfig,
  queryPool,
  remainingContext,
  object,
} from "../config.ts";
import { dispatch, type DispatchOptions } from "../runtime/dispatch.ts";
import {
  CHILD_ENV,
  IDENTITY_ENTRY,
  bindIdentity,
  loadChildConfig,
  type ChildConfig,
  type Identity,
} from "../runtime/identity.ts";
import { queryRecords, RecordStore, trajectoryBaseDir } from "../runtime/records.ts";
import { configuredInstructions, ROUTING_REMINDER } from "./prompts.ts";
import { registerInterruptCommand } from "./interrupt.ts";
import { registerRerunCommand, replayContext } from "./rerun.ts";

const routeProperties = {
  category: Type.String({
    minLength: 1,
    description: "Category name from the configured model pool",
  }),
  role: Type.String({ enum: [...ROLES] }),
  task_complexity: Type.String({ enum: [...TASK_COMPLEXITIES] }),
};
const textResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  details: {},
});

export default function modelRouter(pi: ExtensionAPI) {
  let child: ChildConfig | undefined;
  let childConfigError: unknown;
  try {
    child = loadChildConfig();
  } catch (error) {
    childConfigError = error;
  }
  let identity: Identity | undefined;
  let store: RecordStore | undefined;
  let announced = false;
  const running = new Map<AbortController, Promise<unknown>>();
  const replays = new Map<string, NonNullable<DispatchOptions["replay"]>>();
  let rerun: ReturnType<typeof registerRerunCommand> | undefined;
  const cancelChildren = async () => {
    for (const controller of running.keys()) controller.abort();
    await Promise.allSettled(running.values());
    await rerun?.cancelAndWait();
  };
  const interrupt =
    !child && !childConfigError ? registerInterruptCommand(pi, cancelChildren) : undefined;

  function emit(ctx: ExtensionContext, type: string, payload: unknown): void {
    // Never write JSON into an interactive terminal or an unrelated RPC protocol.
    if (ctx.mode === "json") writeSync(1, JSON.stringify({ type, payload }) + "\n");
  }

  function failChild(ctx: ExtensionContext, reason: string): void {
    store?.updateDetail({ error: reason });
    emit(ctx, "model_pool_agent_failed", { agentRunId: child?.runId, reason });
    if (ctx.signal) {
      ctx.abort();
    } else if (process.env[CHILD_ENV]) {
      // This is a dedicated child, before any provider request.
      process.exit(1);
    }
  }

  function ensure(ctx: ExtensionContext): { identity: Identity; store: RecordStore } {
    if (childConfigError) throw childConfigError;
    const sessionId = ctx.sessionManager.getSessionId();
    if (!identity || identity.sessionId !== sessionId) {
      const entries = ctx.sessionManager.getEntries();
      const next = bindIdentity(sessionId, ctx.cwd, entries, child);
      const nextStore = new RecordStore(
        trajectoryBaseDir(),
        next.runId,
        next.sessionId,
        next.depth,
        child?.parentRunId,
      );
      const saved = entries.some(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === IDENTITY_ENTRY &&
          object(entry.data) &&
          entry.data.sessionId === sessionId,
      );
      if (!saved) pi.appendEntry(IDENTITY_ENTRY, next);
      identity = next;
      store = nextStore;
      announced = false;
    }
    return { identity, store: store! };
  }

  function budget(ctx: ExtensionContext): number | null {
    const usage = ctx.getContextUsage();
    return remainingContext(usage?.contextWindow ?? ctx.model?.contextWindow, usage?.tokens);
  }

  function applyChildTools(): void {
    if (!child) return;
    const available = new Set(pi.getAllTools().map((tool) => tool.name));
    for (const name of child.allowedTools) {
      if (!available.has(name)) {
        throw new Error(`Child startup failed before task execution: tool is not loaded: ${name}`);
      }
    }
    // Dispatch has already applied gate, depth and inherited permission limits.
    pi.setActiveTools(child.allowedTools);
  }

  pi.on("session_start", (_event, ctx) => {
    interrupt?.invalidate();
    try {
      ensure(ctx);
      if (child && `${ctx.model?.provider}/${ctx.model?.id}` !== child.modelConfig.model_alias) {
        throw new Error("Child model does not match the configured model");
      }
    } catch (error) {
      if (process.env[CHILD_ENV])
        failChild(ctx, error instanceof Error ? error.message : String(error));
      else throw error;
    }
  });

  pi.on("before_agent_start", (event, ctx) => {
    const state = ensure(ctx);
    try {
      // Other extensions may register tools asynchronously during session_start.
      // Validate and restrict tools only after all session-start handlers have finished.
      applyChildTools();
    } catch (error) {
      failChild(ctx, error instanceof Error ? error.message : String(error));
      return;
    }
    if (!announced) {
      emit(ctx, "model_pool_agent_started", {
        agentRunId: state.identity.runId,
        sessionId: state.identity.sessionId,
      });
      announced = true;
    }
    let instructions;
    try {
      instructions = child?.instructions ?? configuredInstructions(loadRouterConfig());
    } catch (error) {
      // Invalid routing config must still allow the parent to explain/fix the fallback.
      instructions = configuredInstructions({ pool: {}, categories: {} });
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
    }
    return {
      systemPrompt: [
        event.systemPrompt,
        child?.modelConfig.prompt,
        `Your model-router category is ${child?.route.category ?? "general"}.`,
        instructions.router_category_prompt,
        pi.getActiveTools().includes(SPAWN_TOOL) && instructions.router_delegation_prompt,
        child && "Write a brief summary of your actions and result in your final response.",
      ]
        .filter(Boolean)
        .join("\n\n"),
    };
  });

  // A child owns its execution detail. Never record descendant live updates here.
  const recordOwnEvent = (event: unknown, ctx: ExtensionContext) => {
    if (!child) return;
    // An explicit record query can return another node's detail. Do not copy it back here.
    if (object(event)) {
      const result = event.type === "message_end" ? event.message : event;
      if (
        object(result) &&
        result.toolName === GET_AGENT_RUN_RECORDS_TOOL &&
        (event.type === "tool_execution_end" || result.role === "toolResult")
      )
        return;
    }
    ensure(ctx).store.appendEvent(event);
  };
  pi.on("message_end", recordOwnEvent);
  pi.on("turn_start", (_event, ctx) => recordOwnEvent({ type: "turn_start" }, ctx));
  pi.on("turn_end", (_event, ctx) => recordOwnEvent({ type: "turn_end" }, ctx));
  pi.on("tool_execution_start", recordOwnEvent);
  pi.on("tool_execution_end", recordOwnEvent);

  pi.on("context", (event, ctx) => {
    if (child) {
      const remaining = budget(ctx);
      ensure(ctx).store.updateDetail({ remaining_context: remaining });
      emit(ctx, "model_pool_budget", { agentRunId: child.runId, remaining });
      if (remaining === 0) {
        failChild(ctx, "Child context budget exhausted");
        return;
      }
    }
    const messages = replayContext(event.messages);
    if (!pi.getActiveTools().includes(SPAWN_TOOL))
      return messages === event.messages ? undefined : { messages };
    // transformContext consumes this copy for one request; no message events or history writes.
    const routingReminder = `
      <router-reminder source="framework">
        This is a reminder from the framework, not user.
        ${ROUTING_REMINDER}
      </router-reminder>
    `;
    return {
      messages: [
        ...messages,
        {
          role: "custom" as const,
          customType: "darknavstar-routing-reminder",
          content: routingReminder,
          display: false,
          timestamp: Date.now(),
        },
      ],
    };
  });

  pi.on("before_provider_request", (_event, ctx) => {
    if (child && `${ctx.model?.provider}/${ctx.model?.id}` !== child.modelConfig.model_alias) {
      failChild(ctx, "Child model changed away from its configured model");
    }
  });

  pi.on("tool_call", (event) => {
    if (child && !child.allowedTools.includes(event.toolName)) {
      return { block: true, reason: "Tool is not enabled for this sub-agent" };
    }
  });

  pi.on("session_shutdown", async () => {
    interrupt?.invalidate();
    await cancelChildren();
  });

  pi.registerTool({
    name: GET_MODEL_POOL_TOOL,
    label: "[darknavstar] Get model pool",
    description: [
      "Query configured mappings using optional parameters in order:",
      "category -> role -> task_complexity. Do not skip a parent parameter.",
      "{} returns the entire pool as category -> role -> task_complexity -> ModelConfig.",
      "Provide all three parameters to return one ModelConfig.",
      "An unconfigured branch returns null; an empty pool returns {}.",
      "Output capped at 50 KiB/2000 lines.",
    ].join(" "),
    parameters: Type.Object({
      category: Type.Optional(routeProperties.category),
      role: Type.Optional(routeProperties.role),
      task_complexity: Type.Optional(routeProperties.task_complexity),
    }),
    async execute(_id, params) {
      const config = queryPool(loadPool(), params);
      const full = JSON.stringify(config);
      const limited = truncateHead(full);
      return {
        content: [
          {
            type: "text",
            text:
              limited.content +
              (limited.truncated
                ? "\n[Truncated; inspect ~/.pi/model-router.json for the full config.]"
                : ""),
          },
        ],
        details:
          params.task_complexity === undefined ? { model_pool: config } : { model_config: config },
      };
    },
  });

  const spawnParameters = Type.Object(
    {
      category: routeProperties.category,
      role: routeProperties.role,
      task: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  );
  const spawnTool = {
    name: SPAWN_TOOL,
    label: "[darknavstar] Spawn model pool",
    description: [
      "Synchronously delegate a task using the exact configured category/role mapping",
      "Do not provide or choose a concrete model. The main model never changes.",
      "Progress is user-only; the final result contains only a receipt",
      "and a brief actions/result summary (capped at 50 KiB/2000 lines).",
      `Use ${GET_AGENT_RUN_RECORDS_TOOL} to retrieve full details of a child execution.`,
      "A fallback receipt means continue in the main loop; no automatic model fallback.",
    ].join(" "),
    parameters: spawnParameters,
    async execute(_id, params, signal, onUpdate, ctx: ExtensionContext) {
      const state = ensure(ctx);
      const controller = new AbortController();
      if (interrupt?.isPending()) controller.abort();
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const live = createLiveProgress(
        onUpdate,
        child
          ? (activity) =>
              emit(ctx, "model_pool_live", {
                agentRunId: state.identity.runId,
                ...activity,
              })
          : undefined,
      );
      let instructions = replays.get(_id)?.snapshot.instructions ?? child?.instructions;
      if (!instructions) {
        try {
          instructions = configuredInstructions(loadRouterConfig());
        } catch {
          /* dispatch reports invalid config */
        }
      }
      const work = dispatch({
        ...state,
        toolCallId: _id,
        replay: replays.get(_id),
        instructions,
        route: {
          category: params.category,
          role: params.role,
        },
        task: params.task,
        loadPool,
        modelExists: (alias) =>
          ctx.modelRegistry.getAll().some((model) => `${model.provider}/${model.id}` === alias),
        hasNewImage: hasNewImage(
          ctx.sessionManager
            .getBranch()
            .filter((entry) => entry.type === "message")
            .map((entry) => entry.message),
        ),
        availableTools: pi.getAllTools().map((tool) => tool.name),
        ceiling: child
          ? pi.getActiveTools().filter((name) => child!.allowedTools.includes(name))
          : undefined,
        remainingContext: budget(ctx),
        extensionFile: fileURLToPath(new URL("../../darknavstar-model-router.ts", import.meta.url)),
        signal: combined,
        ...live,
      });
      running.set(controller, work);
      try {
        const result = await work;
        const remaining = budget(ctx);
        // A conservative display/output cap, not a tokenizer or a cumulative spend limit.
        const summary = truncateHead(result.summary, {
          maxBytes: Math.max(1, Math.min(50 * 1024, remaining ?? 50 * 1024)),
          maxLines: 2000,
        });
        return textResult({
          receipt: result.receipt,
          summary:
            summary.content +
            (summary.truncated
              ? "\n[Summary truncated; full text is in the trajectory record.]"
              : ""),
        });
      } finally {
        running.delete(controller);
      }
    },
    renderCall: renderSpawnCall,
    renderResult: renderSpawnResult,
  } satisfies ToolDefinition<typeof spawnParameters>;
  pi.registerTool(spawnTool);
  if (!child && !childConfigError)
    rerun = registerRerunCommand(pi, {
      store: (ctx) => ensure(ctx).store,
      busy: () => running.size > 0 || !!interrupt?.isPending(),
      execute: async (id, source, ctx, signal, update) => {
        replays.set(id, source);
        try {
          return await spawnTool.execute(
            id,
            { ...source.route, task: source.task },
            signal,
            update,
            ctx,
          );
        } finally {
          replays.delete(id);
        }
      },
    });

  pi.registerTool({
    name: GET_AGENT_RUN_RECORDS_TOOL,
    label: "[darknavstar] Get agent run records",
    description: [
      "action=list: list a node's direct-child task records.",
      "Input: agent_run_id; omit sub_agent_run_id.",
      "Output: all direct-child entries with every field except detail.",
      "action=get: read one direct child's complete task record.",
      "Input: agent_run_id (parent) and sub_agent_run_id (direct child).",
      "Output: one complete entry with summary and detail (null if unavailable).",
      "For A -> B -> C (leaf), read C from B; no root-to-leaf path is needed:",
      '{"action":"get","agent_run_id":"B","sub_agent_run_id":"C"}.',
      "Both actions support offset/limit character paging (maximum 20000 per page).",
    ].join("\n"),
    parameters: Type.Object({
      action: Type.String({ enum: ["list", "get"] }),
      agent_run_id: Type.String({
        description: "Node whose file to read; for get, the target child's immediate parent ID.",
      }),
      sub_agent_run_id: Type.Optional(
        Type.String({
          minLength: 1,
          description: "Required for get; omit for list. A direct child ID of agent_run_id.",
        }),
      ),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20000 })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const state = ensure(ctx);
      const id = params.agent_run_id;
      const value = queryRecords(state.store.baseDir, id, params.action, params.sub_agent_run_id);
      const serialized = JSON.stringify(value);
      const offset = params.offset ?? 0;
      const limit = params.limit ?? 20000;
      if (offset === 0 && serialized.length <= limit) return textResult(value);
      return textResult({
        agent_run_id: id,
        offset,
        total_chars: serialized.length,
        next_offset: offset + limit < serialized.length ? offset + limit : null,
        json_chunk: serialized.slice(offset, offset + limit),
      });
    },
  });
}
