import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_DEPTH,
  DEFAULT_THINKING_LEVEL,
  lookup,
  object,
  resolveTools,
  splitModelAlias,
  type ModelPool,
  type Route,
} from "../config.ts";
import { CHILD_ENV, type ChildConfig, type Identity } from "./identity.ts";
import { calculateComplexity, classifyComplexity, gateChildTools } from "./gate.ts";
import {
  receipt,
  validateRunId,
  type Receipt,
  type RecordStore,
  type RunEntry,
  type SpawnSnapshot,
  type ReplayEntry,
} from "./records.ts";
import { LiveFormatter, type LiveUpdate, parseLiveAction } from "./events.ts";
import { acquireCodingLock, CODING_LOCKS_ENV, type CodingLease } from "./coding-lock.ts";
import { piInvocation, runProcess, type Invocation } from "./runner.ts";

export interface DispatchResult {
  receipt: Receipt;
  summary: string;
}
export interface DispatchOptions {
  identity: Identity;
  store: RecordStore;
  toolCallId?: string;
  instructions?: SpawnSnapshot["instructions"];
  replay?: ReplayEntry;
  route: Pick<Route, "category" | "role">;
  task: string;
  hasNewImage?: boolean;
  loadPool: () => ModelPool;
  modelExists: (alias: string) => boolean;
  availableTools: string[];
  ceiling?: string[];
  remainingContext: number | null;
  extensionFile: string;
  signal?: AbortSignal;
  onProgress?: (receipt: Receipt) => void;
  onActivity?: (activity: LiveUpdate) => void;
  invocation?: (args: string[]) => Invocation;
}

