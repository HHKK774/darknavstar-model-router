# Model router — P0 design

## Scope

A pi extension providing a configurable model mapping, synchronous sub-agent execution,
and browsable execution trajectories.

- The main agent does not choose a concrete model and its model is never switched.
- Querying is independent of dispatch: there is no query-then-select requirement.
- One `(category, role, task_complexity)` tuple maps to exactly one model.
- Dispatch resolves that tuple internally. No router model, candidate ranking, or automatic model substitution.
- Missing mappings, unavailable models, and execution failures return control to the main loop.
- Progress is displayed to the user, not injected into the main model's context.
- Only the receipt and final actions/result summary are returned to the main model by spawn.
- No asynchronous jobs, child-process recovery, separate checkpoint system, or trust gate in P0.

Implementation targets `@earendil-works/pi-coding-agent` 1.2.0 and Node.js 22.19+.
Development dependencies pin the matching pi packages to 1.2.0 to avoid incompatible mixed-version
SDK imports. Update these pins together when upgrading pi.

## Model pool

The user configuration lives at `~/.pi/model-router.json`:

```json
{
  "coding": {
    "read-only": {
      "medium": {
        "model_alias": "your-provider/your-model-id",
        "censored": false,
        "prompt": "Review the code and report your findings."
      }
    }
  }
}
```

Dimensions:

- `category`: configured names, including custom categories such as `review`; no fixed enum.
  Names start with a lowercase letter and contain lowercase letters, digits, hyphens or underscores.
  `constructor` and `prototype` are reserved. Root identity remains `general`; the runtime's
  same-cwd coding lock still applies specifically to `coding`.
- `role`: `read-only`, `read-write`.
- `task_complexity`: `simple`, `medium`, `hard`. `medium` means middle complexity, not fallback.
  Legacy configuration key `default` is accepted as an alias for `medium`; parsed pools and
  query results use `medium`. Both keys in the same category/role branch are a configuration
  conflict, even if their values are identical. Tool query arguments use only the new names.
  Existing trajectory records are not rewritten.

The file is re-read for each query/dispatch; a dispatch retains its configuration snapshot.
A missing file is an empty pool. Invalid configuration is reported, not silently ignored.
No project-level configuration or merge precedence is implemented.

### Category instructions

Each category can contain optional fields `definition` and `parent_responsibility`, each accepting
a string or an array of strings. Arrays are joined with newlines when loaded, preserving whitespace;
empty arrays act like empty strings. Other values, including mixed-type arrays, are rejected.
These fields sit
alongside its role/model mappings. `parent_responsibility` describes the delegating parent's duties
for that child category, including alignment, coordination, and validation as configured:

```json
{
  "coding": {
    "definition": "Implement and investigate repository code.",
    "parent_responsibility": ["Run the project's acceptance suite.", "Report unverified behavior."],
    "read-write": {
      "simple": { "model_alias": "your-provider/your-model-id", "censored": false }
    }
  },
  "research": {
    "definition": "Gather and assess evidence.",
    "parent_responsibility": "Check claims against their cited sources."
  }
}
```

Only categories with at least one configured model mapping contribute definitions and validation
responsibilities to the system prompt. In this example, `research` is valid but dormant: neither
its definition nor its validation responsibility is injected. Empty role/tier maps do not activate
instructions. Activation checks configuration presence, not provider availability; dispatch still
validates the exact route and model. Custom category names are supported end to end in config,
query/spawn schemas and child identity validation; this does not introduce tier fallbacks.

Definitions and parent responsibilities come exclusively from configuration. Omitted or empty
fields contribute no text; there are no built-in category instruction defaults. The former wording
is provided explicitly in `examples/model-router.json` for copying/customization.
The assigned category identity (including root `general`) is still injected independently.
Validation responsibilities remain conditional on the active spawn tool, like the existing delegation
rules. Configuration is reread at `before_agent_start`; changes apply on the next agent run.
Invalid configuration emits a warning and injects no category-specific instructions; model queries
and dispatch still report their usual config errors. Metadata is separated from the model pool,
so query results and dispatch snapshots keep their existing model-mapping shapes.

### ModelConfig

```typescript
interface ModelConfig {
  model_alias: string;
  censored: boolean;
  thinking_level?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  include_tools?: string[];
  exclude_tools?: string[];
  prompt?: string;
}
```

