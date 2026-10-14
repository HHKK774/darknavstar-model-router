# darknavstar-model-router

Configured model-pool dispatch and browsable sub-agent execution trajectories for pi.
The main model never changes; queries are independent of dispatch.

## Setup

Requires Node.js 22+ and pi. Developed and tested against `@earendil-works/pi-coding-agent` 0.85.1.

```bash
npm install --ignore-scripts
pi install /absolute/path/to/darknavstar-model-router
```

Alternatively, try without installing into pi settings:

```bash
pi -e ./darknavstar-model-router.ts
```

Create `~/.pi/model-router.json` using [`examples/model-router.json`](examples/model-router.json).
Each category may define `definition` and `parent_responsibility` alongside its model mappings.
Both fields accept a string or an array of strings joined with newlines when loaded.
`parent_responsibility` describes the delegating parent's duties, not just validation.
These instructions are injected only when the category has at least one configured model;
metadata-only categories remain dormant. Omitted fields add no text: there are no built-in category
instruction defaults. Custom category names (e.g. `review`) are supported; the example contains
the former instruction text explicitly.
See [category instructions](docs/model-router.md#category-instructions).
Replace `your-provider/your-model-id` with an exact model from your pi registry and configure
its authentication in pi as usual. Do not put credentials in the model pool.

## Tools

- `darknavstar-get-model-pool(category?, role?, task_complexity?)`: pure query. No arguments returns
  the entire pool; category alone returns its role map; category + role returns its complexity
  map; all three return one config. Unconfigured branches return `null`.
  Parameters must follow that hierarchy: lower-level parameters cannot skip their parents.
- `darknavstar-spawn-model-pool(category, role, task)`: synchronously dispatches to the
  configured model. TUI streams child text, tool calls/results and diagnostics; final model context
  contains only a receipt and actions/result summary.
- `darknavstar-get-agent-run-records(action, agent_run_id, sub_agent_run_id?, offset?, limit?)`:
  `list` returns the specified run's direct-child entries, omitting only `detail`
  (preserving `summary` and other metadata, without descendant indexes). `get` requires a direct child's `sub_agent_run_id`
  and joins its parent entry with `detail` from the child's own file (`null` if unavailable).
  For A → B → C, read C with `agent_run_id: "B", sub_agent_run_id: "C"`; no root path is needed.

All tool names use the `darknavstar-` prefix: colons are rejected by OpenAI/Codex tool-name
validation (`^[a-zA-Z0-9_-]+$`). Display labels retain `[darknavstar]`.
Update any `include_tools` / `exclude_tools` references to old router tool names.
The config path and trajectory format are unchanged.

Example spawn arguments:

```json
{
  "category": "coding",
  "role": "read-only",
  "task": "Inspect the authentication flow and report potential bugs."
}
```

Set `thinking_level` in each model config to control child reasoning:
`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.
For example: `{"model_alias":"openai-codex/gpt-5.6-sol","censored":true,"thinking_level":"low"}`.
Omitted values use the router's fixed `off`; every child receives an explicit `--thinking`,
independent of pi's saved default. Parent thinking is unchanged. Actual support/mapping depends
on the provider and model; a model that cannot disable reasoning may clamp `off` upward.

After the model emits a spawn tool call, `src/runtime/gate.ts` calculates complexity before dispatch.
The score maps to `simple` at 3.3 or below, `hard` strictly above 7, and `medium` otherwise.
Old config keys named `default` are read as `medium`; defining both in one category/role is an
error. This alias does not provide fallback for missing tiers. Pool queries use `medium`.
The calculator uses only task UTF-8 bytes, offered tool count, last completed spawn failure,
new images, fenced code blocks, complexity keywords, and triviality keywords. Its weighted score
is clamped to 0–10; see [scoring details](docs/model-router.md#complexity-scoring).
The `simple` and `medium` tiers remove spawn even if explicitly included in configuration.
Only `hard` may retain spawn, subject to configuration, inherited permissions and depth. Pool queries and
configuration retain the `task_complexity` dimension; callers no longer supply it to spawn.

Missing mappings and execution failures return a fallback receipt for the main loop to handle;
there is no automatic model substitution. `censored: true` marks a model as untrusted, without
an enforced trust gate in P0 (independent of the complexity gate).

`read-only` defaults to disabling only `write/edit`. Explicit include/exclude lists override the
role defaults, exclusion wins, and an empty include list means no tools. This is **not a sandbox**:
`bash` and other tools can still have write or external side effects.

Records are stored only under `~/.pi/model-router-trajectory/`, one file per node,
independent of cwd. Root, children and record queries all use this global directory.
Old project-local records are not automatically migrated or searched.
Each child writes its own execution detail; parents store only child task/status/summary metadata
and child references. Live transcripts stay in TUI memory, not in the parent's record or model
context. New files use schema version 2; legacy version-1 records remain readable. Records may
contain sensitive task/tool data. Child sessions are ephemeral and cannot be recovered.
Maximum depth is 4 (root = 0); budget uses current context-window headroom, not cumulative spend.

Coding children sharing a canonical cwd run sequentially, using a cross-process lock under
`~/.pi/model-router-locks/coding/`. Waiting is cancellable; nested coding delegation to an
ancestor's locked cwd returns fallback to avoid deadlock. Other categories are unaffected.
Abandoned locks fail closed and require inspection before manual removal; see
[coding concurrency](docs/model-router.md#coding-concurrency).

Routing instructions live in `src/harness/prompts.ts`: all sessions receive category definitions
and media capability limits; sessions with spawn enabled also receive task decomposition,
batch delegation, receipt observation, parent validation, diagnosis, and fallback rules.
See [delegation instructions](docs/model-router.md#delegation-instructions).

## Replay the last spawn

Run `/router-rerun-last-spawn` in an idle root session (or add `--confirm` to explicitly
acknowledge repeated side effects without a dialog). It selects the last assistant message containing
spawns on **the current tree branch** and replays all spawns in that batch. Other tools are not
executed again: their original results are carried onto the new branch. The original assistant call
message is retained, every call is paired with a result, and the parent continues after the batch
settles. Old spawn results, subsequent conversation and execution records remain on the old branch.

Reruns reuse the record's original task, route/complexity and model configuration, plus a slim
snapshot of resolved tools, cwd and router category/delegation prompts—not today's pool mapping;
credentials, files, external resources, pi/extensions and provider behavior are **not** snapshotted.
Every attempt gets a new child ID and `rerun_of` link. No rollback or automatic retry is performed.

Every selected spawn must have a saved snapshot, and every non-spawn call must have a saved result.
Older records, missing results, running work and queued input are refused. An unavailable snapshotted tool/model fails rather
than silently substituting another one. See [rerun details](docs/model-router.md#rerun-last-spawn).

## Interrupt and replan

```text
/router-interrupt <new message>
```

This root-only command executes immediately, unlike normal queued input. It cancels the current
parent run and all its spawn attempts (including coding-lock waiters), waits for process cleanup,
lock release and tool-result finalization, then sends your new message to the parent model.
Completed results and aborted receipts remain in context; partial live transcripts do not.
Ordinary Enter/Alt+Enter behavior is unchanged. No file changes or external actions are rolled back.
See [interrupt details](docs/model-router.md#interrupt-and-replan).

## Repository layout

```text
darknavstar-model-router.ts  # pi discovery entry
src/
  config.ts                 # shared configuration, schemas and tool-name constants
  tui/             # live previews, TUI rendering and lazy record replay
  runtime/                  # dispatch, policy, process transport, identity and records
  harness/                  # pi tool registration, lifecycle and child allow-list enforcement
test/
  tui/             # preview/rendering tests
  runtime/                  # configuration, policy, dispatch and record tests
  harness/                  # extension and real pi integration tests
  fixtures/                 # shared subprocess/tool fixtures
```

`harness` connects pi to runtime and tui. Runtime does not import tui or
harness; tui may read runtime records and reuse its event formatter. The public pi
entry and tool contracts are unchanged.

## Development

```bash
npm run check
npm test
```

Tests include concurrent real child processes and a real pi CLI integration against an isolated
local mock provider. They do not require model credentials or call external model APIs.

## Docs

- [`docs/model-router.md`](docs/model-router.md): P0 contracts, configuration, storage, and limitations.

## Ref

~/workplace/pi
