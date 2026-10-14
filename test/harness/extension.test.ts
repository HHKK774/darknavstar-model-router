import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import modelRouter from "../../src/harness/extension.ts";
import { configuredInstructions, ROUTING_REMINDER } from "../../src/harness/prompts.ts";
import { SPAWN_TOOL, parseRouterConfig } from "../../src/config.ts";
import { CHILD_ENV, type ChildConfig } from "../../src/runtime/identity.ts";
import { readNode, RecordStore, type RunEntry } from "../../src/runtime/records.ts";
import { createLiveProgress } from "../../src/tui/live.ts";

const example = JSON.parse(
  readFileSync(new URL("../../examples/model-router.json", import.meta.url), "utf8"),
);
const testConfig = Object.fromEntries(
  Object.entries(example).map(([category, config]) => [
    category,
    {
      ...(config as Record<string, unknown>),
      "read-only": { simple: { model_alias: "test/model", censored: true } },
    },
  ]),
);
const {
  router_category_prompt: CATEGORY_INSTRUCTIONS,
  router_delegation_prompt: DELEGATION_INSTRUCTIONS,
} = configuredInstructions(parseRouterConfig(testConfig));

test("trajectory storage stays global even when cwd is the trajectory directory", (t) => {
  const h = harness(t);
  const base = join(h.ctx.cwd, ".pi");
  const dir = join(base, "model-router-trajectory");
  h.ctx.cwd = dir;
  h.fire("session_start");
  const identity = h.entries.find(
    (entry: any) => entry.customType === "model-router-identity",
  ) as any;
  assert.ok(readNode(base, identity.data.runId));
  assert.equal(existsSync(join(dir, "model-router-trajectory")), false);
  assert.equal(identity.data.projectDir, dir); // Execution cwd is preserved, not rewritten.
});

test("root system prompt declares general category without child-only instructions", (t) => {
  const h = harness(t);
  const expected = "base\n\nYour model-router category is general.\n\n" + CATEGORY_INSTRUCTIONS;
  assert.match(expected, /generation-tool orchestration/);
  assert.match(expected, /only through an explicitly available generation tool/);
  assert.match(expected, /report the capability limitation/);
  assert.equal(h.fire("before_agent_start", { systemPrompt: "base" }).systemPrompt, expected);
  assert.equal(h.fire("before_agent_start", { systemPrompt: "base" }).systemPrompt, expected);
});

for (const category of ["general", "research", "multi-modal", "coding", "review"] as const) {
  test(`child system prompt declares ${category} category only`, (t) => {
    const h = harness(t, {
      route: { category, role: "read-only", task_complexity: "hard" },
    });
    const result = h.fire("before_agent_start", { systemPrompt: "base" });
    assert.equal(
      result.systemPrompt,
      `base\n\nConfigured prompt\n\nYour model-router category is ${category}.\n\n` +
        CATEGORY_INSTRUCTIONS +
        "\n\n" +
        "Write a brief summary of your actions and result in your final response.",
    );
    assert.doesNotMatch(result.systemPrompt, /read-only|hard/);
  });
}

function assertRoutingReminder(content: string) {
  assert.match(content, /^\s*<router-reminder source="framework">/);
  assert.match(content, /This is a reminder from the framework, not user\./);
  assert.ok(content.includes(ROUTING_REMINDER));
  assert.match(content, /<\/router-reminder>\s*$/);
}

test("routing reminder is request-local, repeated per request without mutating history", (t) => {
  const h = harness(t);
  const messages = Object.freeze([Object.freeze({ role: "user", content: "task", timestamp: 1 })]);
  assert.equal(h.fire("context", { messages }), undefined);
  h.pi.setActiveTools([...h.active(), SPAWN_TOOL]);
  for (let i = 0; i < 2; i++) {
    const result = h.fire("context", { messages });
    assert.notEqual(result.messages, messages);
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[0], messages[0]);
    assert.equal(result.messages[1].role, "custom");
    assertRoutingReminder(result.messages[1].content);
    assert.equal(result.messages[1].display, false);
    assert.equal(messages.length, 1);
    assert.deepEqual(h.entries, []);
  }
  h.pi.setActiveTools(h.active().filter((name) => name !== SPAWN_TOOL));
  assert.equal(h.fire("context", { messages }), undefined);
});