- `model_alias`: exact `${model.provider}/${model.id}` from pi's model registry.
  Custom providers/models remain configured in `~/.pi/agent/models.json`; this extension
  does not store credentials or reimplement provider configuration.
- `censored: true`: the user considers this model **untrusted**. Tasks should be allocated
  more cautiously. This is metadata and tool guidance in P0, not a permission gate.
  A gate may be added later. It does not mean log redaction or content filtering.
- `thinking_level`: optional; defaults to the router's fixed `off`, not pi's saved default.
  Every child launch explicitly passes `--thinking <level>`. This does not change the parent's
  thinking level and is not a spawn tool argument. The provider/model must support the requested
  level; pi's model-specific mapping/clamping still applies, so `off` cannot disable thinking
  on a model that does not support disabling it. Provider compatibility and sampling overrides
  remain configured in pi's `models.json`.
- `prompt`: optional; appended to the child system prompt, not used to replace the pi system prompt.
  When omitted, no configured prompt is appended; the actions/result summary instruction still applies.
- `include_tools` / `exclude_tools`: optional explicit tool configuration.

### Tool resolution

1. With no include list, start from the available tools. `read-only` defaults to removing
   **only** `write` and `edit`; `read-write` removes nothing.
2. An explicit `include_tools` replaces those role defaults. `[]` means no tools.
   Consequently, `include_tools: ["write"]` can enable `write` under `read-only`.
3. Remove `exclude_tools`. Exclusion wins over inclusion. Missing exclusion means remove nothing.
4. For nested dispatch, intersect with the parent's permitted active tools: delegation cannot
   expand the parent's tool set. The main session has no router-imposed ceiling.
5. At depth 4, remove `darknavstar-spawn-model-pool` regardless of configuration.
6. The independent complexity gate removes spawn unless the child tier is `hard`, at any depth.

Unknown included tools fail dispatch. Tools must actually be loaded in the child; automatic
pi extension discovery still applies and this extension is loaded explicitly. Other extensions
passed only through a parent's CLI `-e` are not automatically forwarded.

The child validates and applies its resolved tool set in `before_agent_start`, after all
`session_start` handlers finish, so tools registered asynchronously by other extensions are available.
A genuinely missing tool fails startup before task execution; it is not a model tool-call failure.
A `tool_call` check also blocks disallowed calls. **This is not a sandbox.** Bash, other tools, and extensions can
still modify files or perform external actions. No additional file/network/action restrictions
are imposed by the `read-only` label.

## Tools

### `darknavstar-get-model-pool`

Optional parameters: `category`, `role`, `task_complexity`. No `action` parameter.
Supply a contiguous prefix in that order; lower-level parameters require every parent.

| Arguments                                  | Result                                                       |
| ------------------------------------------ | ------------------------------------------------------------ |
| `{}`                                       | Entire pool: category → role → task_complexity → ModelConfig |
| `{"category":"coding"}`                    | That category's role → task_complexity → ModelConfig map     |
| `{"category":"coding","role":"read-only"}` | That role's task_complexity → ModelConfig map                |
| All three parameters                       | One `ModelConfig`                                            |

Results preserve all configuration fields. An unconfigured branch returns `null`.
An existing empty map returns `{}`; querying all of a missing or empty pool also returns `{}`.
This queries configured mappings, not pi's full provider/model registry.

For example, `{"role":"read-only"}` and `{"category":"coding","task_complexity":"medium"}`
are errors because they skip a parent parameter. Invalid dimension values are also errors.

```json
{ "category": "coding", "role": "read-only", "task_complexity": "medium" }
```

This is a pure query, with no model selection, switching, or spawning.
Calling this tool is not a prerequisite for dispatch.
Large configuration output is capped at 50 KiB / 2000 lines; the full configuration remains
in the configuration file and tool details.

### Complexity scoring

`src/runtime/features.ts` extracts only the selected features; `src/runtime/gate.ts` scores them without I/O,
model calls, or learned classification. Adapted from auto-model-router commit
`b1201850f208ef9e2eb2716b5a1790fdc3310acb`; see `THIRD_PARTY_NOTICES.md`.

Start at **3.0**, add the following, then clamp to **[0, 10]** (not rounded to an integer):

