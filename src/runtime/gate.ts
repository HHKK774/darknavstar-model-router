import { SPAWN_TOOL, type TaskComplexity } from "../config.ts";
import { extractComplexityFeatures, type ComplexityContext } from "./features.ts";

// Fixed calibration: pi's 8 built-ins + 5 declared tools + 3 router tools = 16.
// Do not derive the upper cutoff from each request, or the highest tier becomes unreachable.
export const BASE_TOOL_COUNT = 8;
export const CURRENT_TOOL_COUNT = 16;
const CURRENT_TOOL_SCORE = 3;
export const SIMPLE_THRESHOLD = (30 + CURRENT_TOOL_SCORE) / 10;

function toolCountScore(count: number): number {
  if (count <= BASE_TOOL_COUNT) return 0;
  return count <= CURRENT_TOOL_COUNT ? CURRENT_TOOL_SCORE : 6;
}

/**
 * Useful-feature subset of auto-model-router's heuristic (see THIRD_PARTY_NOTICES.md).
 * Units here are tenths of our 0–10 scale to avoid floating-point tier-boundary drift.
 * Byte thresholds replace upstream's 2k/8k token thresholds at roughly 4 bytes/token.
 */
export function calculateComplexity(task: string, context: ComplexityContext = {}): number {
  const f = extractComplexityFeatures(task, context);
  let score = 30;
  score += Math.min(f.complexityKeywords.length * 10, 30);
  score -= Math.min(f.trivialityKeywords.length * 9, 27);
  score += Math.min(f.codeBlocks * 4, 8);
  if (f.taskBytes > 32_000) score += 10;
  else if (f.taskBytes > 8_000) score += 5;
  score += toolCountScore(f.toolCount);
  if (f.lastSpawnFailed) score += 26;
  if (f.hasNewImage) score += 4;
  return Math.min(100, Math.max(0, score)) / 10;
}

export function classifyComplexity(score: number): TaskComplexity {
  if (score <= SIMPLE_THRESHOLD) return "simple";
  if (score > 7) return "hard";
  return "medium";
}

/** A gate only removes permissions; explicit includes cannot override it. */
export function gateChildTools(complexity: string, tools: readonly string[]): string[] {
  return tools.filter((name) => complexity === "hard" || name !== SPAWN_TOOL);
}
