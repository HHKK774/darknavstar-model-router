import { keyHint, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { object, SPAWN_TOOL } from "../config.ts";
import { displayText, type LiveTurn } from "./live.ts";
import { renderLiveTurns } from "./live-view.ts";

/** Show the full task on its own line, including while call arguments are streaming. */
export const renderSpawnCall: NonNullable<ToolDefinition["renderCall"]> = (args, theme) => {
  const values = object(args) ? args : {};
  const fields = ["category", "role"].flatMap((key) => {
    const value = values[key];
    return typeof value === "string" ? [`${key}=${JSON.stringify(displayText(value))}`] : [];
  });
  const header = theme.fg("toolTitle", [SPAWN_TOOL, ...fields].join(" "));
  const task = typeof values.task === "string" ? displayText(values.task) : undefined;
  return new Text(
    header + (task === undefined ? "" : "\n" + theme.fg("toolOutput", `task: ${task}`)),
    0,
    0,
  );
};

/** Row-local display state stays outside persisted tool results and model context. */
export const renderSpawnResult: NonNullable<ToolDefinition["renderResult"]> = (
  result,
  { isPartial, expanded },
  theme,
  context,
) => {
  if (isPartial && object(result.details) && typeof result.details.live === "string") {
    context.state.live = result.details.live;
    if (Array.isArray(result.details.turns)) {
      context.state.turns = result.details.turns;
      context.state.truncated = result.details.truncated === true;
    }
  }
  const text = result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  if (Array.isArray(context.state.turns)) {
    return renderLiveTurns(
      context.state.turns as LiveTurn[],
      isPartial ? text.split("\n")[0] : "",
      isPartial ? undefined : text,
      context.state.truncated === true,
      expanded,
      theme,
    );
  }
  // Compatibility for older partial updates without structured turn data.
  // Keep completed live output in row-local memory, not the persisted tool result.
  const previous =
    !isPartial && typeof context.state.live === "string" ? context.state.live + "\n" : "";
  const component =
    context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
  const lines = displayText(previous + text).split("\n");
  const visible = expanded ? lines : lines.slice(0, 10);
  const remaining = lines.length - visible.length;
  let output = visible.map((line) => theme.fg("toolOutput", line)).join("\n");
  if (remaining > 0) {
    output +=
      theme.fg("muted", `\n... (${remaining} more lines, `) +
      keyHint("app.tools.expand", "to expand") +
      theme.fg("muted", ")");
  }
  component.setText(output);
  return component;
};