| Feature              | Contribution                                               |
| -------------------- | ---------------------------------------------------------- |
| Task UTF-8 bytes     | >8,000: +0.5; >32,000: +1.0 instead                        |
| `toolCount`          | ≤8: +0; 9–16: +0.3; >16: +0.6                              |
| `lastSpawnFailed`    | +2.6 if the latest completed local spawn has status `fail` |
| `hasNewImage`        | +0.4                                                       |
| `codeBlocks`         | +0.4 per closed triple-backtick block, capped at +0.8      |
| `complexityKeywords` | +1.0 per distinct keyword category, capped at +3.0         |
| `trivialityKeywords` | −0.9 per distinct keyword category, capped at −2.7         |

Non-tool weights match the selected upstream terms scaled from 0–1 to 0–10. Tool-count cutoffs
are fixed calibration constants: 8 pi built-ins (including powershell), 16 currently loaded tools
(8 built-ins + 5 declared + 3 router tools). They are not recomputed from each request's tool count.
The simple cutoff is `(30 + current-tool-band score 3) / 10 = 3.3`, inclusive; hard is strictly
above 7. This keeps neutral tasks with the current tool set in simple.
Upstream's 2k/8k token
thresholds are replaced with 8k/32k byte thresholds (roughly four bytes/token), not a tokenizer.
Keyword patterns are case-insensitive English patterns from upstream, including inflections;
repeating the same category does not add weight. Complexity categories: architecture, refactor,
debug, race, deadlock, why, root cause, design, optimize, security, migrate, concurrency,
invariant, proof. Triviality categories: rename, typo, format, bump, comment, changelog,
add a test, lint. No extra signals (reasoning level, questions, diffs, history length, etc.) apply.

Context is supplied internally, not through spawn arguments:

- Tool count is distinct loaded tool names after inherited ceiling restrictions, before route-
  specific configuration and gating (avoids circular dependence on the selected route).
- Latest completed spawn is selected by end time from this node's entries, before adding the new
  attempt. Running siblings are ignored. Success or user cancellation clears the failure signal;
  failures include missing mapping/startup failures, not just model execution failures.
- New images are detected in the trailing user-message run before the current spawn assistant
  message. Old images behind a completed assistant turn or tool-result continuation do not count.
  This is a parent-input signal only; it does not forward images to the text-only child task.

Examples with 16 tools offered: `rename a typo` → **1.5 / simple**; `Inspect source` →
**3.3 / simple**; `architecture design` after a failed spawn → **7.9 / hard**.
Configure the tiers you want to use; a missing simple/hard mapping does not use medium instead.

### `darknavstar-spawn-model-pool`

Parameters: `category`, `role`, `task`. Complexity is not a spawn argument.

The independent `src/runtime/gate.ts` module runs after the model emits a spawn tool call and before
child execution (not after the completed tool result). `calculateComplexity(task, context)`
returns a numeric heuristic score in 0–10 (see below). `classifyComplexity(score)` maps scores
at or below `3.3` to `simple`, scores strictly above `7` to `hard`, and the rest to `medium`.
The mapped tier selects the exact pool mapping and is stored in the route. An absent tier falls
back to the main loop, not another tier.
For `simple` and `medium`, `gateChildTools` removes `darknavstar-spawn-model-pool` after tool resolution,
even if explicitly included. Dispatch passes the final `allowedTools` to the child. Child startup
and tool-call interception enforce only that allow list, without recalculating gate or depth rules.
Only `hard` children may retain spawn, subject to configuration, depth and inherited permission
limits. Unknown tiers also lose spawn (fail closed). Pool query arguments and configuration retain the complexity dimension.

1. Allocate a child run ID and create an attempt record before starting a process.
2. Resolve the tuple and validate the configured model and tool set.
3. Start a separate pi process in JSON print mode, using the configured provider/model.
4. Pass a per-invocation configuration snapshot and run IDs to that child.
5. Append the optional configured prompt, `Your model-router category is <category>.`,
   and **Write a brief summary of your actions and result in your final response.**
   The category comes from this child's spawn route; role and complexity are not injected.
6. Wait synchronously for completion while displaying progress.
7. Return only `{ receipt, summary }` to the main model.

