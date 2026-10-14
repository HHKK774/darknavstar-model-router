import assert from "node:assert/strict";
import { test } from "node:test";
import { extractComplexityFeatures, hasNewImage } from "../../src/runtime/features.ts";

test("feature extraction counts keyword categories, not repeated words", () => {
  const f = extractComplexityFeatures(
    "DEBUG debugging concurrency CONCURRENT rename typos linting",
  );
  assert.deepEqual(f.complexityKeywords, ["debug", "concurrency"]);
  assert.deepEqual(f.trivialityKeywords, ["rename", "typo", "lint"]);
  assert.deepEqual(extractComplexityFeatures("debuggerx predesign whysoever").complexityKeywords, [
    "debug",
  ]);
  assert.equal(extractComplexityFeatures("中🙂").taskBytes, 7);
  assert.equal(extractComplexityFeatures("```unclosed").codeBlocks, 0);
  assert.equal(extractComplexityFeatures("```one``` ```two```").codeBlocks, 2);
  assert.deepEqual(
    Object.keys(f).sort(),
    [
      "taskBytes",
      "toolCount",
      "lastSpawnFailed",
      "hasNewImage",
      "codeBlocks",
      "complexityKeywords",
      "trivialityKeywords",
    ].sort(),
  );
});

test("new images belong only to the user tail preceding the current spawn turn", () => {
  const image = { role: "user", content: [{ type: "image", data: "image" }] };
  const text = { role: "user", content: [{ type: "text", text: "image.png" }] };
  const assistant = { role: "assistant", content: [] };
  const tool = { role: "toolResult", content: [{ type: "image" }] };
  assert.equal(hasNewImage([]), false);
  assert.equal(hasNewImage([image]), true);
  assert.equal(hasNewImage([image, text, assistant]), true);
  assert.equal(hasNewImage([image, assistant, text, assistant]), false);
  assert.equal(hasNewImage([image, assistant, tool, assistant]), false);
  assert.equal(hasNewImage([text, assistant]), false);
  assert.equal(hasNewImage([{ role: "user", content: "image" }]), false);
});
