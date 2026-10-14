import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  MAX_DEPTH,
  object,
  validateModelConfig,
  validateRoute,
  type ModelConfig,
  type Route,
} from "../config.ts";
import { validateRunId, type SpawnSnapshot } from "./records.ts";

export const IDENTITY_ENTRY = "model-router-identity";
export const CHILD_ENV = "PI_MODEL_ROUTER_CHILD_CONFIG";
export interface Identity {
  sessionId: string;
  runId: string;
  projectDir: string;
  depth: number;
}
export interface ChildConfig {
  runId: string;
  parentRunId: string;
  projectDir: string;
  depth: number;
  modelConfig: ModelConfig;
  route: Route;
  allowedTools: string[];
  instructions?: SpawnSnapshot["instructions"];
}

export function loadChildConfig(env = process.env): ChildConfig | undefined {
  const file = env[CHILD_ENV];
  if (!file) return undefined;
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (
    !object(value) ||
    typeof value.runId !== "string" ||
    typeof value.parentRunId !== "string" ||
    typeof value.projectDir !== "string" ||
    !isAbsolute(value.projectDir) ||
    !Number.isInteger(value.depth) ||
    (value.depth as number) < 1 ||
    (value.depth as number) > MAX_DEPTH ||
    !Array.isArray(value.allowedTools) ||
    value.allowedTools.some((t) => typeof t !== "string") ||
    !object(value.route)
  ) {
    throw new Error("Invalid child configuration");
  }
  if (
    value.instructions !== undefined &&
    (!object(value.instructions) ||
      typeof value.instructions.router_category_prompt !== "string" ||
      typeof value.instructions.router_delegation_prompt !== "string")
  ) {
    throw new Error("Invalid child instructions");
  }
  validateRunId(value.runId);
  validateRunId(value.parentRunId);
  validateModelConfig(value.modelConfig);
  validateRoute(value.route as unknown as Route);
  if (
    env.PI_MODEL_ROUTER_RUN_ID !== value.runId ||
    env.PI_MODEL_ROUTER_PARENT_RUN_ID !== value.parentRunId
  ) {
    throw new Error("Child run ID does not match its invocation");
  }
  return value as unknown as ChildConfig;
}

/** Matching the session ID is essential: forks may copy custom entries from the old session. */
export function bindIdentity(
  sessionId: string,
  projectDir: string,
  entries: readonly unknown[],
  child?: ChildConfig,
): Identity {
  for (const entry of [...entries].reverse()) {
    if (
      !object(entry) ||
      entry.type !== "custom" ||
      entry.customType !== IDENTITY_ENTRY ||
      !object(entry.data)
    )
      continue;
    const data = entry.data;
    if (data.sessionId !== sessionId) continue;
    if (
      typeof data.runId !== "string" ||
      typeof data.projectDir !== "string" ||
      !Number.isInteger(data.depth)
    ) {
      throw new Error("Invalid saved model-router identity");
    }
    validateRunId(data.runId);
    if (child && data.runId !== child.runId)
      throw new Error("Session is already bound to another child run");
    return data as unknown as Identity;
  }
  return {
    sessionId,
    runId: child?.runId ?? randomUUID(),
    projectDir: child?.projectDir ?? projectDir,
    depth: child?.depth ?? 0,
  };
}
