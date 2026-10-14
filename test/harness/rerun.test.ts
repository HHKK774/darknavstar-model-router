import assert from "node:assert/strict";
import { test } from "node:test";
import {
  lastSpawn,
  registerRerunCommand,
  replayContext,
  RERUN_COMMAND,
  RERUN_RESULT,
} from "../../src/harness/rerun.ts";
import { SPAWN_TOOL } from "../../src/config.ts";
import type { RunEntry } from "../../src/runtime/records.ts";

function harness() {
  const source: RunEntry = {
    agent_run_id: "parent",
    sub_agent_run_id: "old",
    start_time: "start",
    end_time: "end",
    status: "success",
    fallback_to_main_loop: false,
    task: "original task",
    route: { category: "coding", role: "read-only", task_complexity: "simple" },
    summary: "old result",
    tool_call_id: "call",
    model_config: { model_alias: "test/model", censored: true },
    snapshot: {
      version: 1,
      project_dir: "/project",
      allowed_tools: ["read"],
    },
  };
  const call = {
    type: "message",
    id: "call-node",
    parentId: "user",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call",
          name: SPAWN_TOOL,
          arguments: { category: "coding", role: "read-only", task: "original task" },
        },
      ],
    },
  };
  const result = {
    type: "message",
    id: "result-node",
    parentId: "call-node",
    message: {
      role: "toolResult",
      toolCallId: "call",
      content: [
        { type: "text", text: JSON.stringify({ receipt: source, summary: source.summary }) },
      ],
    },
  };
  const branch: any[] = [
    call,
    result,
    {
      type: "message",
      id: "answer",
      message: { role: "assistant", content: [{ type: "text", text: "old answer" }] },
    },
  ];
  let leaf = "answer",
    session = "session";
  const store: any = { node: { agent_run_id: "parent", entries: { old: source } } };
  const notices: string[] = [],
    sent: any[] = [],
    commands = new Map<string, any>(),
    hooks = new Map<string, any>();
  const pi: any = {
    getActiveTools: () => [SPAWN_TOOL],
    on: (event: string, handler: any) => hooks.set(event, handler),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    sendMessage: (message: any, options: any) => sent.push({ message, options }),
  };
  const ctx: any = {
    cwd: "/project",
    mode: "rpc",
    hasUI: false,
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: { getBranch: () => branch, getLeafId: () => leaf, getSessionId: () => session },
    navigateTree: async (id: string) => {
      assert.equal(hooks.get("session_before_tree")(), undefined);
      leaf = id;
      branch.splice(1);
      return { cancelled: false };
    },
    ui: { notify: (message: string) => notices.push(message), confirm: async () => true },
  };
  let executions = 0;
  const deps = {
    store: () => store,
    busy: () => false,
    execute: async (..._args: any[]) => {
      executions++;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              receipt: { ...source, sub_agent_run_id: "new" },
              summary: "new result",
            }),
          },
        ],
        details: {},
      };
    },
  };
  const control = registerRerunCommand(pi, deps);
  return {
    source,
    call,
    branch,
    store,
    notices,
    sent,
    ctx,
    deps,
    hooks,
    control,
    run: (args = "--confirm") => commands.get(RERUN_COMMAND).handler(args, ctx),
    executions: () => executions,
    changeSession: () => {
      session = "other";
      hooks.get("session_start")();
    },
  };
}

test("rerun uses current branch, keeps original call and replaces old result without changing snapshots", async () => {
  const h = harness();
  h.store.node.entries.newerOnOtherBranch = {
    ...h.source,
    sub_agent_run_id: "other",
    task: "unrelated",
  };
  const before = JSON.stringify(h.source);
  await h.run();
  assert.equal(h.executions(), 1);
  assert.deepEqual(h.branch, [h.call]);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].options.triggerTurn, true);
  const messages: any[] = [h.call.message, { role: "custom", ...h.sent[0].message, timestamp: 10 }];
  const projected = replayContext(messages);
  assert.equal(projected[1].role, "toolResult");
  assert.equal((projected[1] as any).toolCallId, "call");
  assert.match(JSON.stringify(projected[1]), /new result/);
  assert.equal(messages[1].role, "custom");
  assert.equal(JSON.stringify(h.source), before);
});

