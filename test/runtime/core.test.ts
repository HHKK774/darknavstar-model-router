import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  loadPool,
  THINKING_LEVELS,
  validateModelConfig,
  lookup,
  parsePool,
  queryPool,
  remainingContext,
  resolveTools,
  splitModelAlias,
  type ModelConfig,
} from "../../src/config.ts";
import {
  bindIdentity,
  IDENTITY_ENTRY,
  loadChildConfig,
  CHILD_ENV,
} from "../../src/runtime/identity.ts";
import { queryRecords, RecordStore, recordPath, type RunEntry } from "../../src/runtime/records.ts";

const config: ModelConfig = {
  model_alias: "test/model/with-slashes",
  censored: true,
  prompt: "Review",
};
const route = { category: "coding", role: "read-only", task_complexity: "medium" };

test("thinking level accepts supported values and rejects invalid configuration", () => {
  validateModelConfig(config); // Older configurations may omit it.
  for (const thinking_level of THINKING_LEVELS) {
    const model = { ...config, thinking_level };
    const pool = parsePool({ coding: { "read-only": { medium: model } } });
    assert.equal(lookup(pool, route)?.thinking_level, thinking_level);
  }
  for (const thinking_level of [null, true, 1, "", "HIGH", "auto", "default"]) {
    assert.throws(() => validateModelConfig({ ...config, thinking_level }), /thinking_level/);
  }
});

test("pool configuration and queries support all three complexity tiers without fallback", () => {
  const tiers = {
    simple: { ...config, model_alias: "test/simple" },
    medium: config,
    hard: { ...config, model_alias: "test/hard" },
  };
  const pool = parsePool({ coding: { "read-only": tiers } });
  for (const task_complexity of ["simple", "medium", "hard"] as const) {
    assert.deepEqual(queryPool(pool, { ...route, task_complexity }), tiers[task_complexity]);
  }
  assert.deepEqual(queryPool(pool, { category: "coding", role: "read-only" }), tiers);
  const onlyMedium = parsePool({ coding: { "read-only": { medium: config } } });
  assert.equal(queryPool(onlyMedium, { ...route, task_complexity: "simple" }), null);
  assert.equal(queryPool(onlyMedium, { ...route, task_complexity: "hard" }), null);
});

test("legacy default config normalizes to medium without mutating input or providing fallback", () => {
  const input = { coding: { "read-only": { default: config } } };
  const before = JSON.stringify(input);
  const pool = parsePool(input);
  assert.deepEqual(Object.keys(pool.coding["read-only"]), ["medium"]);
  assert.equal(queryPool(pool, route), config);
  assert.equal(queryPool(pool, { ...route, task_complexity: "simple" }), null);
  assert.equal(queryPool(pool, { ...route, task_complexity: "hard" }), null);
  assert.equal(JSON.stringify(input), before);
  assert.throws(
    () => queryPool(pool, { ...route, task_complexity: "default" }),
    /expected simple, medium, or hard/,
  );
  for (const tiers of [
    { default: config, medium: config },
    { medium: config, default: config },
  ]) {
    assert.throws(
      () => parsePool({ coding: { "read-only": tiers } }),
      /Conflicting complexity keys/,
    );
  }
});

test("pool lookup is exact and unmapped entries return null", () => {
  const pool = parsePool({ coding: { "read-only": { medium: config } } });
  assert.deepEqual(lookup(pool, route), config);
  assert.equal(lookup(pool, { ...route, category: "research" }), null);
  assert.deepEqual(splitModelAlias(config.model_alias), ["test", "model/with-slashes"]);
  assert.equal(lookup(pool, { ...route, task_complexity: "hard" }), null);
  assert.throws(() => lookup(pool, { ...route, task_complexity: "invalid" }));
});

test("pool queries return the full pool, subtrees or one config by prefix depth", () => {
  const other = { ...config, model_alias: "test/other", include_tools: ["read"] };
  const pool = parsePool({
    coding: { "read-only": { medium: config }, "read-write": { medium: other } },
    research: { "read-only": { medium: other } },
  });
  assert.deepEqual(queryPool(pool), pool);
  assert.deepEqual(queryPool(pool, {}), pool);
  assert.deepEqual(queryPool({}), {});
  assert.deepEqual(queryPool(pool, { category: "coding" }), pool.coding);
  assert.deepEqual(
    queryPool(pool, { category: "coding", role: "read-only" }),
    pool.coding["read-only"],
  );
  assert.deepEqual(queryPool(pool, route), config);
  assert.equal(queryPool(pool, { category: "general" }), null);
  assert.equal(queryPool(pool, { category: "research", role: "read-write" }), null);
  assert.equal(queryPool(pool, { ...route, category: "general" }), null);
  assert.deepEqual(queryPool(parsePool({ coding: {} }), { category: "coding" }), {});
});