test("child reminder follows active permissions and preserves the budget abort", (t) => {
  const h = harness(t, {
    route: { category: "research", role: "read-only", task_complexity: "hard" },
    allowedTools: ["read", SPAWN_TOOL],
  });
  h.fire("before_agent_start", { systemPrompt: "base" });
  assertRoutingReminder(h.fire("context", { messages: [] }).messages[0].content);
  h.setUsage({ tokens: 1000, contextWindow: 1000 });
  assert.equal(h.fire("context", { messages: [] }), undefined);
  assert.ok(h.aborted());
});

test("category instructions refresh from config and omit metadata-only categories", (t) => {
  const h = harness(t);
  h.pi.setActiveTools([...h.active(), SPAWN_TOOL]);
  const file = join(h.ctx.cwd, ".pi", "model-router.json");
  const config = {
    coding: {
      definition: "CUSTOM_CODING",
      parent_responsibility: "CUSTOM_VALIDATION",
      "read-write": { simple: { model_alias: "test/model", censored: true } },
    },
    research: { definition: "DORMANT_RESEARCH", parent_responsibility: "DORMANT_CHECK" },
  };
  writeFileSync(file, JSON.stringify(config));
  const first = h.fire("before_agent_start", { systemPrompt: "base" }).systemPrompt;
  assert.match(first, /CUSTOM_CODING/);
  assert.match(first, /CUSTOM_VALIDATION/);
  assert.doesNotMatch(first, /DORMANT_/);
  config.coding.definition = "UPDATED_CODING";
  writeFileSync(file, JSON.stringify(config));
  const second = h.fire("before_agent_start", { systemPrompt: "base" }).systemPrompt;
  assert.match(second, /UPDATED_CODING/);
  assert.doesNotMatch(second, /CUSTOM_CODING/);
});

test("root exposes interrupt command but children do not", (t) => {
  assert.ok(harness(t).commands.has("router-interrupt"));
  assert.ok(!harness(t, {}).commands.has("router-interrupt"));
});

test("root delegation rules follow actual active tools on every turn", (t) => {
  const h = harness(t);
  const prompt = () => h.fire("before_agent_start", { systemPrompt: "base" }).systemPrompt;
  assert.ok(h.tools.has(SPAWN_TOOL)); // Registration alone does not grant delegation.
  assert.equal(h.tools.get(SPAWN_TOOL).parameters.properties.category.enum, undefined);
  assert.ok(!prompt().includes(DELEGATION_INSTRUCTIONS));
  h.pi.setActiveTools([...h.active(), SPAWN_TOOL]);
  const enabled = prompt();
  assert.ok(enabled.includes(DELEGATION_INSTRUCTIONS));
  assert.equal(enabled.split(DELEGATION_INSTRUCTIONS).length, 2);
  assert.equal(enabled.split(ROUTING_REMINDER).length, 2);
  assert.ok(!enabled.includes("Write a brief summary"));
  assert.match(enabled, /new research task for diagnosis/);
  assert.match(enabled, /run relevant unit tests/);
  assert.match(enabled, /end-to-end tests defined by the task/);
  assert.doesNotMatch(enabled, /model capability and execution speed/);
  h.pi.setActiveTools(h.active().filter((name) => name !== SPAWN_TOOL));
  assert.ok(!prompt().includes(DELEGATION_INSTRUCTIONS));
});

