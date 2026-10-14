import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { dispatch, type DispatchOptions } from "../../src/runtime/dispatch.ts";
import { parsePool } from "../../src/config.ts";
import { acquireCodingLock, CODING_LOCKS_ENV } from "../../src/runtime/coding-lock.ts";
import {
  queryRecords,
  readNode,
  RecordStore,
  type CompleteRunEntry,
} from "../../src/runtime/records.ts";

const fixture = fileURLToPath(new URL("../fixtures/child.mjs", import.meta.url));
function setup(t: TestContext): DispatchOptions {
  const projectDir = mkdtempSync(join(tmpdir(), "router-dispatch-test-"));
  t.after(() => rmSync(projectDir, { recursive: true, force: true }));
  const home = process.env.HOME;
  const ancestry = process.env[CODING_LOCKS_ENV];
  process.env.HOME = projectDir;
  delete process.env[CODING_LOCKS_ENV];
  t.after(() => {
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
    if (ancestry === undefined) delete process.env[CODING_LOCKS_ENV];
    else process.env[CODING_LOCKS_ENV] = ancestry;
  });
  const identity = { runId: "parent", sessionId: "session-parent", depth: 0, projectDir };
  return {
    identity,
    store: new RecordStore(projectDir, identity.runId, identity.sessionId, 0),
    route: { category: "coding", role: "read-only" },
    task: "test",
    loadPool: () => {
      const config = { model_alias: "test/model", censored: true, prompt: "test" };
      return parsePool({ coding: { "read-only": { simple: config, medium: config } } });
    },
    modelExists: (alias) => alias === "test/model",
    availableTools: ["read", "write", "edit", "bash", "darknavstar-spawn-model-pool"],
    remainingContext: 1000,
    extensionFile: "/extension.ts",
    invocation: (args) => ({ command: process.execPath, args: [fixture, ...args] }),
  };
}

test(
  "coding waits without spawning while research and multi-modal bypass the lock",
  { timeout: 10000 },
  async (t) => {
    const options = setup(t);
    const owner = await acquireCodingLock({ cwd: options.identity.projectDir, runId: "owner" });
    t.after(() => owner.release());
    let spawned = false;
    let reportWaiting!: () => void;
    const waiting = new Promise<void>((resolve) => {
      reportWaiting = resolve;
    });
    const coding = dispatch({
      ...options,
      onActivity: () => reportWaiting(),
      invocation: (args) => {
        spawned = true;
        return options.invocation!(args);
      },
    });
    await waiting;
    assert.equal(spawned, false);
    const pool = options.loadPool();
    pool.research = pool.coding;
    pool["multi-modal"] = pool.coding;
    const results = await Promise.all(
      ["research", "multi-modal"].map((category) =>
        dispatch({
          ...options,
          route: { category: category as "research" | "multi-modal", role: "read-only" },
          loadPool: () => pool,
        }),
      ),
    );
    assert.ok(results.every((result) => result.receipt.status === "success"));
    assert.equal(spawned, false);
    owner.release();
    assert.equal((await coding).receipt.status, "success");
    assert.equal(spawned, true);
  },
);

test("queued coding aborts without spawning and nested coding returns fallback", async (t) => {
  const options = setup(t);
  const owner = await acquireCodingLock({ cwd: options.identity.projectDir, runId: "owner" });
  t.after(() => owner.release());
  const controller = new AbortController();
  const cancelled = await dispatch({
    ...options,
    signal: controller.signal,
    onActivity: () => controller.abort(),
    invocation: () => assert.fail("queued child must not spawn"),
  });
  assert.equal(cancelled.receipt.status, "aborted");
  assert.equal(cancelled.receipt.fallback_to_main_loop, true);
  process.env[CODING_LOCKS_ENV] = owner.ancestry;
  const nested = await dispatch({
    ...options,
    invocation: () => assert.fail("nested child must not spawn"),
  });
  assert.equal(nested.receipt.status, "fail");
  assert.match(nested.receipt.reason!, /Nested coding delegation/);
  assert.equal(nested.receipt.fallback_to_main_loop, true);
  owner.release();
});

