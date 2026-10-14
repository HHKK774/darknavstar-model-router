import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Global storage base, independent of the project/child working directory. */
export function trajectoryBaseDir(): string {
  return join(homedir(), ".pi");
}
import type { ModelConfig, Route } from "../config.ts";

export type RunStatus = "running" | "success" | "fail" | "aborted";
export interface Receipt {
  agent_run_id: string;
  sub_agent_run_id: string;
  start_time: string;
  end_time?: string;
  status: RunStatus;
  fallback_to_main_loop: boolean;
  reason?: string;
}
export interface RunDetail {
  events: unknown[];
  remaining_context?: number | null;
  error?: string;
  // Legacy fields retained for reading version-1 records.
  stderr?: string;
  session_id?: string;
  exit_code?: number | null;
  signal?: string | null;
}
export interface SpawnSnapshot {
  version: 1;
  allowed_tools: string[];
  project_dir: string;
  instructions?: { router_category_prompt: string; router_delegation_prompt: string };
}
export interface RunEntry extends Receipt {
  tool_call_id?: string;
  snapshot?: SpawnSnapshot;
  rerun_of?: { agent_run_id: string; sub_agent_run_id: string };
  task: string;
  route: Route;
  model_config?: ModelConfig;
  summary: string;
  exit_code?: number | null;
  signal?: string | null;
  /** Only version-1 entries embed details. New entries never do. */
  detail?: RunDetail;
}
export type ReplayEntry = RunEntry & { snapshot: SpawnSnapshot; model_config: ModelConfig };

export interface CompleteRunEntry extends Omit<RunEntry, "detail"> {
  detail: RunDetail | null;
}
export interface NodeRecord {
  schema_version: 1 | 2;
  agent_run_id: string;
  parent_run_id?: string;
  session_id: string;
  depth: number;
  /** This node's own execution, never its children's streamed events. */
  detail?: RunDetail;
  entries: Record<string, RunEntry>;
}

export function validateRunId(id: string): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error("Invalid agent run ID");
}

export function recordPath(baseDir: string, id: string): string {
  validateRunId(id);
  return join(baseDir, "model-router-trajectory", `${id}.json`);
}

export function readNode(baseDir: string, id: string): NodeRecord {
  const node = JSON.parse(readFileSync(recordPath(baseDir, id), "utf8")) as NodeRecord;
  if (
    (node.schema_version !== 1 && node.schema_version !== 2) ||
    node.agent_run_id !== id ||
    !node.entries ||
    typeof node.entries !== "object"
  ) {
    throw new Error(`Invalid trajectory node: ${id}`);
  }
  // Legacy descendant indexes are redundant; direct children live in their owner's entries.
  for (const entry of Object.values(node.entries)) Reflect.deleteProperty(entry, "sub_agents");
  return node;
}

/** One process owns this node. Synchronous mutations + atomic rename avoid sibling lost updates. */
export class RecordStore {
  readonly node: NodeRecord;
  readonly file: string;
  constructor(
    readonly baseDir: string,
    id: string,
    sessionId: string,
    depth: number,
    parentRunId?: string,
  ) {
    this.file = recordPath(baseDir, id);
    mkdirSync(join(baseDir, "model-router-trajectory"), { recursive: true, mode: 0o700 });
    try {
      this.node = readNode(baseDir, id);
      if (this.node.session_id !== sessionId)
        throw new Error("Run ID already belongs to a different session");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.node = {
        schema_version: 2,
        agent_run_id: id,
        parent_run_id: parentRunId,
        session_id: sessionId,
        depth,
        detail: { events: [] },
        entries: {},
      };
    }
    this.save();
  }

  save(): void {
    if (
      this.node.schema_version === 2 &&
      Object.values(this.node.entries).some((entry) => entry.detail !== undefined)
    ) {
      throw new Error("Child execution detail belongs in the child's own node file");
    }
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(this.node, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      renameSync(temp, this.file);
    } finally {
      rmSync(temp, { force: true });
    }
  }

  appendEvent(event: unknown): void {
    this.node.detail ??= { events: [] };
    // Events may be mutated by later pi handlers; persist a snapshot.
    this.node.detail.events.push(structuredClone(event));
    this.save();
  }

  updateDetail(patch: Partial<Omit<RunDetail, "events">>): void {
    this.node.detail ??= { events: [] };
    Object.assign(this.node.detail, patch);
    this.save();
  }

  add(entry: RunEntry): void {
    validateRunId(entry.sub_agent_run_id);
    if (this.node.entries[entry.sub_agent_run_id]) throw new Error("Duplicate child run ID");
    if (entry.detail !== undefined)
      throw new Error("Child execution detail belongs in the child's own node file");
    this.node.entries[entry.sub_agent_run_id] = entry;
    this.save();
  }
}

export function receipt(entry: RunEntry): Receipt {
  const {
    agent_run_id,
    sub_agent_run_id,
    start_time,
    end_time,
    status,
    fallback_to_main_loop,
    reason,
  } = entry;
  return {
    agent_run_id,
    sub_agent_run_id,
    start_time,
    end_time,
    status,
    fallback_to_main_loop,
    reason,
  };
}

export function queryRecords(
  baseDir: string,
  id: string,
  action: string,
  subAgentRunId?: string,
): Omit<RunEntry, "detail">[] | CompleteRunEntry {
  if (action !== "list" && action !== "get") throw new Error("action must be list or get");
  if (action === "list" && subAgentRunId !== undefined)
    throw new Error("list accepts agent_run_id, not sub_agent_run_id");
  if (action === "get" && (typeof subAgentRunId !== "string" || !subAgentRunId.length))
    throw new Error("get requires a nonempty sub_agent_run_id");
  const node = readNode(baseDir, id);
  if (action === "list") {
    return Object.values(node.entries).map(({ detail: _detail, ...entry }) => entry);
  }
  const childId = subAgentRunId!;
  validateRunId(childId);
  if (!Object.hasOwn(node.entries, childId))
    throw new Error(`Run ${childId} is not a direct child of ${node.agent_run_id}`);
  const { detail: legacyDetail, ...entry } = node.entries[childId];
  if (legacyDetail !== undefined) return { ...entry, detail: legacyDetail };
  try {
    const child = readNode(baseDir, childId);
    if (child.schema_version === 2 && child.parent_run_id !== id)
      throw new Error(`Run ${childId} belongs to a different parent`);
    return { ...entry, detail: child.detail ?? null };
  } catch (error) {
    // Preflight failures and early crashes may never create a child file.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...entry, detail: null };
    throw error;
  }
}
