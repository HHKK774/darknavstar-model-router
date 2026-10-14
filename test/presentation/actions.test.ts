import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { theme as activeTheme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { Box, visibleWidth } from "@earendil-works/pi-tui";
import { LiveFormatter, parseLiveAction } from "../../src/runtime/events.ts";
import { createLiveProgress, type LiveProgressResult } from "../../src/tui/live.ts";
import { renderLiveTurns } from "../../src/tui/live-view.ts";
import { actionTitle } from "../../src/tui/action-title.ts";

function setup(cap = 8192) {
  const updates: LiveProgressResult[] = [];
  const progress = createLiveProgress((value) => updates.push(value), undefined, cap);
  progress.onProgress({
    agent_run_id: "parent",
    sub_agent_run_id: "child",
    start_time: "now",
    status: "running",
    fallback_to_main_loop: false,
  });
  const formatter = new LiveFormatter();
  const send = (event: Record<string, unknown>) => {
    const text = formatter.format(event);
    progress.onActivity({ runId: "child", turn: 1, text, action: formatter.action(event, text) });
  };
  return { send, updates, turns: () => updates.at(-1)!.details.turns };
}
const start = (id: string, command: string) => ({
  type: "tool_execution_start",
  toolCallId: id,
  toolName: "bash",
  args: { command },
});
const output = (id: string, text: string, end = false, isError = false) => ({
  type: end ? "tool_execution_end" : "tool_execution_update",
  toolCallId: id,
  toolName: "bash",
  isError,
  [end ? "result" : "partialResult"]: { content: [{ type: "text", text }] },
});

test("assistant preview keeps rolling after its character budget is exhausted", () => {
  const h = setup(80);
  const send = (text: string) =>
    h.send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
  send("OLD_HEAD " + "x".repeat(120));
  send(" NEW_TAIL");
  const action = h.turns()[0].actions![0];
  assert.equal(action.kind, "assistant");
  assert.equal(action.text.length, 80);
  assert.equal(action.truncated, true);
  assert.doesNotMatch(action.text, /OLD_HEAD/);
  assert.match(action.text, /NEW_TAIL$/);
});

test("parallel calls retain independent headers and settle even when final output has no delta", () => {
  const h = setup(80);
  h.send({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "Check both commands." },
  });
  h.send(start("a", "FIRST_COMMAND"));
  h.send(start("b", "SECOND_COMMAND"));
  const snapshot = h.turns();
  h.send(output("b", "B".repeat(200)));
  h.send(output("a", "A".repeat(200)));
  h.send(output("a", "A".repeat(200), true));
  h.send(output("b", "B".repeat(200), true, true));
  const actions = h.turns()[0].actions!;
  assert.equal(actions.length, 3);
  assert.match(actions[0].text, /Check both/);
  assert.match(actions[1].args!, /FIRST_COMMAND/);
  assert.match(actions[2].args!, /SECOND_COMMAND/);
  assert.equal(actions[1].status, "success");
  assert.equal(actions[2].status, "error");
  assert.equal(actions[1].text.length, 80);
  assert.doesNotMatch(actions[1].text, /B/);
  assert.equal(snapshot[0].actions![1].status, "running");
  assert.equal(snapshot[0].actions![1].text, "");
  assert.ok(h.turns()[0].truncated);
});

test("action headers remain above output tails and unfinished calls are not shown as running after exit", () => {
  initTheme("dark", false);
  const theme = {
    fg: (_: string, text: string) => text,
    bg: (_: string, text: string) => text,
  } as Theme;
  const h = setup();
  h.send(start("a", "python3 example.py --help"));
  h.send(output("a", Array.from({ length: 30 }, (_, n) => `OUTPUT_${n}`).join("\n")));
  const render = (expanded: boolean, status = "running", width = 100) =>
    renderLiveTurns(h.turns(), status, undefined, false, expanded, theme).render(width).join("\n");
  const text = render(false);
  assert.match(text, /python3 example.py --help/);
  assert.match(text, /\$ python3 example.py --help · running/);
  assert.doesNotMatch(text, /running · a/);
  assert.match(text, /OUTPUT_29/);
  assert.doesNotMatch(text, /OUTPUT_0\b/);
  assert.ok(text.indexOf("python3") < text.indexOf("OUTPUT_29"));
  assert.match(render(true), /OUTPUT_0\b/);
  assert.match(render(false, ""), /unfinished/);
  assert.doesNotThrow(() => render(false, "running", 24));
});

test("turn titles and actions share a box while startup is unboxed progress without a heading", () => {
  initTheme("dark", false);
  const backgroundLines: string[] = [];
  const theme = {
    fg: (_: string, text: string) => text,
    bg: (_: string, text: string) => {
      backgroundLines.push(text);
      return text;
    },
  } as Theme;
  const h = setup();
  h.send(start("a", "FIRST_COMMAND"));
  h.send(output("a", "FIRST_RESULT", true));
  h.send(start("b", "SECOND_COMMAND"));
  const turns = [
    {
      runId: "child",
      turn: 0,
      text: "Starting child process…\nInitialization complete; agent started.",
    },
    ...h.turns(),
  ];
  for (const expanded of [false, true]) {
    backgroundLines.length = 0;
    const lines = renderLiveTurns(turns, "running", undefined, false, expanded, theme).render(100);
    assert.doesNotMatch(lines.join("\n"), /Startup/);
    assert.match(lines.join("\n"), /Starting child process/);
    assert.ok(!backgroundLines.some((line) => line.includes("Starting child process")));
    assert.ok(backgroundLines.some((line) => line.includes("Turn 1")));
    assert.ok(backgroundLines.some((line) => line.includes("FIRST_COMMAND")));
    assert.ok(backgroundLines.some((line) => line.includes("SECOND_COMMAND")));
    const from = lines.findIndex((line) => line.includes("Turn 1"));
    const to = lines.findIndex((line) => line.includes("SECOND_COMMAND"));
    // Even the spacing between action sections belongs to the enclosing turn background.
    assert.ok(
      lines.slice(from, to + 1).every((line) => backgroundLines.includes(line.slice(1, -1))),
    );
  }
});