test("failed coding execution releases its cwd lock", { timeout: 10000 }, async (t) => {
  const options = setup(t);
  const result = await dispatch({ ...options, task: "crash" });
  assert.equal(result.receipt.status, "fail");
  const lease = await acquireCodingLock({
    cwd: options.identity.projectDir,
    runId: "next",
    onWait: () => assert.fail("failed task must release the lock"),
  });
  lease.release();
});

test("heuristic routes simple/hard tasks and never substitutes the medium mapping", async (t) => {
  const options = setup(t);
  const onlyMedium = options.loadPool();
  delete onlyMedium.coding["read-only"].simple;
  const simple = await dispatch({ ...options, task: "rename a typo", loadPool: () => onlyMedium });
  assert.equal(simple.receipt.status, "fail");
  assert.match(simple.receipt.reason!, /No model pool mapping/);
  assert.equal(
    options.store.node.entries[simple.receipt.sub_agent_run_id].route.task_complexity,
    "simple",
  );
  const pool = options.loadPool();
  pool.coding["read-only"].hard = pool.coding["read-only"].medium;
  const hard = await dispatch({ ...options, task: "architecture design", loadPool: () => pool });
  assert.equal(hard.receipt.status, "success");
  assert.equal(
    options.store.node.entries[hard.receipt.sub_agent_run_id].route.task_complexity,
    "hard",
  ); // Last spawn failed: 3 + 2 + 2.6 = 7.6.
  const normal = await dispatch({ ...options, task: "architecture design", loadPool: () => pool });
  assert.equal(normal.receipt.status, "success");
  assert.equal(
    options.store.node.entries[normal.receipt.sub_agent_run_id].route.task_complexity,
    "medium",
  ); // A subsequent success clears the failure signal.
});

test("dispatch passes tool availability and new-image context into scoring", async (t) => {
  const options = setup(t);
  const pool = options.loadPool();
  pool.coding["read-only"].hard = pool.coding["read-only"].medium;
  const task = "architecture debug design ```a``` ```b```"; // 6.8 without tools/images.
  const first = await dispatch({ ...options, task, availableTools: [], loadPool: () => pool });
  assert.equal(first.receipt.status, "success");
  assert.equal(
    options.store.node.entries[first.receipt.sub_agent_run_id].route.task_complexity,
    "medium",
  );
  const second = await dispatch({
    ...options,
    task,
    availableTools: [],
    hasNewImage: true,
    loadPool: () => pool,
  });
  assert.equal(second.receipt.status, "success");
  assert.equal(
    options.store.node.entries[second.receipt.sub_agent_run_id].route.task_complexity,
    "hard",
  );
  const third = await dispatch({
    ...options,
    task,
    loadPool: () => pool,
    availableTools: [...options.availableTools, "tool1", "tool2", "tool3", "tool4"],
  });
  assert.equal(third.receipt.status, "success");
  assert.equal(
    options.store.node.entries[third.receipt.sub_agent_run_id].route.task_complexity,
    "hard",
  );
});

test("custom category dispatch uses its configured model without a built-in category entry", async (t) => {
  const options = setup(t);
  const pool = options.loadPool();
  const result = await dispatch({
    ...options,
    route: { category: "review", role: "read-only" },
    loadPool: () => ({ review: pool.coding }),
  });
  assert.equal(result.receipt.status, "success");
  assert.equal(
    options.store.node.entries[result.receipt.sub_agent_run_id].route.category,
    "review",
  );
});

