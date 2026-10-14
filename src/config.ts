import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// OpenAI/Codex tool names allow only letters, digits, underscores and hyphens.
export const GET_MODEL_POOL_TOOL = "darknavstar-get-model-pool";
export const SPAWN_TOOL = "darknavstar-spawn-model-pool";
export const GET_AGENT_RUN_RECORDS_TOOL = "darknavstar-get-agent-run-records";

export const ROLES = ["read-only", "read-write"] as const;
export const TASK_COMPLEXITIES = ["simple", "medium", "hard"] as const;
export type TaskComplexity = (typeof TASK_COMPLEXITIES)[number];
export const MAX_DEPTH = 4;
export const CONFIG_PATH = join(homedir(), ".pi", "model-router.json");

export interface Route {
  category: string;
  role: string;
  task_complexity: string;
}

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "off";

export interface ModelConfig {
  model_alias: string;
  censored: boolean;
  thinking_level?: ThinkingLevel;
  include_tools?: string[];
  exclude_tools?: string[];
  prompt?: string;
}

export type ModelPool = Record<string, Record<string, Record<string, ModelConfig>>>;

export interface CategoryInstructions {
  definition?: string;
  parent_responsibility?: string;
}
export interface RouterConfig {
  pool: ModelPool;
  categories: Record<string, CategoryInstructions>;
}

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function splitModelAlias(alias: string): [string, string] {
  const slash = alias.indexOf("/");
  if (slash <= 0 || slash === alias.length - 1 || alias.trim() !== alias) {
    throw new Error("model_alias must be an exact provider/model-id");
  }
  return [alias.slice(0, slash), alias.slice(slash + 1)];
}