test("child delegation rules use the resolved allow list, not merely its complexity", (t) => {
  const h = harness(t, {
    route: { category: "research", role: "read-only", task_complexity: "hard" },
    allowedTools: ["read", SPAWN_TOOL],
  });
  const result = h.fire("before_agent_start", { systemPrompt: "base" });
  assert.ok(result.systemPrompt.includes(DELEGATION_INSTRUCTIONS));
  assert.match(result.systemPrompt, /Your model-router category is research/);
  assert.match(result.systemPrompt, /Write a brief summary/);
});

type Handler = (event: any, ctx: ExtensionContext) => any;
function harness(t: TestContext, child?: Partial<ChildConfig>) {
  const cwd = mkdtempSync(join(tmpdir(), "router-extension-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const savedEnv = { ...process.env };
  t.after(() => {
    for (const key of [
      "HOME",
      CHILD_ENV,
      "PI_MODEL_ROUTER_RUN_ID",
      "PI_MODEL_ROUTER_PARENT_RUN_ID",
    ]) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });
  process.env.HOME = cwd;
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "model-router.json"), JSON.stringify(testConfig));
  if (child) {
    const config: ChildConfig = {
      runId: "child",
      parentRunId: "parent",
      depth: 1,
      projectDir: cwd,
      route: { category: "coding", role: "read-only", task_complexity: "medium" },
      modelConfig: { model_alias: "test/model", censored: true, prompt: "Configured prompt" },
      allowedTools: ["read", "write", "bash"],
      ...child,
    };
    const file = join(cwd, "child.json");
    writeFileSync(file, JSON.stringify(config));
    process.env[CHILD_ENV] = file;
    process.env.PI_MODEL_ROUTER_RUN_ID = config.runId;
    process.env.PI_MODEL_ROUTER_PARENT_RUN_ID = config.parentRunId;
  } else {
    delete process.env[CHILD_ENV];
  }
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const entries: unknown[] = [];
  let active = ["read", "write", "edit", "bash"];
  let sessionId = "session-a";
  let aborted = false;
  let usage: { tokens: number | null; contextWindow: number } | undefined;
  const pi = {
    on: (event: string, handler: Handler) => {
      const previous = handlers.get(event);
      handlers.set(
        event,
        previous
          ? (value, ctx) => {
              const before = previous(value, ctx);
              const after = handler(value, ctx);
              return after === undefined ? before : after;
            }
          : handler,
      );
    },
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    appendEntry: (customType: string, data: unknown) =>
      entries.push({ type: "custom", customType, data }),
    getAllTools: () =>
      [...new Set(["read", "write", "edit", "bash", ...tools.keys()])].map((name) => ({ name })),
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names;
    },
    setModel: () => assert.fail("Router must not change the main model"),
    sendMessage: () => assert.fail("Router must not inject live updates into model context"),
    sendUserMessage: () => assert.fail("Router must not inject live updates into model context"),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    model: { provider: "test", id: "model", contextWindow: 1000 },
    signal: new AbortController().signal,
    abort: () => {
      aborted = true;
    },
    sessionManager: { getSessionId: () => sessionId, getEntries: () => entries },
    getContextUsage: () => usage,
  } as unknown as ExtensionContext;
  modelRouter(pi);
  return {
    pi,
    ctx,
    tools,
    entries,
    handlers,
    commands,
    active: () => active,
    aborted: () => aborted,
    setSession: (id: string) => {
      sessionId = id;
    },
    setUsage: (value: typeof usage) => {
      usage = value;
    },
    fire: (event: string, value = {}) => handlers.get(event)?.({ type: event, ...value }, ctx),
  };
}

