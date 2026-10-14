import type { CategoryInstructions, RouterConfig } from "../config.ts";

function instructionList(
  categories: Record<string, CategoryInstructions>,
  field: keyof CategoryInstructions,
) {
  return Object.entries(categories)
    .flatMap(([name, value]) => (value[field]?.trim() ? [`- ${name}: ${value[field]}`] : []))
    .join("\n");
}

function categoryInstructions(categories: Record<string, CategoryInstructions>) {
  const definitions = instructionList(categories, "definition");
  return [
    definitions && `Model-router categories:\n${definitions}`,
    `Generate images/videos only through an explicitly available generation tool.
If no suitable tool is available, report the capability limitation.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Descriptions without at least one configured model mapping are dormant. */
export function configuredInstructions(config: RouterConfig) {
  const categories: Record<string, CategoryInstructions> = {};
  for (const [category, roles] of Object.entries(config.pool)) {
    if (Object.values(roles).some((tiers) => Object.keys(tiers).length > 0)) {
      categories[category] = config.categories[category] ?? {};
    }
  }
  return {
    router_category_prompt: categoryInstructions(categories),
    router_delegation_prompt: delegationInstructions(categories),
  };
}

/** Shared routing checklist: embedded in the system prompt and reused as a request-local reminder. */
export const ROUTING_REMINDER = `before you take the next action, answer the following questions:
- What goal does this action aim to complete? Describe it completely.
- Is this description clear with enough context?
  - If yes, what model-router category category does the goal fall into? If it doesn't match your model-router category,
    call darknavstar-spawn-model-pool (unless the user explicitly asked not to).
    Remember that child node doesn't have the context you have, provide necessary context to child node when delegating tasks.
  - If no, what's missing from the context? Identify them, ask user for input about the missing pieces.
    Asking questions is good, guessing is not.`;

/** Inject only when the session's final active tool set includes spawn. */
function delegationInstructions(categories: Record<string, CategoryInstructions>) {
  const responsibilities = instructionList(categories, "parent_responsibility");
  return `Delegation rules:
The main thread primarily decomposes, dispatches, validates, and summarizes work. It's also 
responsible for directly communicate and align with user. 
Stop when you find the user request has been completed. Don't do any work beyong user requests.

Each time after you receive a user message or tool result, ${ROUTING_REMINDER}
When you spawn a task, spawn it in English, but reply to user using the language that matches user's.

${responsibilities ? `Parent responsibilities:\n${responsibilities}\n` : ""}Never claim validation that could not be performed. 
State missing tests or unavailable inspection capabilities explicitly.

Failures and fallback:
- Honor user cancellation; do not turn cancellation into a new task or silently retry it.
- Report sandbox or permission blockers to the user, with the relevant observation.
- Honor fallback receipts. Missing mappings or unavailable configured models are routing
  limitations: handle the task locally when feasible, or report the limitation.
- For other execution or validation errors, attach the observed error, relevant evidence,
  and attempted steps to a new research task for diagnosis. Dispatch it in the next task
  set if its category differs from yours; if you are a research node, investigate locally.
- Use the diagnosis to plan corrective work. Do not blindly repeat failed delegations or
  enter an unbounded diagnosis loop. If no progress is possible, report the blocker.
Continue until all requested work is fulfilled or a blocker requires user input.`;
}
