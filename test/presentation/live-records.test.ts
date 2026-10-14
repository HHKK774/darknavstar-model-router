import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { RecordStore } from "../../src/runtime/records.ts";
import { createRecordedTurnLoader } from "../../src/tui/live-records.ts";
import { renderLiveTurns } from "../../src/tui/live-view.ts";

const assistant = (text: string) => ({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text }] },
});
const result = (text: string) => ({
  type: "tool_execution_end",
  toolName: "read",
  toolCallId: "t",
  result: { content: [{ type: "text", text }] },
});

test("lazy replay supports marked and legacy turns, refreshes disk changes and handles missing records", (t) => {
  const base = mkdtempSync(join(tmpdir(), "router-live-records-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const store = new RecordStore(base, "child", "session", 1, "parent");
  store.appendEvent({ type: "turn_start" });
  store.appendEvent(assistant("first"));
  store.appendEvent({
    type: "tool_execution_start",
    toolName: "read",
    toolCallId: "t",
    args: { path: "example.ts", extra: "x".repeat(10000) },
  });
  store.appendEvent(result("FULL_PRIVATE_OUTPUT"));
  store.appendEvent({ type: "turn_end" });
  store.appendEvent({ type: "turn_start" });
  store.appendEvent(assistant("second"));
  const load = createRecordedTurnLoader(base);
  assert.match(load("child", 1)!.text, /FULL_PRIVATE_OUTPUT/);
  assert.equal(load("child", 1)!.complete, true);
  const tool = load("child", 1)!.actions!.find((action) => action.id === "t")!;
  assert.equal(tool.status, "success");
  assert.match(tool.args!, /example.ts/);
  assert.ok(tool.args!.length > 10000);
  assert.match(tool.text, /FULL_PRIVATE_OUTPUT/);
  assert.equal(load("child", 2)!.complete, false);
  store.appendEvent(result("NEW_DISK_OUTPUT"));
  store.appendEvent({ type: "turn_end" });
  assert.match(load("child", 2)!.text, /NEW_DISK_OUTPUT/);
  assert.equal(load("child", 2)!.complete, true);
  const legacy = new RecordStore(base, "legacy", "legacy-session", 1, "parent");
  legacy.appendEvent(assistant("old first"));
  legacy.appendEvent(result("old result"));
  legacy.appendEvent(assistant("old second"));
  assert.match(load("legacy", 1)!.text, /old result/);
  assert.match(load("legacy", 2)!.text, /old second/);
  assert.equal(load("child", 3), undefined);
  assert.equal(load("missing", 1), undefined);
  assert.equal(load("../escape", 1), undefined);
  writeFileSync(store.file, "invalid JSON");
  assert.equal(load("child", 1), undefined);
});

test("expansion loads truncated turns from disk without changing previews or model results", (t) => {
  const home = mkdtempSync(join(tmpdir(), "router-live-expand-"));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  });
  initTheme("dark", false);
  const theme = { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s } as Theme;
  const store = new RecordStore(join(home, ".pi"), "child", "session", 1, "parent");
  store.appendEvent({ type: "turn_start" });
  store.appendEvent(assistant("preview"));
  store.appendEvent(result("FULL_PRIVATE_OUTPUT"));
  store.appendEvent({ type: "turn_end" });
  const turns = [
    { runId: "child", turn: 1, text: "preview", truncated: true },
    { runId: "child", turn: 2, text: "not saved", truncated: true },
  ];
  const render = (expanded: boolean) =>
    renderLiveTurns(turns, "", "summary", true, expanded, theme).render(120).join("\n");
  assert.doesNotMatch(render(false), /FULL_PRIVATE_OUTPUT/);
  assert.match(render(true), /FULL_PRIVATE_OUTPUT/);
  assert.match(render(true), /unavailable or not yet saved/);
  assert.doesNotMatch(render(false), /FULL_PRIVATE_OUTPUT/);
  assert.doesNotMatch(JSON.stringify(turns), /FULL_PRIVATE_OUTPUT/);
  assert.match(render(true), /Turn 1/);
  assert.match(render(true), /Turn 2/);
});

test("collapsed turns show the newest ten lines; expansion preserves chronological output", () => {
  initTheme("dark", false);
  const theme = { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s } as Theme;
  const text = Array.from({ length: 15 }, (_, i) => `line-${String(i + 1).padStart(2, "0")}`).join(
    "\n",
  );
  const turns = [{ runId: "child", turn: 1, text }];
  const render = (expanded: boolean) =>
    renderLiveTurns(turns, "", undefined, false, expanded, theme).render(120).join("\n");
  const collapsed = render(false);
  assert.doesNotMatch(collapsed, /line-01|line-05/);
  assert.match(collapsed, /line-06/);
  assert.match(collapsed, /line-15/);
  assert.ok(collapsed.indexOf("5 earlier lines") < collapsed.indexOf("line-06"));
  const expanded = render(true);
  assert.match(expanded, /line-01/);
  assert.ok(expanded.indexOf("line-01") < expanded.indexOf("line-15"));
  const summary = renderLiveTurns([], "", text, false, false, theme).render(120).join("\n");
  assert.doesNotMatch(summary, /line-01/);
  assert.match(summary, /line-15/);
});