Category definitions and category-specific parent responsibilities are loaded only from
configuration, and omitted when that category has no model mapping.
Root system prompts also receive `Your model-router category is general.`; they do not receive
the child-only final-summary instruction. Category is injected on each `before_agent_start`.
All nodes receive configured definitions assembled by `configuredInstructions()` in
`src/harness/prompts.ts`, plus shared media-capability guidance. The example config provides:

- `multi-modal`: recognition, generation-tool orchestration, and generated-media validation.
- `coding`: repository investigation, code review, and implementation.
- `research`: information collection, reasoning, mathematics, and summarization.
- `general`: tasks outside these categories; normally the main thread.

Generation requires an explicitly available generation tool. Without one, report the capability
limitation; text descriptions/prompts are not generated media. This does not add a generation API
or attachment transport.

### Delegation instructions

The delegation section assembled by `configuredInstructions()` is appended only when spawn is in the session's actual
active tool set, after child allow-list enforcement. Merely registering the tool or routing a
child to `hard` is not sufficient. Availability is checked on each `before_agent_start`.
The instructions cover:

- Decompose into scoped, verifiable tasks; prioritize by dependencies and importance; assign
  categories. Keep tasks neutral, specific, and limited to necessary context.
- Delegate different-category tasks; handle same-category tasks locally. The main thread
  primarily decomposes, dispatches, validates, and summarizes, but also handles fallback.
- Parallelize independent research/multi-modal work, never dependent work. Same-cwd coding is
  sequential; different-cwd coding may run concurrently when independent.
- Follow `spawn -> collect all children's receipts -> observe -> select the next task set`.
  Inspect status, reason, fallback flag and summary, querying child detail when needed.
- Validate generated media for clarity, recognizable objects, and requested objects. For
  implementations, independently run relevant unit tests and task-defined end-to-end tests.
  Check research against the question and supporting evidence. Never claim unperformed checks
  or assume an isolated sandbox exists.
- Honor cancellation and fallback; notify the user of sandbox/permission blockers. Handle
  missing mappings/unavailable configured models locally when feasible. Turn other execution
  or validation errors, with observations and evidence, into a new research diagnosis task;
  research nodes investigate locally. Avoid blind retries and unbounded diagnosis loops.

Model capability/speed selection remains framework/configuration policy, not a prompt instruction.
These are model behavior instructions, not a runtime batch scheduler or automatic error classifier.
The same-cwd coding constraint is additionally enforced by the runtime lock below.

### Request-local routing reminder

Before each model request, the `context` handler appends `ROUTING_REMINDER` from
`src/harness/prompts.ts` to the request's message copy, only when spawn is actually active.
The request-local text is wrapped in `<router-reminder source="framework">` and identifies itself
as a framework reminder rather than user input. The wrapper does not change its message role.
It asks the model to describe the next action's goal, check context completeness, classify the
fully described goal and delegate across categories, or ask the user for missing context.
The original system-prompt rules are retained.

The reminder is a custom message converted to a user message at the model boundary, not a new
system-level instruction. It is never appended to session history, emitted as a message event,
or accumulated across turns. No assistant-start/turn-end cleanup is needed. It consumes input
tokens for the current request; appending at the end keeps the existing history prefix intact.
Child budget checks still run before injection, and exhausted children abort without a reminder.

### Rerun last spawn

The root-only `/router-rerun-last-spawn [--confirm]` command selects the last spawn on the
current session branch, not the most recent execution in the global trajectory. The session must
be idle with no running children or queued messages. Without `--confirm` it requires a confirmation
dialog warning that repeated side effects are possible. Non-interactive callers must pass `--confirm`.

The selected assistant message may contain multiple spawns and other tool calls. All spawns in
that message are replayed using their individual snapshots; non-spawn tools are not executed again.
Their saved results (including content, details and error flags) are carried onto the new branch.
Missing non-spawn results or invalid snapshots refuse the entire operation before branching.
Records predating replay snapshots are refused: the router does not reconstruct original permissions
or config from current settings. Missing-mapping failures have no resolved execution snapshot and need a fresh
spawn after configuration is fixed.

