import assert from "node:assert/strict";
import { test } from "node:test";
import { createLiveProgress, type LiveProgressResult } from "../../src/tui/live.ts";
import { LiveFormatter } from "../../src/runtime/events.ts";
import type { Receipt } from "../../src/runtime/records.ts";

const receipt: Receipt = {
  agent_run_id: "parent",
  sub_agent_run_id: "child",
  start_time: "now",
  status: "running",
  fallback_to_main_loop: false,
};

test("live formatting shows text and tool activity without duplicate final text", () => {
  const formatter = new LiveFormatter();
  const delta = (text: string) =>
    formatter.format({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: text },
    });
  const first = delta("Inspecting ") + delta("source.");
  assert.match(first, /Inspecting source\./);
  assert.equal(
    formatter.format({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "Inspecting source." }] },
    }),
    "\n",
  );
  assert.match(
    formatter.format({
      type: "tool_execution_start",
      toolName: "read",
      args: { path: "src/index.ts" },
    }),
    /tool read.*src\/index.ts/,
  );
  assert.match(
    formatter.format({
      type: "tool_execution_update",
      toolName: "read",
      toolCallId: "t",
      partialResult: { content: [{ type: "text", text: "partial output" }] },
    }),
    /partial output/,
  );
  assert.equal(
    formatter.format({
      type: "tool_execution_end",
      toolName: "read",
      toolCallId: "t",
      result: { content: [{ type: "text", text: "partial output" }] },
    }),
    "",
  );
  assert.equal(
    formatter.format({
      type: "tool_execution_update",
      toolName: "darknavstar-spawn-model-pool",
      partialResult: { content: [{ type: "text", text: "already relayed" }] },
    }),
    "",
  );
  assert.equal(
    formatter.format({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "thoughts" },
    }),
    "",
  );
});

test("turn buffers group interleaved runs, preserve snapshots and bound retained text", () => {
  const updates: LiveProgressResult[] = [];
  const relayed: unknown[] = [];
  const progress = createLiveProgress(
    (value) => updates.push(value),
    (value) => relayed.push(value),
    20,
  );
  progress.onProgress(receipt);
  progress.onActivity({ runId: "child", turn: 1, text: "abc" });
  const snapshot = updates.at(-1)!.details.turns;
  progress.onActivity({ runId: "descendant", turn: 1, text: "def" });
  progress.onActivity({ runId: "child", turn: 1, text: "ghi" });
  assert.deepEqual(snapshot, [{ runId: "child", turn: 1, text: "abc" }]);
  assert.deepEqual(updates.at(-1)!.details.turns, [
    { runId: "child", turn: 1, text: "abcghi" },
    { runId: "descendant", turn: 1, text: "def" },
  ]);
  assert.deepEqual(relayed[1], { runId: "descendant", turn: 1, text: "def" });
  progress.onActivity({ runId: "child", turn: 2, text: "x".repeat(30) });
  assert.deepEqual(updates.at(-1)!.details.turns, [
    { runId: "child", turn: 1, text: "abcghi" },
    { runId: "descendant", turn: 1, text: "def" },
    { runId: "child", turn: 2, text: "x".repeat(20), truncated: true },
  ]);
  assert.equal(updates.at(-1)!.details.truncated, true);
});

test("large output and more than 200 turns never evict earlier boxes", () => {
  let latest: LiveProgressResult | undefined;
  const progress = createLiveProgress(
    (value) => {
      latest = value;
    },
    undefined,
    20,
  );
  progress.onProgress(receipt);
  for (let turn = 1; turn <= 205; turn++) {
    progress.onActivity({ runId: "child", turn, text: "x".repeat(100) + `\ntail-${turn}` });
  }
  assert.equal(latest!.details.turns.length, 205);
  assert.match(latest!.details.turns[0].text, /tail-1$/);
  progress.onActivity({ runId: "child", turn: 1, text: "\nnewest" });
  assert.match(latest!.details.turns[0].text, /tail-1\nnewest$/);
  assert.ok(latest!.details.turns.every((turn) => turn.text.length === 20 && turn.truncated));
});

test("live progress isolates parallel calls, labels descendants, and bounds/sanitizes output", () => {
  const updates: LiveProgressResult[] = [];
  const otherUpdates: LiveProgressResult[] = [];
  const relayed: unknown[] = [];
  const first = createLiveProgress(
    (value) => updates.push(value),
    (value) => relayed.push(value),
    80,
  );
  const second = createLiveProgress((value) => otherUpdates.push(value));
  first.onProgress(receipt);
  second.onProgress({ ...receipt, sub_agent_run_id: "other" });
  first.onActivity({ runId: "grandchild", text: "\x1b[2Jvisible\x00" });
  assert.match(updates.at(-1)!.details.live, /\[grandchild\]/);
  assert.match(updates.at(-1)!.details.live, /visible/);
  assert.doesNotMatch(updates.at(-1)!.details.live, /[\x00\x1b]/);
  assert.deepEqual(relayed, [{ runId: "grandchild", text: "visible" }]);
  assert.equal(otherUpdates.at(-1)!.details.live, "");
  first.onActivity({ runId: "grandchild", text: "x".repeat(200) });
  first.onProgress({ ...receipt, status: "success" });
  assert.match(updates.at(-1)!.details.live, /Earlier live output omitted/);
  assert.ok(updates.at(-1)!.details.live.length < 160);
  assert.equal(updates.at(-1)!.details.receipt.status, "success");
});