export function validateModelConfig(value: unknown): asserts value is ModelConfig {
  if (!object(value)) throw new Error("ModelConfig must be an object");
  const allowed = [
    "model_alias",
    "censored",
    "thinking_level",
    "include_tools",
    "exclude_tools",
    "prompt",
  ];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Unknown ModelConfig field: ${key}`);
  }
  if (typeof value.model_alias !== "string") throw new Error("model_alias must be a string");
  splitModelAlias(value.model_alias);
  if (typeof value.censored !== "boolean")
    throw new Error("censored must be a boolean (true = untrusted)");
  if (
    value.thinking_level !== undefined &&
    !(THINKING_LEVELS as readonly unknown[]).includes(value.thinking_level)
  )
    throw new Error(`thinking_level must be one of: ${THINKING_LEVELS.join(", ")}`);
  if (value.prompt !== undefined && typeof value.prompt !== "string")
    throw new Error("prompt must be a string when provided");
  for (const field of ["include_tools", "exclude_tools"] as const) {
    const tools = value[field];
    if (
      tools !== undefined &&
      (!Array.isArray(tools) || tools.some((t) => typeof t !== "string" || !t.trim()))
    ) {
      throw new Error(`${field} must be an array of nonempty tool names`);
    }
  }
}

export function validateCategory(category: string): void {
  if (
    typeof category !== "string" ||
    !/^[a-z][a-z0-9_-]*$/.test(category) ||
    category === "constructor" ||
    category === "prototype"
  ) {
    throw new Error(
      "Invalid category: use a lowercase name with letters, digits, hyphens or underscores",
    );
  }
}

export function validateRoute(route: Route): void {
  validateCategory(route.category);
  if (!(ROLES as readonly string[]).includes(route.role)) throw new Error("Unknown role");
  if (!(TASK_COMPLEXITIES as readonly string[]).includes(route.task_complexity))
    throw new Error("Unknown task_complexity: expected simple, medium, or hard");
}

export function parseRouterConfig(value: unknown): RouterConfig {
  if (!object(value)) throw new Error("Model pool must be an object");
  const pool: ModelPool = {};
  const categories: RouterConfig["categories"] = {};
  for (const [category, roles] of Object.entries(value)) {
    if (!object(roles)) throw new Error(`Invalid roles for ${category}`);
    validateCategory(category);
    pool[category] = {};
    const instructions: CategoryInstructions = {};
    for (const field of ["definition", "parent_responsibility"] as const) {
      const instruction = roles[field];
      if (instruction !== undefined) {
        if (typeof instruction === "string") {
          instructions[field] = instruction;
        } else if (
          Array.isArray(instruction) &&
          instruction.every((line) => typeof line === "string")
        ) {
          instructions[field] = instruction.join("\n");
        } else {
          throw new Error(`${category}.${field} must be a string or an array of strings`);
        }
      }
    }
    categories[category] = instructions;
    for (const [role, complexities] of Object.entries(roles)) {
      if (role === "definition" || role === "parent_responsibility") continue;
      if (!(ROLES as readonly string[]).includes(role)) throw new Error(`Unknown role: ${role}`);
      if (!object(complexities)) throw new Error(`Invalid complexity map for ${category}/${role}`);
      if (Object.hasOwn(complexities, "default") && Object.hasOwn(complexities, "medium")) {
        throw new Error(`Conflicting complexity keys default and medium for ${category}/${role}`);
      }
      const normalized: Record<string, ModelConfig> = {};
      for (const [key, config] of Object.entries(complexities)) {
        // Compatibility is config-only; public routes and newly persisted entries use medium.
        const task_complexity = key === "default" ? "medium" : key;
        validateRoute({ category, role, task_complexity });
        validateModelConfig(config);
        normalized[task_complexity] = config;
      }
      pool[category][role] = normalized;
    }
  }
  return { pool, categories };
}

/** Model queries and routing never expose category instruction metadata as model mappings. */
export function parsePool(value: unknown): ModelPool {
  return parseRouterConfig(value).pool;
}

export function loadRouterConfig(path = join(homedir(), ".pi", "model-router.json")): RouterConfig {
  try {
    return parseRouterConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { pool: {}, categories: {} };
    throw new Error(
      `Cannot load model pool ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function loadPool(path = join(homedir(), ".pi", "model-router.json")): ModelPool {
  return loadRouterConfig(path).pool;
}

export function lookup(pool: ModelPool, route: Route): ModelConfig | null {
  validateRoute(route);
  return pool[route.category]?.[route.role]?.[route.task_complexity] ?? null;
}

/** Query a contiguous route prefix, returning the subtree at the supplied depth. */
export function queryPool(
  pool: ModelPool,
  route: Partial<Route> = {},
): ModelPool | ModelPool[string] | ModelPool[string][string] | ModelConfig | null {
  const { category, role, task_complexity } = route;
  if (role !== undefined && category === undefined) throw new Error("role requires category");
  if (task_complexity !== undefined && (category === undefined || role === undefined))
    throw new Error("task_complexity requires category and role");
  // Fill omitted levels only for validation, not for selecting a mapping.
  validateRoute({
    category: category === undefined ? "general" : category,
    role: role === undefined ? "read-only" : role,
    task_complexity: task_complexity === undefined ? "medium" : task_complexity,
  });
  if (category === undefined) return pool;
  if (role === undefined) return pool[category] ?? null;
  if (task_complexity === undefined) return pool[category]?.[role] ?? null;
  return lookup(pool, { category, role, task_complexity });
}

/** Role supplies defaults only. Explicit include replaces them; exclude always wins. */
export function resolveTools(
  config: ModelConfig,
  role: string,
  available: string[],
  depth: number,
  ceiling?: string[],
): string[] {
  const all = new Set(available);
  for (const name of config.include_tools ?? []) {
    if (!all.has(name)) throw new Error(`Configured tool is unavailable: ${name}`);
  }
  const base =
    config.include_tools ??
    available.filter((name) => role !== "read-only" || !["write", "edit"].includes(name));
  const excluded = new Set(config.exclude_tools ?? []);
  const inherited = ceiling ? new Set(ceiling) : undefined;
  return [...new Set(base)].filter(
    (name) =>
      !excluded.has(name) &&
      (!inherited || inherited.has(name)) &&
      (depth < MAX_DEPTH || name !== SPAWN_TOOL),
  );
}

/** Unknown usage remains unknown; never interpret cumulative billed tokens as context usage. */
export function remainingContext(
  window: number | undefined,
  usage: number | null | undefined,
): number | null {
  if (window === undefined || usage == null) return null;
  return Math.max(0, window - usage);
}