test("root registers the agreed tools and keeps a stable run ID over agent starts/reload", (t) => {
  const h = harness(t);
  h.fire("session_start");
  h.fire("before_agent_start", { systemPrompt: "base" });
  h.fire("before_agent_start", { systemPrompt: "base" });
  assert.equal(h.entries.length, 1);
  assert.deepEqual(
    [...h.tools.keys()],
    [
      "darknavstar-get-model-pool",
      "darknavstar-spawn-model-pool",
      "darknavstar-get-agent-run-records",
    ],
  );
  for (const name of h.tools.keys()) {
    assert.match(name, /^[a-zA-Z0-9_-]+$/, "Tool names must be OpenAI/Codex-compatible");
  }
  const poolTool = h.tools.get("darknavstar-get-model-pool");
  assert.deepEqual(poolTool.parameters.required ?? [], []);
  assert.ok(!Object.hasOwn(poolTool.parameters.properties, "action"));
  const first = (h.entries[0] as any).data;
  modelRouter(h.pi); // /reload creates a new extension instance against the same session.
  h.fire("session_start");
  assert.equal((h.entries.at(-1) as any).data.runId, first.runId);
  h.setSession("session-b");
  h.fire("session_start");
  assert.notEqual((h.entries.at(-1) as any).data.runId, first.runId);
});

test("child uses its identity, appends prompt, and honors explicit tools", (t) => {
  const h = harness(t, {});
  h.fire("session_start");
  assert.equal((h.entries[0] as any).data.runId, "child");
  const result = h.fire("before_agent_start", { systemPrompt: "base" });
  assert.deepEqual(h.active(), ["read", "write", "bash"]);
  assert.match(result.systemPrompt, /^base/);
  assert.match(result.systemPrompt, /Configured prompt/);
  assert.match(result.systemPrompt, /brief summary of your actions and result/);
  assert.equal(h.fire("tool_call", { toolName: "write" }), undefined);
  assert.equal(h.fire("tool_call", { toolName: "edit" }).block, true);
});

test("child waits for session-start tool registration before checking tools", async (t) => {
  const h = harness(t, { allowedTools: ["calculator"] });
  h.fire("session_start");
  assert.equal(h.aborted(), false);
  // A later session_start handler may register tools asynchronously.
  await Promise.resolve();
  h.tools.set("calculator", { name: "calculator" });
  const result = h.fire("before_agent_start", { systemPrompt: "base" });
  assert.match(result.systemPrompt, /brief summary/);
  assert.deepEqual(h.active(), ["calculator"]);
  assert.equal(h.aborted(), false);
});

test("child aborts before the provider request if a tool is genuinely missing", (t) => {
  const h = harness(t, { allowedTools: ["missing-tool"] });
  h.fire("session_start");
  assert.equal(h.aborted(), false);
  assert.equal(h.fire("before_agent_start", { systemPrompt: "base" }), undefined);
  assert.equal(h.aborted(), true);
});

test("child accepts an omitted prompt and still requests an actions/result summary", (t) => {
  const h = harness(t, { modelConfig: { model_alias: "test/model", censored: false } });
  h.fire("session_start");
  const result = h.fire("before_agent_start", { systemPrompt: "base" });
  assert.equal(
    result.systemPrompt,
    "base\n\nYour model-router category is coding.\n\n" +
      CATEGORY_INSTRUCTIONS +
      "\n\n" +
      "Write a brief summary of your actions and result in your final response.",
  );
});

test("spawn accepts category, role and task, not complexity", (t) => {
  const h = harness(t);
  const schema = h.tools.get("darknavstar-spawn-model-pool").parameters;
  assert.deepEqual(Object.keys(schema.properties).sort(), ["category", "role", "task"]);
  assert.deepEqual([...schema.required].sort(), ["category", "role", "task"]);
  assert.equal(schema.additionalProperties, false);
});

test("children uniformly activate and enforce the supplied allow list", (t) => {
  const h = harness(t, { depth: 1, allowedTools: ["read"] });
  h.fire("session_start");
  h.fire("before_agent_start", { systemPrompt: "base" });
  assert.deepEqual(h.active(), ["read"]);
  assert.equal(h.fire("tool_call", { toolName: "darknavstar-spawn-model-pool" }).block, true);
  for (const toolName of ["write", "bash", "unknown-tool"]) {
    assert.equal(h.fire("tool_call", { toolName }).block, true);
  }
  assert.equal(h.fire("tool_call", { toolName: "read" }), undefined);
});

