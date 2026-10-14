import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { readableStructuredText } from "../../src/tui/structured-text.ts";
import { renderLiveTurns } from "../../src/tui/live-view.ts";

test("JSON and mixed JSONL decode string newlines without rewriting literal escapes", () => {
  const code = 'text(await tools.bash({command:"pwd"}));\ntext("done");';
  assert.equal(
    readableStructuredText(JSON.stringify({ code })),
    `code:\n  ${code.replaceAll("\n", "\n  ")}`,
  );
  const input =
    "Script completed\n" +
    JSON.stringify({ output: "first\nsecond", exit_code: 0 }) +
    "\n" +
    JSON.stringify({ path: "a.py", content: "import sys\nprint(sys.version)" });
  const output = readableStructuredText(input);
  assert.match(output, /Script completed\noutput:\n  first\n  second\nexit_code: 0/);
  assert.match(output, /path: a.py\ncontent:\n  import sys\n  print/);
  for (const plain of ["literal \\n text", '{"output":"incomplete', "C:\\new\\file"]) {
    assert.equal(readableStructuredText(plain), plain);
  }
  assert.equal(
    readableStructuredText(JSON.stringify({ code: 'print("\\n")' })),
    'code: print("\\n")',
  );
  assert.match(readableStructuredText('[{"content":"a\\nb"}]'), /content:\n    a\n    b/);
});

test("single-line JSON tool output and Result keep only the last ten wrapped rows", () => {
  initTheme("dark", false);
  const theme = {
    fg: (_: string, text: string) => text,
    bg: (_: string, text: string) => text,
  } as Theme;
  const text = JSON.stringify({ output: "HEAD_MARK " + "word ".repeat(600) + " TAIL_MARK" });
  const turns = [
    {
      runId: "child",
      turn: 1,
      text: "",
      actions: [
        {
          id: "call",
          kind: "tool" as "tool" | "assistant",
          title: "bash",
          text,
          status: "success" as const,
        },
      ],
    },
  ];
  for (const width of [50, 100]) {
    for (const section of ["tool", "assistant", "result"] as const) {
      const resultOnly = section === "result";
      turns[0].actions[0].kind = section === "assistant" ? "assistant" : "tool";
      const render = (expanded: boolean) =>
        renderLiveTurns(
          resultOnly ? [] : turns,
          "",
          resultOnly ? text : undefined,
          false,
          expanded,
          theme,
        ).render(width);
      const collapsed = render(false);
      assert.doesNotMatch(collapsed.join("\n"), /HEAD_MARK/);
      assert.match(collapsed.join("\n"), /TAIL_MARK/);
      const hint = collapsed.findIndex((line) => line.includes("earlier lines"));
      const bottom = collapsed.findIndex((line) => line.includes("╰"));
      assert.equal(bottom - hint - 1, 10);
      assert.match(render(true).join("\n"), /HEAD_MARK/);
      assert.match(render(true).join("\n"), /TAIL_MARK/);
    }
  }
});

test("codemode renders readable arguments and output while preserving original actions", () => {
  initTheme("dark", false);
  const theme = {
    fg: (_: string, text: string) => text,
    bg: (_: string, text: string) => text,
  } as Theme;
  const turns = [
    {
      runId: "child",
      turn: 1,
      text: "",
      actions: [
        {
          id: "call",
          kind: "tool" as const,
          title: "codemode",
          status: "success" as const,
          args: JSON.stringify({ code: "first();\nsecond();" }),
          text: "Script completed\n" + JSON.stringify({ output: "one\ntwo", exit_code: 0 }),
        },
      ],
    },
  ];
  const original = JSON.stringify(turns);
  for (const expanded of [false, true]) {
    const output = renderLiveTurns(turns, "", undefined, false, expanded, theme)
      .render(100)
      .join("\n");
    assert.match(output, /first\(\);[^\n]*\n[^\n]*second\(\);/);
    assert.match(output, /one[^\n]*\n[^\n]*two/);
    assert.doesNotMatch(output, /\\n/);
  }
  assert.equal(JSON.stringify(turns), original);
});
