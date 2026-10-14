// Adapted from drewappling/auto-model-router at b1201850f208ef9e2eb2716b5a1790fdc3310acb.
// See THIRD_PARTY_NOTICES.md for the MIT license.
import { object } from "../config.ts";

export interface ComplexityContext {
  toolCount?: number;
  lastSpawnFailed?: boolean;
  hasNewImage?: boolean;
}

export interface ComplexityFeatures {
  taskBytes: number;
  toolCount: number;
  lastSpawnFailed: boolean;
  hasNewImage: boolean;
  codeBlocks: number;
  complexityKeywords: string[];
  trivialityKeywords: string[];
}

const COMPLEXITY_KEYWORDS: readonly (readonly [string, RegExp])[] = [
  ["architecture", /\barchitecture\b/i],
  ["refactor", /\brefactor\w*/i],
  ["debug", /\bdebug\w*/i],
  ["race", /\brace\b/i],
  ["deadlock", /\bdeadlock\w*/i],
  ["why", /\bwhy\b/i],
  ["root cause", /\broot cause\b/i],
  ["design", /\bdesign\w*/i],
  ["optimize", /\boptimi[sz]\w*/i],
  ["security", /\bsecurity\b/i],
  ["migrate", /\bmigrat\w*/i],
  ["concurrency", /\bconcurren\w*/i],
  ["invariant", /\binvariant\w*/i],
  ["proof", /\bproof\w*/i],
];
const TRIVIALITY_KEYWORDS: readonly (readonly [string, RegExp])[] = [
  ["rename", /\brename\w*/i],
  ["typo", /\btypos?\b/i],
  ["format", /\bformat\w*/i],
  ["bump", /\bbump\w*/i],
  ["comment", /\bcomments?\b/i],
  ["changelog", /\bchangelogs?\b/i],
  ["add a test", /\badd (?:a|an|some) tests?\b/i],
  ["lint", /\blint(?:ing|ed)?\b/i],
];

/** Task-only text signals: no parent history, tool results, system prompt or reasoning setting. */
export function extractComplexityFeatures(
  task: string,
  context: ComplexityContext = {},
): ComplexityFeatures {
  return {
    taskBytes: Buffer.byteLength(task, "utf8"),
    toolCount: context.toolCount ?? 0,
    lastSpawnFailed: context.lastSpawnFailed ?? false,
    hasNewImage: context.hasNewImage ?? false,
    codeBlocks: Math.floor((task.split("```").length - 1) / 2),
    complexityKeywords: COMPLEXITY_KEYWORDS.filter(([, re]) => re.test(task)).map(([id]) => id),
    trivialityKeywords: TRIVIALITY_KEYWORDS.filter(([, re]) => re.test(task)).map(([id]) => id),
  };
}

/** The current spawn assistant message may already be in the branch. Ignore it, not history. */
export function hasNewImage(messages: readonly unknown[]): boolean {
  let index = messages.length - 1;
  const tail = messages[index];
  if (object(tail) && tail.role === "assistant") index--;
  for (; index >= 0; index--) {
    const message = messages[index];
    if (!object(message) || message.role !== "user") break;
    if (
      Array.isArray(message.content) &&
      message.content.some((part) => object(part) && part.type === "image")
    )
      return true;
  }
  return false;
}