test("leaf nodes enforce the dispatch-resolved allow list", (t) => {
  const h = harness(t, { depth: 4, allowedTools: ["read"] });
  h.fire("session_start");
  h.fire("before_agent_start", { systemPrompt: "base" });
  assert.deepEqual(h.active(), ["read"]);
  assert.equal(h.fire("tool_call", { toolName: "darknavstar-spawn-model-pool" }).block, true);
});

test("record list omits only detail; get returns the complete entry", async (t) => {
  const h = harness(t);
  h.fire("session_start");
  const store = new RecordStore(join(h.ctx.cwd, ".pi"), "parent", "parent-session", 0);
  const entry: RunEntry = {
    agent_run_id: "parent",
    sub_agent_run_id: "child-a",
    start_time: "now",
    status: "success",
    fallback_to_main_loop: false,
    task: "Inspect source",
    summary: "Inspected source; found one issue.",
    route: { category: "coding", role: "read-only", task_complexity: "medium" },
  };
  store.add(entry);
  const childStore = new RecordStore(
    join(h.ctx.cwd, ".pi"),
    "child-a",
    "child-session",
    1,
    "parent",
  );
  childStore.appendEvent({ tool: "read", output: "full source contents" });
  const completeEntry = { ...entry, detail: childStore.node.detail };
  assert.doesNotMatch(readFileSync(store.file, "utf8"), /full source contents/);
  store.add({
    ...entry,
    sub_agent_run_id: "child-b",
    status: "running",
    summary: "",
  });
  const tool = h.tools.get("darknavstar-get-agent-run-records");
  assert.ok(tool.parameters.required.includes("action"));
  assert.ok(tool.parameters.required.includes("agent_run_id"));
  assert.equal(tool.parameters.properties.sub_agent_run_id.type, "string");
  assert.ok(!Object.hasOwn(tool.parameters.properties, "trajectory"));
  const call = async (params: unknown) =>
    JSON.parse((await tool.execute("call", params, undefined, undefined, h.ctx)).content[0].text);
  const listed = await call({ action: "list", agent_run_id: "parent" });
  assert.deepEqual(
    listed,
    Object.values(store.node.entries).map(({ detail, ...rest }) => rest),
  );
  assert.equal(listed.length, 2);
  assert.ok(!Object.hasOwn(listed[0], "sub_agents"));
  assert.equal(listed[0].summary, entry.summary);
  const full = await call({
    action: "get",
    agent_run_id: "parent",
    sub_agent_run_id: "child-a",
  });
  assert.deepEqual(full, completeEntry);
  assert.deepEqual(full.detail, childStore.node.detail);
  await assert.rejects(
    () => call({ action: "get", agent_run_id: "parent" }),
    /nonempty sub_agent_run_id/,
  );
  await assert.rejects(
    () => call({ action: "list", agent_run_id: "parent", sub_agent_run_id: "child-a" }),
    /not sub_agent_run_id/,
  );
  await assert.rejects(
    () => call({ action: "get", agent_run_id: "parent", sub_agent_run_id: "grandchild" }),
    /not a direct child/,
  );
  const grandchild = {
    ...entry,
    agent_run_id: "child-a",
    sub_agent_run_id: "grandchild",
  };
  childStore.add(grandchild);
  assert.deepEqual(
    await call({ action: "get", agent_run_id: "child-a", sub_agent_run_id: "grandchild" }),
    { ...grandchild, detail: null },
  );
  let serialized = "";
  let offset: number | null = 0;
  while (offset !== null) {
    const page = await call({
      action: "get",
      agent_run_id: "parent",
      sub_agent_run_id: "child-a",
      offset,
      limit: 50,
    });
    serialized += page.json_chunk;
    offset = page.next_offset;
  }
  assert.deepEqual(JSON.parse(serialized), completeEntry);
});

