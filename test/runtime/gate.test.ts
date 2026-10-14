import assert from "node:assert/strict";
import { test } from "node:test";
import { SPAWN_TOOL } from "../../src/config.ts";
import { calculateComplexity, classifyComplexity, gateChildTools } from "../../src/runtime/gate.ts";

test("complexity uses only selected signals with upstream weights scaled to 0–10", () => {
  assert.equal(calculateComplexity(""), 3);
  assert.equal(calculateComplexity("Inspect source"), 3);
  assert.equal(calculateComplexity("rename a typo"), 1.2);
  assert.equal(calculateComplexity("architecture refactor debug design"), 6);
  assert.equal(calculateComplexity("architecture architecture"), 4);
  assert.equal(calculateComplexity("rename typo format bump lint"), 0.3);
  assert.equal(calculateComplexity("", { toolCount: 1 }), 3);
  assert.equal(calculateComplexity("", { toolCount: 100 }), 3.6);
  assert.equal(calculateComplexity("", { lastSpawnFailed: true }), 5.6);
  assert.equal(calculateComplexity("", { hasNewImage: true }), 3.4);
  assert.equal(calculateComplexity("```ts\nx\n```"), 3.4);
  assert.equal(calculateComplexity("```x``` ```y``` ```z```"), 3.8);
  // No extra weight for questions, diffs, terse instructions, or reasoning requests.
  assert.equal(calculateComplexity("???\ndiff --git a/x b/x\nthink hard"), 3);
  assert.equal(
    calculateComplexity("architecture refactor debug " + "x".repeat(32_001) + "```a``` ```b```", {
      toolCount: 1,
      lastSpawnFailed: true,
      hasNewImage: true,
    }),
    10,
  );
});

test("task byte thresholds count UTF-8 bytes rather than characters or tokens", () => {
  assert.equal(calculateComplexity("x".repeat(8_000)), 3);
  assert.equal(calculateComplexity("x".repeat(8_001)), 3.5);
  assert.equal(calculateComplexity("x".repeat(32_000)), 3.5);
  assert.equal(calculateComplexity("x".repeat(32_001)), 4);
  assert.equal(calculateComplexity("中".repeat(2_667)), 3.5);
});

test("tool count has base/current/above-current bands", () => {
  for (const toolCount of [0, 1, 4, 8]) assert.equal(calculateComplexity("", { toolCount }), 3);
  for (const toolCount of [9, 15, 16]) assert.equal(calculateComplexity("", { toolCount }), 3.3);
  for (const toolCount of [17, 100]) assert.equal(calculateComplexity("", { toolCount }), 3.6);
  assert.equal(
    classifyComplexity(calculateComplexity("Inspect source", { toolCount: 16 })),
    "simple",
  );
});

test("simple includes 3.3 and hard excludes 7", () => {
  for (const score of [0, 1, 2, 3, 3.3]) assert.equal(classifyComplexity(score), "simple");
  for (const score of [3.3001, 4, 5, 6.99, 7]) assert.equal(classifyComplexity(score), "medium");
  for (const score of [7.0001, 8, 10]) assert.equal(classifyComplexity(score), "hard");
});

test("only hard may retain spawn, without mutating or expanding the tool set", () => {
  const tools = ["read", SPAWN_TOOL, "write", "bash"];
  assert.deepEqual(gateChildTools("medium", tools), ["read", "write", "bash"]);
  assert.deepEqual(tools, ["read", SPAWN_TOOL, "write", "bash"]);
  assert.deepEqual(gateChildTools("simple", tools), ["read", "write", "bash"]);
  assert.deepEqual(gateChildTools("unknown", tools), ["read", "write", "bash"]);
  assert.deepEqual(gateChildTools("hard", ["read"]), ["read"]);
  assert.deepEqual(gateChildTools("hard", tools), tools);
  assert.deepEqual(gateChildTools("medium", []), []);
  assert.deepEqual(gateChildTools("medium", [SPAWN_TOOL]), []);
});