test("replay freezes task, route, model, tools and instructions without rereading pool or overwriting source", async (t) => {
  const options = setup(t);
  const first = await dispatch({
    ...options,
    toolCallId: "original-call",
    instructions: { router_category_prompt: "ORIGINAL", router_delegation_prompt: "CHECK" },
  });
  const source = structuredClone(options.store.node.entries[first.receipt.sub_agent_run_id]);
  assert.ok(source.snapshot);
  assert.ok(source.model_config);
  assert.deepEqual(Object.keys(source.snapshot).sort(), [
    "allowed_tools",
    "instructions",
    "project_dir",
    "version",
  ]);
  const replay = { ...source, snapshot: source.snapshot, model_config: source.model_config };
  const second = await dispatch({
    ...options,
    task: "ignored replacement task",
    replay,
    loadPool: () => {
      throw new Error("must not reload routing config");
    },
    availableTools: [...options.availableTools, "new-tool"],
  });
  assert.equal(second.receipt.status, "success");
  const repeated = options.store.node.entries[second.receipt.sub_agent_run_id];
  assert.deepEqual(repeated.snapshot, source.snapshot);
  assert.deepEqual(repeated.rerun_of, {
    agent_run_id: source.agent_run_id,
    sub_agent_run_id: source.sub_agent_run_id,
  });
  assert.equal(repeated.task, source.task);
  assert.deepEqual(repeated.route, source.route);
  assert.deepEqual(repeated.model_config, source.model_config);
  assert.deepEqual(options.store.node.entries[source.sub_agent_run_id], source);
  assert.notEqual(second.receipt.sub_agent_run_id, source.sub_agent_run_id);
  const denied = await dispatch({ ...options, replay, availableTools: [] });
  assert.equal(denied.receipt.status, "fail");
  assert.match(denied.receipt.reason!, /no longer available or permitted/);
});

test("dispatch returns receipt/summary and stores details separately", async (t) => {
  const options = setup(t);
  const updates: unknown[] = [];
  let activity = "";
  const startup: string[] = [];
  const result = await dispatch({
    ...options,
    onProgress: (receipt) => {
      updates.push(receipt);
      assert.doesNotMatch(
        readFileSync(options.store.file, "utf8"),
        /CHILD_INTERMEDIATE|CHILD_PRIVATE/,
      );
    },
    onActivity: (update) => {
      assert.equal(update.runId, Object.keys(options.store.node.entries)[0]);
      activity += update.text;
      if (update.turn === 0) startup.push(update.text);
    },
  });
  assert.equal(result.receipt.status, "success");
  assert.deepEqual(Object.keys(result).sort(), ["receipt", "summary"]);
  const summary = JSON.parse(result.summary);
  assert.equal(summary.note, "动作和结果 🌲");
  assert.equal(summary.runId, result.receipt.sub_agent_run_id);
  assert.deepEqual(summary.tools, ["read", "bash"]);
  assert.ok(summary.args.includes("--no-session"));
  assert.equal(summary.args[summary.args.indexOf("--thinking") + 1], "off");
  assert.ok(updates.length > 1);
  const entry = options.store.node.entries[result.receipt.sub_agent_run_id];
  assert.equal(entry.detail, undefined);
  assert.equal(entry.route.task_complexity, "simple");
  assert.match(
    startup.join(""),
    /Starting child process[\s\S]*Initialization complete; agent started/,
  );
  assert.ok(
    activity.indexOf("Initialization complete") < activity.indexOf("CHILD_INTERMEDIATE_TEXT"),
  );
  assert.doesNotMatch(JSON.stringify(result), /Starting child process|Initialization complete/);
  assert.match(activity, /CHILD_INTERMEDIATE_TEXT/);
  assert.match(activity, /tool read/);
  assert.match(activity, /CHILD_PRIVATE_TOOL_OUTPUT/);
  assert.doesNotMatch(JSON.stringify(result), /CHILD_INTERMEDIATE|CHILD_PRIVATE/);
  const child = readNode(options.identity.projectDir, result.receipt.sub_agent_run_id);
  assert.equal(child.detail?.remaining_context, 777);
  assert.equal(child.session_id, `session-${result.receipt.sub_agent_run_id}`);
  const full = queryRecords(
    options.identity.projectDir,
    "parent",
    "get",
    result.receipt.sub_agent_run_id,
  ) as CompleteRunEntry;
  assert.deepEqual(full.detail, child.detail);
  assert.equal(entry.model_config?.censored, true);
});