test("child records its own events, not streamed descendant activity", (t) => {
  const h = harness(t, {});
  h.fire("session_start");
  h.fire("message_end", { message: { role: "assistant", content: "OWN_TEXT" } });
  h.fire("tool_execution_start", { toolName: "read", toolCallId: "t", args: {} });
  h.fire("tool_execution_end", { toolName: "read", result: { text: "OWN_TOOL_RESULT" } });
  h.fire("tool_execution_update", {
    toolName: "darknavstar-spawn-model-pool",
    partialResult: { content: [{ type: "text", text: "DESCENDANT_LIVE_TEXT" }] },
  });
  h.fire("tool_execution_end", {
    toolName: "darknavstar-get-agent-run-records",
    result: { content: [{ type: "text", text: "QUERIED_DESCENDANT_DETAIL" }] },
  });
  h.fire("message_end", {
    message: {
      role: "toolResult",
      toolName: "darknavstar-get-agent-run-records",
      content: [{ type: "text", text: "QUERIED_DESCENDANT_DETAIL" }],
    },
  });
  const node = readNode(join(h.ctx.cwd, ".pi"), "child");
  assert.equal(node.parent_run_id, "parent");
  assert.equal(node.detail?.events.length, 3);
  assert.match(JSON.stringify(node.detail), /OWN_TOOL_RESULT/);
  assert.doesNotMatch(JSON.stringify(node), /DESCENDANT_LIVE_TEXT|QUERIED_DESCENDANT_DETAIL/);
});

test("spawn call puts the complete task below category and role without preview truncation", (t) => {
  const h = harness(t);
  const tool = h.tools.get(SPAWN_TOOL);
  const theme = { fg: (_color: string, text: string) => text };
  const context = { state: {}, lastComponent: undefined };
  const task = Array.from({ length: 100 }, (_, i) => `STEP-${i}: inspect repository files.`).join(
    "\n",
  );
  const args = { category: "coding", role: "read-only", task };
  const view = tool.renderCall(args, theme, context);
  const lines = view.render(120);
  assert.match(lines[0], /category="coding" role="read-only"/);
  assert.doesNotMatch(lines[0], /STEP|task:/);
  assert.match(lines[1], /^task: STEP-0:/);
  for (const width of [40, 120]) {
    const rendered = view.render(width).join("\n");
    for (let i = 0; i < 100; i++) assert.ok(rendered.includes(`STEP-${i}:`));
    assert.doesNotMatch(rendered, /shortened|more lines|…/);
  }
  assert.equal(args.task, task);
  assert.doesNotThrow(() => tool.renderCall({}, theme, context).render(80));
  assert.match(
    tool.renderCall({ task: "partial" }, theme, context).render(80).join("\n"),
    /task: partial/,
  );
});

test("spawn renderer keeps live output in TUI memory, not the final result", (t) => {
  const h = harness(t);
  const tool = h.tools.get("darknavstar-spawn-model-pool");
  const context = { state: {}, lastComponent: undefined };
  const before = JSON.stringify(h.entries);
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
  };
  const progress = createLiveProgress((partial) => {
    const view = tool.renderResult(partial, { isPartial: true }, theme, context);
    assert.match(view.render(100).join("\n"), /LIVE_TOOL_OUTPUT|running/);
  });
  progress.onProgress({
    agent_run_id: "parent",
    sub_agent_run_id: "child",
    start_time: "now",
    status: "running",
    fallback_to_main_loop: false,
  });
  progress.onActivity({ runId: "child", text: "LIVE_TOOL_OUTPUT" });
  const final = { content: [{ type: "text", text: "receipt and summary" }], details: {} };
  const view = tool.renderResult(final, { isPartial: false }, theme, context);
  assert.match(view.render(100).join("\n"), /LIVE_TOOL_OUTPUT/);
  assert.doesNotMatch(JSON.stringify(final), /LIVE_TOOL_OUTPUT/);
  assert.equal(JSON.stringify(h.entries), before);
});