Replay reuses the execution record's existing `task`, `route` (including computed complexity), and
`model_config`; these are not duplicated inside `snapshot`. Newly resolved spawns store a slim
version-1 `snapshot` with `allowed_tools`, `project_dir`, and optional `instructions` containing
`router_category_prompt` and `router_delegation_prompt`: the rendered router-specific prompt text.
Rerun uses the saved fields even if the pool has since changed. It does not
reclassify complexity, expand the tool list, or choose a replacement model. Current model/tool
availability, permission ceiling, depth, context headroom and coding locks still apply. A different
cwd or a missing required tool is refused. Credentials are read afresh; files, remote resources,
provider state, pi/extension code and other extension prompts are not restored or frozen.

The command navigates without branch summarization to the **original assistant call node**. It
retains all calls and their tool-call IDs, while old spawn results and subsequent messages remain on
the previous branch. Spawns are dispatched concurrently, subject to existing coding locks and other
runtime constraints. Each gets a fresh child run ID and a
`rerun_of: { agent_run_id, sub_agent_run_id }` record link. Old records are never overwritten.
Repeated reruns link to the preceding attempt visible on the selected branch.

Because the public extension API cannot append arbitrary tool-result messages, the new receipt/
summary and each retained non-spawn result are persisted as `darknavstar-rerun-result` custom entries.
The request-local context hook projects each entry to its original call's matching `toolResult`;
no synthetic retry user prompt or old spawn result is sent to the parent model. All results are
published in original call order after the batch settles, with continuation triggered only by the
last publication. Cancellation or an unexpected execution error suppresses automatic continuation;
every call still receives a result, including paired errors for failed executions. Retained results
may be stale relative to repeated side effects; same-message calls are not proof of independence.

This is a router dispatch command, not a generic pi tool-batch replay; it does not replay other
extensions' parent `tool_call` interception. Child execution still goes through its normal tool
permissions and extensions. Live replay progress is UI-only in a temporary widget. During replay,
ordinary input and tree/fork/switch/compaction operations are refused; `/router-interrupt` cancels
tracked children and waits for rerun result delivery before sending its new message.

**Context branching does not undo side effects.** Confirm that the operation is safe to repeat;
partial success or unknown remote outcomes may require a new recovery task instead of a rerun.

### Interrupt and replan

The root registers `/router-interrupt <new message>` as a user command, not a model-callable tool.
Pi executes extension commands immediately even while streaming/tool execution is active.
The command:

1. Captures the new message; empty input only shows usage and does not cancel anything.
2. Calls `ctx.abort()` to stop the parent turn and aborts all locally tracked spawn controllers.
   This covers running child process trees and queued coding dispatches. New spawn attempts that
   arrive during cleanup are pre-cancelled.
3. Waits for dispatch cleanup/receipt persistence, then `ctx.waitForIdle()` so pi has finalized
   corresponding toolResult messages. Existing successful results remain available.
4. Calls `pi.sendUserMessage()` with the captured text to start a new parent turn. Only receipts
   and summaries, not live transcripts, carry child output into this request.

The command is root-only. Ordinary steering/follow-up input is unchanged; it does not implicitly
cancel tasks. Repeated interrupt commands during cleanup are explicitly rejected with a notice;
retry that message afterward. Session shutdown, replacement, or reload invalidates pending delivery
so a captured message is never sent into another session. Cleanup/idle errors prevent resending.
The command takes text; it does not add image-attachment handling.

In TUI mode, pi's abort handler restores earlier queued messages to the editor, without appending
them to the interrupt message. In non-TUI modes, the command refuses if queued messages already
exist: clients must explicitly clear/retrieve their queue first (e.g. RPC `clear_queue`). The
extension API does not expose queue removal, and older queued work must not run ahead of the new
instruction. The command is not registered in child processes.

Cancellation does not roll back file modifications or external side effects. Replanning begins
only after cleanup, not simultaneously with still-running children.

### Coding concurrency

`coding` dispatches acquire a cross-process lock before creating the child process. The key is
its execution cwd resolved with `realpath`, so symlink aliases share a lock. All coding roles
are covered. Same-cwd siblings and independent pi sessions wait until the current coding process
finishes; different cwd values, `research`, `multi-modal`, and `general` are not serialized.
Waiting attempts remain `running`, emit a UI waiting notice and periodic progress, and can be
cancelled without starting a process. The polling wait does not guarantee FIFO ordering.