test("dispatch explicitly passes configured thinking level and records its snapshot", async (t) => {
  const options = setup(t);
  const pool = options.loadPool();
  pool.coding["read-only"].medium.thinking_level = "low";
  const result = await dispatch({ ...options, loadPool: () => pool });
  assert.equal(result.receipt.status, "success");
  const { args } = JSON.parse(result.summary);
  assert.equal(args[args.indexOf("--thinking") + 1], "low");
  assert.equal(
    options.store.node.entries[result.receipt.sub_agent_run_id].model_config?.thinking_level,
    "low",
  );
});

test("concurrent processes keep distinct IDs and all sibling records", async (t) => {
  const options = setup(t);
  const inheritedId = process.env.PI_MODEL_ROUTER_RUN_ID;
  const results = await Promise.all(
    ["slow", "fast", "third"].map((task) => dispatch({ ...options, task })),
  );
  assert.equal(new Set(results.map((result) => result.receipt.sub_agent_run_id)).size, 3);
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    assert.equal(result.receipt.status, "success");
    const summary = JSON.parse(result.summary);
    assert.equal(summary.task, ["slow", "fast", "third"][i]);
    assert.equal(summary.runId, result.receipt.sub_agent_run_id);
  }
  assert.equal(Object.keys(options.store.node.entries).length, 3);
  assert.equal(process.env.PI_MODEL_ROUTER_RUN_ID, inheritedId);
});

test("failed preflight checks fall back without spawning", async (t) => {
  const options = setup(t);
  let spawned = false;
  const noSpawn = () => {
    spawned = true;
    throw new Error("must not spawn");
  };
  for (const overrides of [
    { loadPool: () => ({}) },
    { modelExists: () => false },
    { identity: { ...options.identity, depth: 4 } },
    { remainingContext: 0 },
    {
      loadPool: () => {
        throw new Error("invalid config");
      },
    },
  ]) {
    const result = await dispatch({ ...options, ...overrides, invocation: noSpawn });
    assert.equal(result.receipt.status, "fail");
    assert.equal(result.receipt.fallback_to_main_loop, true);
    assert.ok(result.receipt.reason);
  }
  assert.equal(spawned, false);
});

test("depth 4 has no spawn tool even if configuration includes it", async (t) => {
  const options = setup(t);
  const result = await dispatch({ ...options, identity: { ...options.identity, depth: 3 } });
  assert.equal(result.receipt.status, "success");
  assert.ok(!JSON.parse(result.summary).tools.includes("darknavstar-spawn-model-pool"));
});

test("medium gate overrides explicit spawn includes and passes --no-tools when empty", async (t) => {
  const options = { ...setup(t), task: "design" };
  const pool = options.loadPool();
  pool.coding["read-only"].medium.include_tools = ["darknavstar-spawn-model-pool"];
  const result = await dispatch({ ...options, loadPool: () => pool });
  assert.equal(result.receipt.status, "success");
  const summary = JSON.parse(result.summary);
  assert.deepEqual(summary.tools, []);
  assert.ok(summary.args.includes("--no-tools"));
});

test("empty include really starts a tool-less child", async (t) => {
  const options = setup(t);
  const pool = options.loadPool();
  pool.coding["read-only"].medium.include_tools = [];
  const result = await dispatch({ ...options, loadPool: () => pool });
  const summary = JSON.parse(result.summary);
  assert.deepEqual(summary.tools, []);
  assert.ok(summary.args.includes("--no-tools"));
});

for (const task of ["crash", "error", "length", "nostart", "wrong-id", "wrong-model"]) {
  test(`${task} returns a failure receipt instead of changing models`, async (t) => {
    const result = await dispatch({ ...setup(t), task });
    assert.equal(result.receipt.status, "fail");
    assert.equal(result.receipt.fallback_to_main_loop, true);
    assert.ok(result.receipt.reason);
  });
}