test("spawn output uses the default ten-line preview and can expand after completion", async (t) => {
  const { initTheme } = await import("@earendil-works/pi-coding-agent");
  initTheme("dark", false);
  const h = harness(t);
  const tool = h.tools.get("darknavstar-spawn-model-pool");
  const context = { state: {}, lastComponent: undefined };
  const theme = { fg: (_color: string, text: string) => text };
  const live = Array.from({ length: 15 }, (_, i) => `line-${i + 1}`).join("\n");
  const partial = { content: [{ type: "text", text: live }], details: { live } };
  const render = (result: unknown, isPartial: boolean, expanded: boolean) =>
    tool.renderResult(result, { isPartial, expanded }, theme, context).render(120).join("\n");
  const collapsed = render(partial, true, false);
  assert.match(collapsed, /line-10/);
  assert.doesNotMatch(collapsed, /line-11/);
  assert.match(collapsed, /5 more lines/);
  assert.match(collapsed, /to expand/);
  assert.match(render(partial, true, true), /line-15/);
  const final = { content: [{ type: "text", text: "summary" }], details: {} };
  assert.match(render(final, false, false), /6 more lines/);
  assert.match(render(final, false, true), /line-15\s+summary/);
  assert.doesNotMatch(render(final, false, true), /more lines/);
  assert.doesNotMatch(JSON.stringify(final), /line-15/);
  assert.match(render(final, false, false), /6 more lines/);
});

test("each live turn has its own preview box, retained after completion", async (t) => {
  const { initTheme } = await import("@earendil-works/pi-coding-agent");
  initTheme("dark", false);
  const tool = harness(t).tools.get("darknavstar-spawn-model-pool");
  const context = { state: {}, lastComponent: undefined };
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
  };
  const turns = [1, 2].map((turn) => ({
    runId: "child",
    turn,
    text: Array.from({ length: 12 }, (_, i) => `turn${turn}-line${i + 1}`).join("\n"),
  }));
  const partial = { content: [{ type: "text", text: "running" }], details: { live: "", turns } };
  const render = (result: unknown, isPartial: boolean, expanded: boolean) =>
    tool.renderResult(result, { isPartial, expanded }, theme, context).render(100).join("\n");
  const collapsed = render(partial, true, false);
  assert.match(collapsed, /Turn 1/);
  assert.match(collapsed, /Turn 2/);
  assert.match(collapsed, /turn1-line10/);
  assert.match(collapsed, /turn2-line10/);
  assert.doesNotMatch(collapsed, /line[12]\s/);
  assert.match(collapsed, /turn1-line12/);
  assert.match(collapsed, /turn2-line12/);
  assert.equal(collapsed.match(/2 earlier lines/g)?.length, 2);
  const final = { content: [{ type: "text", text: "summary" }], details: {} };
  const expanded = render(final, false, true);
  assert.match(expanded, /turn1-line12/);
  assert.match(expanded, /turn2-line12/);
  assert.match(expanded, /Result/);
  assert.match(expanded, /summary/);
  assert.doesNotMatch(JSON.stringify(final), /turn1/);
  assert.equal(render(final, false, false).match(/2 earlier lines/g)?.length, 2);
});

test("child budget exhaustion aborts; unknown usage does not act like cumulative spend", (t) => {
  const h = harness(t, {});
  h.fire("session_start");
  h.setUsage({ tokens: null, contextWindow: 1000 });
  h.fire("context", { messages: [] });
  assert.equal(h.aborted(), false);
  h.setUsage({ tokens: 1000, contextWindow: 1000 });
  h.fire("context", { messages: [] });
  assert.equal(h.aborted(), true);
});