test("selection rejects missing non-spawn results, incomplete runs, old records and changed cwd", () => {
  for (const mutate of [
    (h: ReturnType<typeof harness>) =>
      h.call.message.content.push({ ...h.call.message.content[0], id: "second", name: "bash" }),
    (h: ReturnType<typeof harness>) => {
      h.source.status = "running";
    },
    (h: ReturnType<typeof harness>) => {
      delete h.source.snapshot;
    },
    (h: ReturnType<typeof harness>) => {
      h.ctx.cwd = "/other";
    },
    (h: ReturnType<typeof harness>) => {
      h.source.task = "changed";
    },
  ]) {
    const h = harness();
    mutate(h);
    assert.throws(() => lastSpawn(h.ctx, h.store));
  }
  const h = harness();
  h.branch.length = 0;
  assert.throws(() => lastSpawn(h.ctx, h.store), /No spawn/);
});

function addBatch(h: ReturnType<typeof harness>) {
  h.call.message.content.push(
    { ...h.call.message.content[0], id: "bash-call", name: "bash" },
    { ...h.call.message.content[0], id: "second" },
  );
  h.store.node.entries.second = {
    ...structuredClone(h.source),
    tool_call_id: "second",
    sub_agent_run_id: "second",
  };
  h.branch.splice(2, 0, {
    type: "message",
    id: "bash-result",
    message: {
      role: "toolResult",
      toolName: "bash",
      toolCallId: "bash-call",
      content: [{ type: "text", text: "original bash output" }],
      details: { exitCode: 1 },
      isError: true,
      timestamp: 1,
    },
  });
}

test("mixed batches replay all spawns, retain non-router results, and continue only after all results", async () => {
  const h = harness();
  addBatch(h);
  const calls: string[] = [];
  h.deps.execute = async (id, source) => {
    calls.push(id);
    const next = {
      ...source,
      sub_agent_run_id: `${source.sub_agent_run_id}-next`,
      rerun_of: { agent_run_id: "parent", sub_agent_run_id: source.sub_agent_run_id },
    };
    h.store.node.entries[next.sub_agent_run_id] = next;
    return {
      content: [{ type: "text", text: JSON.stringify({ receipt: next, summary: "new output" }) }],
      details: {},
    };
  };
  await h.run();
  assert.deepEqual(calls, ["call", "second"]);
  assert.equal(h.sent.length, 3);
  assert.deepEqual(
    h.sent.map((s) => s.options.triggerTurn),
    [false, false, true],
  );
  const messages = replayContext([
    h.call.message,
    ...h.sent.map((s) => ({ role: "custom", ...s.message, timestamp: 1 })),
  ] as any);
  assert.deepEqual(
    messages.slice(1).map((m: any) => m.toolCallId),
    ["call", "bash-call", "second"],
  );
  assert.equal((messages[2] as any).toolName, "bash");
  assert.equal((messages[2] as any).isError, true);
  assert.deepEqual((messages[2] as any).details, { exitCode: 1 });
  assert.match(JSON.stringify(messages[2]), /original bash output/);
  for (const s of h.sent)
    h.branch.push({ type: "custom_message", ...s.message, timestamp: new Date().toISOString() });
  const selected = lastSpawn(h.ctx, h.store);
  assert.deepEqual(
    selected.results.filter((r) => r.source).map((r) => r.source!.sub_agent_run_id),
    ["old-next", "second-next"],
  );
  h.sent.length = 0;
  await h.run();
  assert.deepEqual(calls, ["call", "second", "call", "second"]);
  assert.match(JSON.stringify(h.sent[1]), /original bash output/);
});

