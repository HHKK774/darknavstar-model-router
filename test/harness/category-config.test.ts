import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePool, parseRouterConfig, queryPool } from "../../src/config.ts";
import { configuredInstructions } from "../../src/harness/prompts.ts";

const model = { model_alias: "test/model", censored: true };

test("new configured categories supply their own instructions and exact model mappings", () => {
  const config = parseRouterConfig({
    review: {
      definition: "Inspect correctness and risks.",
      parent_responsibility: "Clarify review scope with the user and verify reported issues.",
      "read-only": { hard: model },
    },
  });
  const prompt = configuredInstructions(config);
  assert.match(prompt.router_category_prompt, /review: Inspect correctness and risks/);
  assert.match(prompt.router_delegation_prompt, /Parent responsibilities:/);
  assert.match(prompt.router_delegation_prompt, /review: Clarify review scope with the user/);
  assert.equal(
    queryPool(config.pool, { category: "review", role: "read-only", task_complexity: "hard" }),
    model,
  );
  assert.equal(queryPool(config.pool, { category: "unconfigured" }), null);
});

test("category instructions parse separately without changing mapping/query shapes", () => {
  const input = {
    coding: {
      definition: "Investigate this repository.",
      parent_responsibility: "Run the project's acceptance suite.",
      "read-write": { default: model },
    },
  };
  const before = JSON.stringify(input);
  const config = parseRouterConfig(input);
  assert.equal(config.categories.coding.definition, input.coding.definition);
  assert.equal(config.categories.coding.parent_responsibility, input.coding.parent_responsibility);
  assert.deepEqual(config.pool, { coding: { "read-write": { medium: model } } });
  assert.deepEqual(parsePool(input), config.pool);
  assert.deepEqual(queryPool(config.pool, { category: "coding" }), config.pool.coding);
  assert.equal(JSON.stringify(input), before);
  const prompt = configuredInstructions(config);
  assert.match(prompt.router_category_prompt, /coding: Investigate this repository/);
  assert.match(prompt.router_delegation_prompt, /coding: Run the project's acceptance suite/);
  assert.doesNotMatch(prompt.router_category_prompt, /Code repository investigation/);
  assert.doesNotMatch(prompt.router_delegation_prompt, /run relevant unit tests/);
});

test("metadata-only and empty mappings are dormant, even with complete descriptions", () => {
  const config = parseRouterConfig({
    research: { definition: "DORMANT_DEFINITION", parent_responsibility: "DORMANT_RESPONSIBILITY" },
    "multi-modal": { definition: "ALSO_DORMANT", "read-only": {} },
    coding: { "read-write": { simple: model } },
  });
  const prompt = configuredInstructions(config);
  assert.doesNotMatch(JSON.stringify(prompt), /DORMANT|multi-modal:|research:/);
  assert.doesNotMatch(prompt.router_category_prompt, /coding:|Code repository investigation/);
  assert.doesNotMatch(prompt.router_delegation_prompt, /coding:|run relevant unit tests/);
  assert.doesNotMatch(prompt.router_category_prompt, /general:/);
  assert.ok(config.categories.research); // Retained in parsed config, not loaded into prompts.
});

test("instructions activate when any exact model mapping is added; empty strings omit fields", () => {
  const config = parseRouterConfig({
    research: {
      definition: "CUSTOM_RESEARCH",
      parent_responsibility: "CUSTOM_CHECK",
    },
  });
  assert.doesNotMatch(JSON.stringify(configuredInstructions(config)), /CUSTOM_/);
  config.pool.research = { "read-only": { hard: model } };
  assert.match(configuredInstructions(config).router_category_prompt, /CUSTOM_RESEARCH/);
  assert.match(configuredInstructions(config).router_delegation_prompt, /CUSTOM_CHECK/);
  config.categories.research = { definition: "", parent_responsibility: "" };
  assert.doesNotMatch(
    JSON.stringify(configuredInstructions(config)),
    /research:|Parent responsibilities:/,
  );
});

test("instruction arrays normalize to strings without changing their contents", () => {
  const input = {
    review: {
      definition: ["Inspect correctness.", "  Assess risks."],
      parent_responsibility: ["Clarify scope.", "", "Verify findings."],
      "read-only": { simple: model },
    },
  };
  const before = JSON.stringify(input);
  const config = parseRouterConfig(input);
  assert.deepEqual(config.categories.review, {
    definition: "Inspect correctness.\n  Assess risks.",
    parent_responsibility: "Clarify scope.\n\nVerify findings.",
  });
  assert.equal(JSON.stringify(input), before);
  const prompt = configuredInstructions(config);
  assert.match(prompt.router_category_prompt, /review: Inspect correctness\.\n  Assess risks\./);
  assert.match(prompt.router_delegation_prompt, /review: Clarify scope\.\n\nVerify findings\./);
  const empty = parseRouterConfig({
    review: { definition: [], parent_responsibility: [], "read-only": { simple: model } },
  });
  assert.deepEqual(empty.categories.review, { definition: "", parent_responsibility: "" });
  assert.doesNotMatch(
    JSON.stringify(configuredInstructions(empty)),
    /review:|Parent responsibilities:/,
  );
});

test("instruction fields, category names and roles are validated", () => {
  for (const field of ["definition", "parent_responsibility"]) {
    for (const value of [null, 10, {}, ["valid", 10], [null], [["nested"]]]) {
      assert.throws(() => parseRouterConfig({ coding: { [field]: value } }), /must be a string/);
    }
  }
  for (const name of ["", "bad category", "__proto__", "constructor", "prototype"]) {
    assert.throws(() => parseRouterConfig({ [name]: { definition: "x" } }), /Invalid category/);
  }
  assert.throws(() => parseRouterConfig({ coding: { typo: "x" } }), /Unknown role/);
});