test("stderr is displayed live but never copied into the parent's file", async (t) => {
  const options = setup(t);
  let output = "";
  const result = await dispatch({
    ...options,
    task: "crash",
    onActivity: (activity) => {
      output += activity.text;
    },
  });
  assert.equal(result.receipt.status, "fail");
  assert.match(output, /provider unavailable/);
  assert.doesNotMatch(readFileSync(options.store.file, "utf8"), /provider unavailable/);
  assert.doesNotMatch(JSON.stringify(result), /provider unavailable/);
  assert.deepEqual(
    queryRecords(options.identity.projectDir, "parent", "get", result.receipt.sub_agent_run_id),
    {
      ...options.store.node.entries[result.receipt.sub_agent_run_id],
      detail: null,
    },
  );
});

test("OS launch failures are recorded", async (t) => {
  const result = await dispatch({
    ...setup(t),
    invocation: () => ({ command: "/does-not-exist/pi", args: [] }),
  });
  assert.equal(result.receipt.status, "fail");
  assert.match(result.receipt.reason!, /ENOENT/);
});

test("nested children are discoverable and queried through their immediate parent", async (t) => {
  const options = setup(t);
  const activity: { runId: string; text: string }[] = [];
  const result = await dispatch({
    ...options,
    task: "nested",
    onActivity: (value) => activity.push(value),
  });
  assert.equal(result.receipt.status, "success");
  const childId = result.receipt.sub_agent_run_id;
  const child = queryRecords(
    options.identity.projectDir,
    "parent",
    "get",
    childId,
  ) as CompleteRunEntry;
  assert.ok(!Object.hasOwn(child, "sub_agents"));
  const children = queryRecords(options.identity.projectDir, childId, "list");
  assert.ok(Array.isArray(children));
  assert.equal(children[0].sub_agent_run_id, `${childId}-grand`);
  const entry = queryRecords(
    options.identity.projectDir,
    childId,
    "get",
    children[0].sub_agent_run_id,
  ) as CompleteRunEntry;
  assert.equal(entry.summary, "grand summary");
  assert.ok(
    activity.some(
      (value) => value.runId === `${childId}-grand` && value.text === "GRANDCHILD_PRIVATE_ACTIVITY",
    ),
  );
  assert.match(JSON.stringify(entry.detail), /GRANDCHILD_PRIVATE_ACTIVITY/);
  assert.doesNotMatch(readFileSync(options.store.file, "utf8"), /GRANDCHILD_PRIVATE_ACTIVITY/);
  assert.doesNotMatch(JSON.stringify(child.detail), /GRANDCHILD_PRIVATE_ACTIVITY/);
});

test("pre-cancelled requests never spawn", async (t) => {
  const result = await dispatch({
    ...setup(t),
    signal: AbortSignal.abort(),
    invocation: () => {
      throw new Error("must not run");
    },
  });
  assert.equal(result.receipt.status, "aborted");
});

test(
  "cancellation terminates a stubborn child and its descendants",
  { timeout: 10000 },
  async (t) => {
    const options = setup(t);
    const pidFile = join(options.identity.projectDir, "grandchild.pid");
    const controller = new AbortController();
    const work = dispatch({ ...options, task: `tree:${pidFile}`, signal: controller.signal });
    t.after(() => controller.abort());
    for (let n = 0; n < 100 && !existsSync(pidFile); n++) await delay(20);
    assert.ok(existsSync(pidFile));
    const pid = Number(readFileSync(pidFile, "utf8"));
    controller.abort();
    const result = await work;
    assert.equal(result.receipt.status, "aborted");
    const next = await acquireCodingLock({
      cwd: options.identity.projectDir,
      runId: "next",
      onWait: () => assert.fail("aborted task must release its cwd lock"),
    });
    next.release();
    for (let n = 0; n < 50; n++) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
      await delay(20);
    }
    assert.fail(`Grandchild ${pid} still exists after cancellation`);
  },
);