Locks live under `~/.pi/model-router-locks/coding/<cwd-sha256>/owner.json`, separate from trajectories.
They are released on success, failure, and cancellation, after process termination/cleanup.
`PI_MODEL_ROUTER_CODING_LOCKS` carries held ancestor cwd values through every descendant, including
non-coding intermediates. A coding spawn targeting an ancestor's held cwd returns a fallback
receipt immediately instead of waiting on itself. The current coding node should handle that work.

This coordinates router-managed coding children, not root-local edits or arbitrary external tools.
On abnormal owner-process death, locks are **not automatically stolen**: an orphaned child could
still be writing. Dead-owner or invalid/uninitialized lock metadata produces an explanatory
fallback. Inspect and stop any remaining processes before manually removing that lock directory.
If the OS has reused an owner's PID, the lock may continue waiting; cancellation remains available.
Lock-directory permission errors also return fallback rather than bypassing serialization.

`task` is the explicit delegated context. The parent's conversation is not copied. Normal pi
context-file discovery still applies in the child. P0 takes text tasks; `multi-modal` is a
mapping category, not an attachment-transport implementation.

The final assistant text is the summary. No additional summary model or mandatory structured
summary schema is used. Intermediate assistant messages and tool activity are displayed live and
stored only in the executing child's own trajectory file, never in its parent's entry.
A normal process exit without a completed final assistant message is not success. A successful
execution does not certify that the task's goal was achieved; read the result summary.

Receipt:

```typescript
interface Receipt {
  agent_run_id: string; // Parent node
  sub_agent_run_id: string; // Preallocated child/attempt ID
  start_time: string; // ISO timestamp, attempt creation
  end_time?: string;
  status: "running" | "success" | "fail" | "aborted";
  fallback_to_main_loop: boolean;
  reason?: string;
}
```

On missing mapping, unavailable model, invalid configuration, depth/budget exhaustion,
process launch failure, or model execution failure, return a failure receipt with a short reason.
No alternative model is chosen. The main loop continues normally and handles the task/failure.
Cancellation returns an aborted receipt and stops the process tree on a best-effort basis.
Side effects already performed are not rolled back.

Startup/status updates, streamed assistant text, tool calls, tool results and stderr use the
`onUpdate` callback for live TUI display. Descendant activity is relayed through JSON-only
`model_pool_live` events, with its originating run ID. Status refreshes every second.
Plain progress text (no Startup heading or box) announces child-process startup/loading and, after the validated child-start
handshake, initialization completion. These are UI-only notices; provider/prefill phases are not
tracked and normal agent output is unchanged.
The renderer groups activity by originating run ID and pi `turn_start` boundaries. Each turn
has one enclosing box with explicit borders containing its Turn title, assistant explanation and
tool-call sections. Borders keep turns visually separate even inside pi's same-colored tool panel.
Calls are keyed by `toolCallId` so
parallel calls cannot overwrite each other. Headers show the action target (`read path:start-end`,
`edit/write path`, or `$ command`) and execution status, not opaque call IDs. Full arguments are
available on expansion; unknown tools retain an argument preview. Targets are extracted before
large argument payloads are truncated, so a write's file content cannot hide its destination. Empty final output still updates
status; calls without a completion event are labelled unfinished after spawn exits.

Each action keeps at most 8 Ki characters of its latest output, including assistant messages,
with separately bounded argument headers. Collapsed assistant, tool and Result sections show the
last 10 wrapped screen lines, so streaming assistant previews keep following the latest text.
The limit is applied after terminal wrapping, so single-line JSON cannot bypass it.
Arguments have a separate collapsed preview
of up to 6 lines / 512 characters. Shortened headers and output have expansion hints. All action
and turn boxes are preserved; memory grows with the number of actions/turns, not full result size.
Legacy flat previews retain their bounded 8 Ki-character tails and per-turn fallback rendering.
Pi's tool expansion toggle expands/collapses all these
boxes together; each box computes its own truncation. Receipt/summary is shown separately after
completion. A shortened preview has an explicit notice. On expansion, the renderer lazily reads
the originating node's trajectory to reconstruct that turn's full recorded output. New records
include lightweight `turn_start`/`turn_end` markers; old records infer boundaries from finalized
assistant messages. Disk replay never enters the tool result, live relay, or parent model context.
Missing/corrupt records and in-flight output not yet saved are explicitly indicated. Stderr and
other deliberately unrecorded content cannot be recovered beyond the live preview.
Expanded disk data is cached per rendered component and refreshed when the file changes; collapsing
releases the expanded component/cache. Turn and structured action metadata survive descendant relay. This is display
folding, not deletion from the trajectory file.
The renderer retains it after completion in row-local memory only; it is not restored on reload.
No `sendMessage`, `sendUserMessage`, or persisted custom entry carries live activity.
The final tool result still contains only receipt and summary, with no live transcript.
Raw stderr is live-only; exit code/signal are parent-entry metadata, and child error events
are saved by the child. A child that dies before initialization may have no detail file.