test("pool query rejects skipped parents and invalid supplied dimensions", () => {
  for (const partial of [
    { role: "read-only" },
    { task_complexity: "medium" },
    { role: "read-only", task_complexity: "medium" },
    { category: "coding", task_complexity: "medium" },
  ]) {
    assert.throws(() => queryPool({}, partial), /requires category/);
  }
  assert.equal(queryPool({}, { category: "unconfigured" }), null);
  assert.throws(() => queryPool({}, { category: "invalid name" }), /Invalid category/);
  assert.throws(() => queryPool({}, { category: "coding", role: "invalid" }), /Unknown role/);
  assert.throws(
    () => queryPool({}, { ...route, task_complexity: "invalid" }),
    /Unknown task_complexity/,
  );
});

test("prompt may be omitted or empty, but must be a string when supplied", () => {
  const { prompt: _prompt, ...withoutPrompt } = config;
  for (const value of [withoutPrompt, { ...withoutPrompt, prompt: "" }]) {
    const pool = parsePool({ coding: { "read-only": { medium: value } } });
    assert.deepEqual(lookup(pool, route), value);
  }
  for (const prompt of [null, 42, false, [], {}]) {
    assert.throws(
      () => parsePool({ coding: { "read-only": { medium: { ...withoutPrompt, prompt } } } }),
      /prompt must be a string/,
    );
  }
});

test("config validation catches typos, string booleans and unsupported dimensions", () => {
  for (const value of [
    { coding: { "read-only": { medium: { ...config, censored: "true" } } } },
    { coding: { "read-only": { medium: { ...config, include_tool: [] } } } },
    { coding: { "read-only": { medium: { ...config, include_tools: [42] } } } },
    { coding: { "read-only": { medium: { ...config, model_alias: "bad" } } } },
    { coding: { wrong: {} } },
    { "invalid name": {} },
    [],
    null,
  ])
    assert.throws(() => parsePool(value));
});

test("missing config is an empty pool, malformed config is not silently ignored", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "router-config-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "pool.json");
  assert.deepEqual(loadPool(file), {});
  writeFileSync(file, "{");
  assert.throws(() => loadPool(file), /Cannot load model pool/);
});

test("read-only only excludes write/edit; explicit tools override the label", () => {
  const all = ["read", "write", "edit", "bash", "custom", "darknavstar-spawn-model-pool"];
  assert.deepEqual(resolveTools(config, "read-only", all, 1), [
    "read",
    "bash",
    "custom",
    "darknavstar-spawn-model-pool",
  ]);
  assert.deepEqual(
    resolveTools(
      { ...config, include_tools: ["write", "edit", "bash"], exclude_tools: ["edit"] },
      "read-only",
      all,
      1,
    ),
    ["write", "bash"],
  );
  assert.deepEqual(resolveTools({ ...config, include_tools: [] }, "read-write", all, 1), []);
  assert.deepEqual(
    resolveTools({ ...config, exclude_tools: ["bash"] }, "read-write", all, 1),
    all.filter((t) => t !== "bash"),
  );
  assert.throws(() => resolveTools({ ...config, include_tools: ["typo"] }, "read-write", all, 1));
});

test("depth and inherited ceiling cannot be overridden by include", () => {
  const all = ["read", "write", "darknavstar-spawn-model-pool"];
  assert.deepEqual(
    resolveTools({ ...config, include_tools: all }, "read-only", all, 4, [
      "read",
      "darknavstar-spawn-model-pool",
    ]),
    ["read"],
  );
});

test("context budget uses current usage and preserves unknown usage", () => {
  assert.equal(remainingContext(1000, 800), 200);
  assert.equal(remainingContext(1000, 1200), 0);
  assert.equal(remainingContext(1000, null), null);
  assert.equal(remainingContext(undefined, 0), null);
});

test("identity survives reload/resume/tree; new sessions get fresh IDs", () => {
  const initial = bindIdentity("session-a", "/project", []);
  const entries = [{ type: "custom", customType: IDENTITY_ENTRY, data: initial }];
  assert.deepEqual(bindIdentity("session-a", "/elsewhere", entries), initial);
  assert.notEqual(bindIdentity("session-b", "/project", entries).runId, initial.runId);
});

test("child identity is preallocated and config/environment IDs must agree", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "router-id-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "child.json");
  const child = {
    runId: "child",
    parentRunId: "parent",
    projectDir: dir,
    depth: 1,
    route,
    modelConfig: config,
    allowedTools: [],
  };
  writeFileSync(file, JSON.stringify(child));
  const env = {
    [CHILD_ENV]: file,
    PI_MODEL_ROUTER_RUN_ID: "child",
    PI_MODEL_ROUTER_PARENT_RUN_ID: "parent",
  };
  assert.deepEqual(loadChildConfig(env), child);
  assert.equal(bindIdentity("s-child", dir, [], child).runId, "child");
  assert.throws(() => loadChildConfig({ ...env, PI_MODEL_ROUTER_RUN_ID: "other" }));
});