test("pure spawn batches wait for every execution and validate all snapshots before branching", async () => {
  const h = harness();
  addBatch(h);
  h.call.message.content.splice(1, 1);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started: string[] = [];
  h.deps.execute = async (id) => {
    started.push(id);
    if (id === "second") await gate;
    return { content: [{ type: "text", text: id }], details: {} };
  };
  const work = h.run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["call", "second"]);
  assert.equal(h.sent.length, 0);
  release();
  await work;
  assert.equal(h.sent.length, 2);
  assert.deepEqual(
    h.sent.map((s) => s.options.triggerTurn),
    [false, true],
  );

  const invalid = harness();
  addBatch(invalid);
  delete invalid.store.node.entries.second.snapshot;
  await invalid.run();
  assert.equal(invalid.executions(), 0);
  assert.equal(invalid.sent.length, 0);
  assert.equal(invalid.ctx.sessionManager.getLeafId(), "answer");
});

test("batch execution errors still deliver every result without continuing", async () => {
  const h = harness();
  addBatch(h);
  h.deps.execute = async (id) => {
    if (id === "call") throw new Error("first failed");
    return { content: [{ type: "text", text: "second completed" }], details: {} };
  };
  await h.run();
  assert.equal(h.sent.length, 3);
  assert.equal(h.sent[0].message.details.isError, true);
  assert.match(JSON.stringify(h.sent[2]), /second completed/);
  assert.ok(h.sent.every((s) => !s.options.triggerTurn));
});

test("busy, queued, unconfirmed and cancelled navigation do not execute or replace context", async () => {
  for (const setup of [
    (h: ReturnType<typeof harness>) => {
      h.ctx.isIdle = () => false;
    },
    (h: ReturnType<typeof harness>) => {
      h.ctx.hasPendingMessages = () => true;
    },
    (h: ReturnType<typeof harness>) => {
      h.ctx.navigateTree = async () => ({ cancelled: true });
    },
  ]) {
    const h = harness();
    setup(h);
    await h.run();
    assert.equal(h.executions(), 0);
    assert.equal(h.sent.length, 0);
    assert.equal(h.branch.length, 3);
  }
  const h = harness();
  await h.run("");
  assert.equal(h.executions(), 0);
  assert.match(h.notices.join("\n"), /--confirm/);
});

test("a session change during confirmation never replays captured work in the replacement session", async () => {
  const h = harness();
  h.ctx.hasUI = true;
  h.ctx.ui.confirm = async () => {
    h.changeSession();
    return true;
  };
  await h.run("");
  assert.equal(h.executions(), 0);
  assert.equal(h.sent.length, 0);
});

test("cancellation waits for rerun cleanup and publishes an aborted result without continuing", async () => {
  const h = harness();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  h.deps.execute = async (_id, _source, _ctx, signal) => {
    started();
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    return {
      content: [
        { type: "text", text: JSON.stringify({ receipt: { status: "aborted" }, summary: "" }) },
      ],
      details: {},
    };
  };
  const work = h.run();
  await ready;
  assert.deepEqual(h.hooks.get("session_before_tree")(), { cancel: true });
  assert.deepEqual(h.hooks.get("input")({}, h.ctx), { action: "handled" });
  await h.control.cancelAndWait();
  await work;
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].options.triggerTurn, false);
});

test("compacted rerun results stay ordinary context when their original call is absent", () => {
  const messages: any[] = [
    {
      role: "custom",
      customType: RERUN_RESULT,
      content: "saved result",
      details: { toolCallId: "compacted-call" },
      display: true,
      timestamp: 1,
    },
  ];
  assert.deepEqual(replayContext(messages), messages);
});

test("unexpected execution failure leaves a paired error result, not a dangling call", async () => {
  const h = harness();
  h.deps.execute = async () => {
    throw new Error("unexpected failure");
  };
  await h.run();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].message.details.isError, true);
  assert.equal(h.sent[0].options.triggerTurn, false);
  assert.match(JSON.stringify(h.sent[0]), /unexpected failure/);
});