/** Returns normally on delegation failure, allowing the original main loop to take over. */
export async function dispatch(options: DispatchOptions): Promise<DispatchResult> {
  const { identity, store } = options;
  // Read the latest completed attempt before adding this running attempt. User cancellation
  // is not model failure. Concurrent running siblings do not erase the last completed result.
  const latest = Object.values(store.node.entries)
    .filter((entry) => entry.end_time !== undefined)
    .sort((a, b) => a.end_time!.localeCompare(b.end_time!))
    .at(-1);
  const toolCount = new Set(
    options.availableTools.filter(
      (name) => options.ceiling === undefined || options.ceiling.includes(name),
    ),
  ).size;
  const complexity = calculateComplexity(options.task, {
    toolCount,
    lastSpawnFailed: latest?.status === "fail",
    hasNewImage: options.hasNewImage,
  });
  const replay = options.replay ? structuredClone(options.replay) : undefined;
  const task = replay?.task ?? options.task;
  const route: Route = replay?.route ?? {
    category: options.route.category,
    role: options.route.role,
    task_complexity: classifyComplexity(complexity),
  };
  const entry: RunEntry = {
    agent_run_id: identity.runId,
    sub_agent_run_id: randomUUID(),
    start_time: new Date().toISOString(),
    status: "running",
    fallback_to_main_loop: false,
    task,
    route,
    ...(options.toolCallId ? { tool_call_id: options.toolCallId } : {}),
    ...(replay
      ? {
          rerun_of: {
            agent_run_id: replay.agent_run_id,
            sub_agent_run_id: replay.sub_agent_run_id,
          },
        }
      : {}),
    summary: "",
  };
  store.add(entry);
  let temp: string | undefined;
  let codingLease: CodingLease | undefined;
  let started = false;
  let stopReason: string | undefined;
  let childFailure: string | undefined;
  let finalSummary = "";
  const formatter = new LiveFormatter();
  let currentTurn = 0;
  const activity = (
    text: string,
    runId = entry.sub_agent_run_id,
    turn = currentTurn,
    action?: LiveUpdate["action"],
  ) => {
    if (text || action) options.onActivity?.({ runId, text, turn, ...(action ? { action } : {}) });
  };
  const progress = () => options.onProgress?.(receipt(entry));
  const persist = () => {
    store.save();
    progress();
  };
  try {
    progress();
    if (options.signal?.aborted) {
      entry.status = "aborted";
      throw new Error("Cancelled before spawn");
    }
    if (identity.depth >= MAX_DEPTH)
      throw new Error(`Maximum delegation depth ${MAX_DEPTH} reached`);
    if (options.remainingContext === 0) throw new Error("Parent context budget exhausted");
    if (replay && replay.snapshot.project_dir !== identity.projectDir)
      throw new Error("Rerun cwd differs from the original snapshot");
    const config = replay?.model_config ?? lookup(options.loadPool(), route);
    if (!config) throw new Error("No model pool mapping; continue in the main loop");
    entry.model_config = config;
    if (!options.modelExists(config.model_alias))
      throw new Error(`Model unavailable: ${config.model_alias}`);
    const depth = identity.depth + 1;
    const permitted = gateChildTools(
      route.task_complexity,
      resolveTools(config, route.role, options.availableTools, depth, options.ceiling),
    );
    const tools = replay?.snapshot.allowed_tools ?? permitted;
    if (tools.some((name) => !permitted.includes(name)))
      throw new Error("Snapshot tools are no longer available or permitted; rerun refused");
    const instructions = replay?.snapshot.instructions ?? options.instructions;
    entry.snapshot = structuredClone({
      version: 1,
      allowed_tools: tools,
      project_dir: identity.projectDir,
      ...(instructions ? { instructions } : {}),
    });
    store.save();
    if (route.category === "coding") {
      let waiting = false;
      codingLease = await acquireCodingLock({
        cwd: identity.projectDir,
        runId: entry.sub_agent_run_id,
        signal: options.signal,
        onWait() {
          if (!waiting) activity("\nWaiting for another coding task in the same cwd to finish.\n");
          waiting = true;
          progress();
        },
      });
      if (waiting) activity("\nCoding cwd lock acquired; starting child.\n");
    }
    const child: ChildConfig = {
      runId: entry.sub_agent_run_id,
      parentRunId: identity.runId,
      projectDir: identity.projectDir,
      depth,
      modelConfig: config,
      route,
      allowedTools: tools,
      ...(instructions ? { instructions } : {}),
    };
    temp = mkdtempSync(join(tmpdir(), "darknavstar-model-router-"));
    const childFile = join(temp, "child.json");
    writeFileSync(childFile, JSON.stringify(child), { mode: 0o600 });
    const [provider, model] = splitModelAlias(config.model_alias);
    const args = [
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--provider",
      provider,
      "--model",
      model,
      "--thinking",
      config.thinking_level ?? DEFAULT_THINKING_LEVEL,
      "-e",
      options.extensionFile,
    ];
    if (tools.length) args.push("--tools", tools.join(","));
    else args.push("--no-tools");
    args.push("--", `Task:\n${task}`);
    store.save();
    activity("\nStarting child process; loading pi and extensions…\n", child.runId, 0);
    const result = await runProcess({
      invocation: (options.invocation ?? piInvocation)(args),
      cwd: identity.projectDir,
      env: {
        ...process.env,
        ...(codingLease ? { [CODING_LOCKS_ENV]: codingLease.ancestry } : {}),
        [CHILD_ENV]: childFile,
        PI_MODEL_ROUTER_RUN_ID: child.runId,
        PI_MODEL_ROUTER_PARENT_RUN_ID: child.parentRunId,
      },
      signal: options.signal,
      onTick: progress,
      onStderr: (text) =>
        activity(`\nstderr: ${text}`, child.runId, currentTurn, {
          id: "stderr",
          kind: "assistant",
          title: "stderr",
          text,
        }),
      onEvent(event) {
        if (event.type === "model_pool_live") {
          if (
            !object(event.payload) ||
            event.payload.agentRunId !== child.runId ||
            typeof event.payload.runId !== "string" ||
            typeof event.payload.text !== "string"
          )
            throw new Error("Invalid child live update");
          validateRunId(event.payload.runId);
          const turn = event.payload.turn;
          if (turn !== undefined && (!Number.isSafeInteger(turn) || (turn as number) < 0))
            throw new Error("Invalid child live turn");
          activity(
            event.payload.text,
            event.payload.runId,
            (turn as number | undefined) ?? 0,
            parseLiveAction(event.payload.action),
          );
          return;
        }
        if (event.type === "turn_start") currentTurn++;
        const text = formatter.format(event);
        activity(text, child.runId, currentTurn, formatter.action(event, text));
        if (event.type === "model_pool_agent_started") {
          if (
            !object(event.payload) ||
            event.payload.agentRunId !== child.runId ||
            typeof event.payload.sessionId !== "string"
          ) {
            throw new Error("Invalid child start receipt");
          }
          if (!started) activity("\nInitialization complete; agent started.\n", child.runId, 0);
          started = true;
          persist();
        } else if (event.type === "model_pool_budget") {
          if (object(event.payload) && event.payload.agentRunId === child.runId) {
            progress();
          }
        } else if (event.type === "model_pool_agent_failed") {
          childFailure =
            object(event.payload) && typeof event.payload.reason === "string"
              ? event.payload.reason
              : "Child failed";
          throw new Error(childFailure);
        } else if (event.type === "message_end") {
          if (object(event.message) && event.message.role === "assistant") {
            const message = event.message;
            if (`${message.provider}/${message.model}` !== config.model_alias)
              throw new Error("Child used a model other than the configured model");
            stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
            finalSummary = "";
            if ((stopReason === "stop" || stopReason === "end") && Array.isArray(message.content)) {
              finalSummary = message.content
                .filter(
                  (part) => object(part) && part.type === "text" && typeof part.text === "string",
                )
                .map((part) => (part as { text: string }).text)
                .join("\n");
            }
            childFailure =
              stopReason === "error" || stopReason === "aborted"
                ? String(message.errorMessage || `Child ${stopReason}`)
                : undefined;
          }
          persist();
        }
      },
    });
    entry.summary = finalSummary;
    entry.exit_code = result.exitCode;
    entry.signal = result.signal;
    if (result.aborted || stopReason === "aborted") entry.status = "aborted";
    if (result.aborted) throw new Error("Sub-agent cancelled");
    if (result.error) throw new Error(result.error);
    if (result.exitCode !== 0)
      throw new Error(
        `Sub-agent exited with ${result.exitCode ?? result.signal}; see live diagnostics`,
      );
    if (!started) throw new Error("Sub-agent exited without confirming its run ID");
    if (childFailure) throw new Error(childFailure);
    if (stopReason !== "stop" && stopReason !== "end")
      throw new Error(`Sub-agent did not complete: ${stopReason ?? "no final assistant message"}`);
    entry.status = "success";
  } catch (error) {
    if (entry.status !== "aborted") entry.status = options.signal?.aborted ? "aborted" : "fail";
    entry.reason = error instanceof Error ? error.message : String(error);
    entry.fallback_to_main_loop = true;
  } finally {
    try {
      if (temp) rmSync(temp, { recursive: true, force: true });
    } catch (error) {
      entry.reason = `Temporary configuration cleanup failed: ${String(error)}`;
      if (entry.status !== "aborted") entry.status = "fail";
      entry.fallback_to_main_loop = true;
    } finally {
      try {
        codingLease?.release();
      } catch (error) {
        entry.reason = `Coding lock cleanup failed: ${String(error)}`;
        if (entry.status !== "aborted") entry.status = "fail";
        entry.fallback_to_main_loop = true;
      }
    }
    entry.end_time = new Date().toISOString();
    persist();
  }
  return { receipt: receipt(entry), summary: entry.summary };
}