test("records keep detail in its owner node and get joins only a direct child's detail", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "router-record-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const parent = new RecordStore(dir, "a", "session-a", 0);
  const child = new RecordStore(dir, "b", "session-b", 1, "a");
  const leaf = new RecordStore(dir, "c", "session-c", 2, "b");
  const entry = (id: string, parent: string): RunEntry => ({
    agent_run_id: parent,
    sub_agent_run_id: id,
    start_time: "now",
    status: "success",
    fallback_to_main_loop: false,
    task: id,
    route,
    summary: `summary ${id}`,
  });
  parent.add(entry("b", "a"));
  child.add(entry("c", "b"));
  leaf.appendEvent({
    action: "read",
    result: "full execution detail, not the summary",
  });
  const completeLeaf = { ...child.node.entries.c, detail: leaf.node.detail };
  assert.deepEqual(queryRecords(dir, "b", "get", "c"), completeLeaf);
  assert.deepEqual(queryRecords(dir, "a", "get", "b"), {
    ...parent.node.entries.b,
    detail: child.node.detail,
  });
  assert.ok(!readFileSync(parent.file, "utf8").includes("full execution detail"));
  assert.ok(!readFileSync(child.file, "utf8").includes("full execution detail"));
  assert.ok(readFileSync(leaf.file, "utf8").includes("full execution detail"));
  assert.throws(() => parent.add({ ...entry("bad", "a"), detail: { events: [] } }));
  const { detail: _detail, ...listedEntry } = parent.node.entries.b;
  assert.deepEqual(queryRecords(dir, "a", "list"), [listedEntry]);
  assert.ok(!Object.hasOwn(listedEntry, "sub_agents"));
  // Older files may carry redundant descendant indexes; queries ignore them without rewriting.
  const legacyParent = { ...parent.node, entries: { b: { ...listedEntry, sub_agents: ["c"] } } };
  writeFileSync(parent.file, JSON.stringify(legacyParent));
  assert.deepEqual(queryRecords(dir, "a", "list"), [listedEntry]);
  assert.match(readFileSync(parent.file, "utf8"), /sub_agents/);
  parent.save();
  assert.doesNotMatch(readFileSync(parent.file, "utf8"), /sub_agents/);
  assert.equal(listedEntry.summary, "summary b");
  assert.ok(!Object.hasOwn(listedEntry, "detail"));
  assert.ok(!Object.hasOwn(parent.node.entries.b, "detail"));
  const listedChild = child.node.entries.c;
  assert.deepEqual(queryRecords(dir, "b", "list"), [listedChild]);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(recordPath(dir, "a"), "utf8")).entries), [
    "b",
  ]);
  assert.throws(() => queryRecords(dir, "a", "get", "c"), /not a direct child/);
  assert.throws(() => queryRecords(dir, "b", "get", "unrelated"), /not a direct child/);
  assert.throws(() => queryRecords(dir, "a", "get", "a"), /not a direct child/);
  assert.throws(() => queryRecords(dir, "a", "get", "toString"), /not a direct child/);
  assert.throws(() => queryRecords(dir, "a", "get", "../../escape"), /Invalid agent run ID/);
  assert.throws(() => queryRecords(dir, "a", "get"), /nonempty sub_agent_run_id/);
  assert.throws(() => queryRecords(dir, "a", "get", ""), /nonempty sub_agent_run_id/);
  assert.throws(() => queryRecords(dir, "a", "list", "b"), /not sub_agent_run_id/);
  assert.throws(() => queryRecords(dir, "a", "list", ""), /not sub_agent_run_id/);
  assert.throws(() => queryRecords(dir, "a", "invalid"), /action must be/);
  assert.throws(() => recordPath(dir, "../../escape"));
  assert.throws(() => new RecordStore(dir, "a", "different-session", 0));
  assert.deepEqual(Object.keys(new RecordStore(dir, "a", "session-a", 0).node.entries), ["b"]);
  // No root file is needed. A missing detail file is explicit, not silently fabricated.
  rmSync(recordPath(dir, "a"));
  assert.deepEqual(queryRecords(dir, "b", "get", "c"), completeLeaf);
  leaf.node.parent_run_id = "unrelated";
  leaf.save();
  assert.throws(() => queryRecords(dir, "b", "get", "c"), /different parent/);
  rmSync(leaf.file);
  assert.deepEqual(queryRecords(dir, "b", "get", "c"), { ...listedChild, detail: null });
  // Old embedded-detail files remain readable without rewriting historical data.
  writeFileSync(
    child.file,
    JSON.stringify({
      ...child.node,
      schema_version: 1,
      entries: { c: completeLeaf },
    }),
  );
  assert.deepEqual(queryRecords(dir, "b", "get", "c"), completeLeaf);
});