### `darknavstar-get-agent-run-records`

Parameters:

- `action`: required, `list` or `get`.
- `agent_run_id`: required; identifies the node file to read. For `get`, this is the target's
  immediate parent, not necessarily the root.
- `sub_agent_run_id`: required and nonempty for `get`; omit for `list`. Identifies a direct
  child of `agent_run_id`. No trajectory/path parameter is used.
- `offset`, `limit`: optional character paging over the serialized result; maximum 20000 characters per page.

Every entry contains `task`, `status` (`running`, `success`, `fail`, `aborted`), `summary`,
plus identity/receipt/configuration metadata. Descendant indexes are not stored in entries;
the child's own `entries` map is the source of truth for its direct children.
Legacy `sub_agents` fields are ignored on read and removed on subsequent save, not migrated in place.
`get` attaches `detail` from the child's file; new parent entries do not store it. **Summary and detail are separate fields**: summary describes actions and result;
detail contains execution events and diagnostics.

- `list`: return all entries in the specified node file, omitting **only `detail`**. Preserve
  `task`, `status`, `summary`, and all other supported entry metadata. Do not reduce entries
  to a fixed summary projection or recursively flatten descendants.
- `get`: read `entries[sub_agent_run_id]` from the specified node file and return
  **all of its fields, including both `summary` and `detail`**. Reject IDs that are not
  direct children. Read the parent entry and the child's own detail file; no root path is needed.
  Missing child detail returns `detail: null` (for example, a preflight failure). Corrupt files
  and mismatched child ownership are errors. Legacy embedded version-1 detail remains readable.
  `get` without `sub_agent_run_id` is an error, not an implicit list.

For A → B → C, listing A returns B, with no reference to C. List B to discover and inspect C
without detail, or get C directly using the pair B/C. A/C is invalid because C is not A's
direct child. A leaf's own file has no child entries, but contains its own execution detail;
its task/status/summary entry lives in its parent's file.

```json
{ "action": "list", "agent_run_id": "A" }
```

```json
{ "action": "get", "agent_run_id": "A", "sub_agent_run_id": "B" }
```

```json
{ "action": "list", "agent_run_id": "B" }
```

```json
{ "action": "get", "agent_run_id": "B", "sub_agent_run_id": "C" }
```

Large results return `json_chunk` and `next_offset`; concatenate the chunks to reconstruct the
complete JSON result. Paging does not remove fields from either result.

The registered name is `darknavstar-get-agent-run-records`.

## Session and run identity

A pi session has one extension-generated `agentRunId`, stable across turns, `/tree`, reload,
and main-session resume. New sessions/forks get a new ID. The binding includes pi's session ID
and is stored as a custom session entry (not model-visible); copied fork entries do not match
the new session ID. Do not generate a fresh ID on every `agent_start`.

The parent preallocates the child ID and passes it through a dedicated `spawn(..., { env })`
object. It never mutates its own `process.env` to communicate with parallel children.

- `PI_MODEL_ROUTER_RUN_ID`: this child's preallocated ID.
- `PI_MODEL_ROUTER_PARENT_RUN_ID`: its parent ID.
- `PI_MODEL_ROUTER_CHILD_CONFIG`: private temporary JSON snapshot path, removed after completion.

Each invocation owns its stdout parser and closure, so concurrent child events cannot be
associated by accidental arrival order. Children verify the environment against their snapshot.
Each child session binds to the preallocated ID and acknowledges it:

```json
{
  "type": "model_pool_agent_started",
  "payload": { "agentRunId": "child-run-id", "sessionId": "pi-session-id" }
}
```

