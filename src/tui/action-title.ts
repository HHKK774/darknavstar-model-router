import { object } from "../config.ts";
import type { LiveAction } from "./live.ts";

/** Human-readable action, independent of tool-call identity and execution state. */
export function actionTitle(action: LiveAction): { title: string; showArgs: boolean } {
  if (action.heading) return action.heading;
  const name = action.title ?? "tool";
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(action.args ?? "{}");
    if (!object(parsed)) return { title: name, showArgs: true };
    args = parsed;
  } catch {
    return { title: name, showArgs: true };
  }
  if ((name === "bash" || name === "powershell") && typeof args.command === "string") {
    return { title: `$ ${args.command}`, showArgs: false };
  }
  if (["read", "edit", "write"].includes(name) && typeof args.path === "string") {
    let range = "";
    if (name === "read") {
      const validLine = (value: unknown): value is number =>
        typeof value === "number" && Number.isSafeInteger(value) && value > 0;
      const start = validLine(args.offset) ? args.offset : 1;
      if (validLine(args.limit)) range = `:${start}-${start + args.limit - 1}`;
      else if (validLine(args.offset)) range = `:${start}`;
    }
    return { title: `${name} ${args.path}${range}`, showArgs: false };
  }
  return { title: name, showArgs: true };
}