test("each turn has its own visible frame inside the outer tool panel, including legacy turns", () => {
  const h = setup();
  h.send(start("a", "echo 中文🙂"));
  h.send(output("a", "first output", true));
  const turns = [
    { runId: "child", turn: 0, text: "Starting child process…" },
    ...h.turns(),
    { runId: "child", turn: 2, text: "legacy output 中文🙂" },
  ];
  for (const name of ["dark", "light"]) {
    initTheme(name, false);
    for (const expanded of [false, true]) {
      const component = renderLiveTurns(turns, "running", undefined, false, expanded, activeTheme);
      const outer = new Box(1, 1, (line) => activeTheme.bg("toolPendingBg", line));
      outer.addChild(component);
      const lines = outer.render(80);
      assert.equal(lines.filter((line) => line.includes("╭")).length, 2);
      assert.equal(lines.filter((line) => line.includes("╰")).length, 2);
      for (const title of ["Turn 1", "Turn 2"]) {
        const index = lines.findIndex((line) => line.includes(title));
        assert.ok(lines[index - 1].includes("╭"));
        assert.ok(lines[index].includes("│"));
      }
      assert.ok(!lines.find((line) => line.includes("Starting child process"))!.includes("│"));
      for (const width of [0, 1, 2, 3, 4, 12, 40, 100]) {
        component.invalidate();
        assert.ok(
          component.render(width).every((line) => visibleWidth(line) <= width),
          `${name}: width ${width}`,
        );
      }
    }
  }
});

test("oversized argument headers are shortened separately from output and expand independently", () => {
  initTheme("dark", false);
  const theme = {
    fg: (_: string, text: string) => text,
    bg: (_: string, text: string) => text,
  } as Theme;
  const h = setup();
  h.send(start("a", "HEAD_" + "x".repeat(900) + "_END"));
  h.send(output("a", "tool output"));
  const render = (expanded: boolean) =>
    renderLiveTurns(h.turns(), "running", undefined, false, expanded, theme).render(100).join("\n");
  assert.match(render(false), /HEAD_/);
  assert.match(render(false), /Action shortened/);
  assert.doesNotMatch(render(false), /_END/);
  assert.match(render(true), /_END/);
  assert.match(render(false), /tool output/);
});

test("action titles show paths, inclusive read ranges and commands, with safe fallback", () => {
  const title = (name: string, args: unknown) =>
    actionTitle({ id: "id", kind: "tool", title: name, args: JSON.stringify(args), text: "" });
  assert.equal(
    title("read", { path: "test.ts", offset: 355, limit: 36 }).title,
    "read test.ts:355-390",
  );
  assert.equal(title("read", { path: "test.ts", limit: 10 }).title, "read test.ts:1-10");
  assert.equal(title("read", { path: "test.ts", offset: 20 }).title, "read test.ts:20");
  assert.equal(title("edit", { path: "live-view.ts" }).title, "edit live-view.ts");
  assert.equal(title("write", { path: "new.ts", content: "code" }).title, "write new.ts");
  assert.equal(
    title("bash", { command: "npm run check && npm test" }).title,
    "$ npm run check && npm test",
  );
  assert.ok(title("custom", { query: "anything" }).showArgs);
  assert.ok(
    actionTitle({ id: "id", kind: "tool", title: "read", args: "{broken", text: "" }).showArgs,
  );
});

test("write target survives argument truncation even when path follows large content", () => {
  const h = setup(80);
  h.send({
    type: "tool_execution_start",
    toolCallId: "write-id",
    toolName: "write",
    args: { content: "x".repeat(10000), path: "src/new.ts" },
  });
  const action = h.turns()[0].actions![0];
  assert.ok(action.truncated);
  assert.equal(actionTitle(action).title, "write src/new.ts");
});

test("structured relay validates metadata and never includes thinking or descendant spawn previews", () => {
  const formatter = new LiveFormatter();
  for (const event of [
    { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "SECRET" } },
    {
      type: "tool_execution_update",
      toolName: "darknavstar-spawn-model-pool",
      toolCallId: "a",
      partialResult: { content: [{ type: "text", text: "DESCENDANT" }] },
    },
  ]) {
    assert.equal(formatter.action(event, formatter.format(event)), undefined);
  }
  assert.equal(parseLiveAction({ id: "a", kind: "tool", text: "", args: {} }), undefined);
  const event = start("a", "cmd");
  const action = formatter.action(event, formatter.format(event))!;
  assert.equal(parseLiveAction(action)?.args, action.args);
});