This event is written only in JSON mode, never into a TUI or unrelated RPC stdout protocol.
The parent checks the returned ID before accepting the start receipt.
A failed attempt that never starts a child session retains its reserved ID without a session binding.

Child processes use `--no-session`: they still have an in-memory pi session and a run ID, but
no persisted child session or recovery behavior. Main-session persistence remains pi's responsibility.

## Trajectory storage

Location: `~/.pi/model-router-trajectory/{agentRunId}.json` for every root and descendant.
Record queries use this same global directory, independent of session cwd. `projectDir` remains
only the execution working directory, passed unchanged to descendants. Starting pi inside the
trajectory directory no longer creates another nested trajectory directory.
Old project-local records are not automatically migrated or searched. To query them, manually
move their node files (including child nodes) to the global directory without overwriting existing
IDs. Existing records already in `~/.pi/model-router-trajectory/` remain readable.

Each process owns exactly its node file. It stores its own execution detail and metadata-only
entries for its **direct** children. The root's execution remains in pi's session; its node's
own detail is empty. New node files use schema version 2:

```typescript
interface NodeRecord {
  schema_version: 2;
  agent_run_id: string;
  parent_run_id?: string;
  session_id: string;
  depth: number;
  detail: { events: unknown[]; remaining_context?: number | null; error?: string };
  entries: Record<string, RunEntry>;
}

interface RunEntry extends Receipt {
  task: string;
  route: { category: string; role: string; task_complexity: string };
  model_config?: ModelConfig;
  summary: string;
  exit_code?: number | null;
  signal?: string | null;
  // No child execution detail here.
}
```

For A → B → C:

- `A.json` contains B's task/status/summary, not B's execution detail or C's identity.
- `B.json` contains B's own `detail` and C's metadata-only entry.
- `C.json` contains C's own `detail` and an empty `entries` map if C is a leaf.

No child-index synchronization event is needed. Each child persists its own finalized messages and tool start/end
events through pi lifecycle handlers. Stream deltas, descendant live updates, and repeated
`agent_end` snapshots are not copied into any ancestor's node file. Record-query outputs are
not recorded again locally, to avoid duplicating the queried node's detail.
Parents consume the stream to display progress and determine status/final summary, without
persisting intermediate assistant text, tool outputs or stderr. Existing version-1 records are
readable and retained in place; historical embedded details are not automatically migrated.

In-memory state is per process. Single-writer synchronous mutations and atomic file replacement
prevent concurrent siblings from overwriting one another's entries. Files use mode 0600.
No cross-process global map or whole-tree rewrite is required.

This is **browsable history**, not tamper-evident auditing. Records can contain sensitive task
and tool data; no automatic redaction or retention policy exists. Abrupt process/host death may
leave entries `running`; there is no automatic recovery or reconciliation in P0.

## Depth, budget and output limits

- Root depth is 0. Maximum depth is 4. A depth-4 node cannot spawn.
- The spawn tool is hidden at that depth and both tool-call and dispatch entry checks enforce it.
- Budget is `context window - current context usage`, independently for each agent.
  Usage comes from pi's context-usage API, not cumulative token/cost totals.
- Unknown context usage remains unknown until pi can report/estimate it.
- The parent refuses dispatch when its remaining budget is zero. A child checks before model
  calls and aborts when its reported/estimated remaining context reaches zero.
- Pi's normal context estimation and compaction behavior remains in effect. This is not an
  exact tokenizer-based preflight guarantee, a cumulative spend cap, or a timeout policy.
- Returned summaries are capped at 50 KiB / 2000 lines and further constrained by a conservative
  remaining-context byte cap. Full summaries remain in the run record. Receipt overhead is not
  included in that approximation. Truncating output does not stop computation or billing.
- Process transport retains the last 50 KiB of stderr and rejects an unterminated JSON line
  larger than 16 MiB to avoid an unbounded parser buffer.

No separate timeout, cost, total-task, or concurrency budget is introduced in P0. Synchronous
spawn calls can still execute concurrently when pi dispatches sibling tools in parallel.

## Deferred

- Trust gate based on `censored`.
- Further prompting policy (renamed from the original `prompt injection` heading).
- Attachment transport for explicit multimodal context.
- Async jobs / wait-and-resume and child-process recovery.
- Additional budget controls, sandboxing, retention/redaction, and crash reconciliation.
