# darknavstar-model-router

A model router on top of pi that automatically evaluates user messages, classifies tasks and provides stable routing, delegating tasks to configured models as sub-agents on every turn.

## Core ideas

- **Automatic routing:** balance model capability, cost, speed, and privacy while maintaining
  consistency through the same model configuration for tasks in the same domain and complexity tier.
- **Context isolation:** exchange only necessary information between parent and child processes to
  control context growth. Use summaries directly, with the full history available as a fallback.
- **Traceability and recoverable history:** preserve execution history for later review and reuse.
- **Live progress:** follow child responses and tool activity in real time, with expandable execution
  history in the TUI.

## Setup

Requires Node.js 22.19+ and pi 1.x. Developed and tested against pi 1.2.0.

```bash
git clone https://github.com/HHKK774/darknavstar-model-router.git
cd darknavstar-model-router
npm install --ignore-scripts
pi install "$PWD"
```

Alternatively, load the extension for one session:

```bash
pi -e ./darknavstar-model-router.ts
```

### Configure the model pool

Create `~/.pi/model-router.json` using [the example configuration](examples/model-router.json).
Replace model aliases with exact models available in pi and configure authentication through pi.
Do not put credentials in the router configuration.

```json
{
  "coding": {
    "definition": "Implement and investigate repository code.",
    "parent_responsibility": [
      "Clarify task scope before delegation.",
      "Verify the result and report any unverified behavior."
    ],
    "read-write": {
      "simple": {
        "model_alias": "your-provider/your-model-id",
        "censored": false,
        "thinking_level": "low"
      }
    }
  }
}
```

Add mappings for the category, role, and complexity combinations you want to use. Missing mappings
return a fallback receipt for the parent to handle; they do not select another tier or model.

- Category names are configurable. `definition` and `parent_responsibility` accept strings or arrays
  of strings joined with newlines. Instructions activate only for categories with model mappings.
- Roles are `read-only` and `read-write`. Use `include_tools` and `exclude_tools` to customize tools.
- `thinking_level` controls child reasoning independently of the parent; it defaults to `off`.
- Only `hard` children may delegate further, subject to permissions and the maximum depth of 4.

**Tool permissions are not a sandbox.** `read-only` defaults to excluding `write` and `edit`, but
`bash` or other tools may still modify files or external resources.

## Usage

The extension exposes three tools for the agent:

| Tool                                | Purpose                                                                                 |
| ----------------------------------- | --------------------------------------------------------------------------------------- |
| `darknavstar-get-model-pool`        | Query configured mappings, optionally narrowing by category, role, then complexity.     |
| `darknavstar-spawn-model-pool`      | Delegate a task using `category`, `role`, and `task`; the router calculates complexity. |
| `darknavstar-get-agent-run-records` | List a node's direct child runs or retrieve a direct child's execution details.         |

Example spawn arguments:

```json
{
  "category": "coding",
  "role": "read-write",
  "task": "Implement input validation and verify it with focused tests."
}
```

Execution records are stored in `~/.pi/model-router-trajectory/`. They may contain sensitive task and
tool data. Children currently use ephemeral pi sessions: replay starts a new execution, not a resume
of an interrupted process.

### Rerun the last spawn batch

```text
/router-rerun-last-spawn
/router-rerun-last-spawn --confirm
```

Use in an idle root session with no running children or queued messages. The command selects the
last assistant message containing spawns on the current branch and replays all of those spawns from
saved snapshots. Other tools in the same batch are not executed again; their original results are
retained. The parent continues after the batch settles, unless cancelled or an unexpected execution
error prevents continuation.

Old results and subsequent conversation remain on the old branch. Each replay gets a new child run
ID. Every selected spawn needs a valid snapshot, and other calls need saved results.

**Replay does not roll back files or external resources and may repeat side effects.** Review the
operation before confirming. `--confirm` skips the dialog and is required for non-interactive use.

### Interrupt and replan

```text
/router-interrupt <new message>
```

This root-only command cancels the current parent run and its child tasks, waits for cleanup and
result delivery, then sends the new message. Completed and cancelled results remain available;
external side effects are not undone.

See [the usage reference](docs/model-router.md) for configuration options, routing rules, record
queries, and command limitations.

## EVAL

Evaluation methodology and results: coming soon.
