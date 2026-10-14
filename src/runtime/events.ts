import { object, SPAWN_TOOL } from "../config.ts";

export interface LiveActionUpdate {
  id: string;
  kind: "assistant" | "tool";
  title?: string;
  args?: string;
  text: string;
  status?: "running" | "success" | "error";
}

export interface LiveUpdate {
  action?: LiveActionUpdate;
  runId: string;
  text: string;
  /** Zero is startup output; positive numbers are pi agent turns. */
  turn?: number;
}

export function parseLiveAction(value: unknown): LiveActionUpdate | undefined {
  if (
    !object(value) ||
    typeof value.id !== "string" ||
    (value.kind !== "assistant" && value.kind !== "tool") ||
    typeof value.text !== "string" ||
    (value.title !== undefined && typeof value.title !== "string") ||
    (value.args !== undefined && typeof value.args !== "string") ||
    (value.status !== undefined && !["running", "success", "error"].includes(String(value.status)))
  )
    return;
  return {
    id: value.id,
    kind: value.kind,
    text: value.text,
    title: value.title as string | undefined,
    args: value.args as string | undefined,
    status: value.status as LiveActionUpdate["status"],
  };
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!object(part)) return "";
      if (part.type === "text" && typeof part.text === "string") return part.text;
      if (part.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Formats one child's stream, without exposing thoughts or duplicating final streamed text. */
export class LiveFormatter {
  private streamedText = false;
  private toolOutput = new Map<string, string>();

  /** Structured UI metadata accompanies the legacy flat text; never includes reasoning. */
  action(event: Record<string, unknown>, text: string): LiveActionUpdate | undefined {
    if ((event.type === "message_update" || event.type === "message_end") && text) {
      return { id: "assistant", kind: "assistant", text: text.replace(/^\nassistant: /, "") };
    }
    if (typeof event.toolCallId !== "string" || typeof event.toolName !== "string") return;
    const base = { id: event.toolCallId, kind: "tool" as const, title: event.toolName };
    if (event.type === "tool_execution_start") {
      return { ...base, args: JSON.stringify(event.args ?? {}), text: "", status: "running" };
    }
    if (
      event.type === "tool_execution_end" ||
      (event.type === "tool_execution_update" && event.toolName !== SPAWN_TOOL)
    ) {
      const prefix = `\n${event.toolName} ${event.isError ? "error" : "result"}: `;
      return {
        ...base,
        text: text.startsWith(prefix) ? text.slice(prefix.length) : text,
        status:
          event.type === "tool_execution_end" ? (event.isError ? "error" : "success") : "running",
      };
    }
  }

  format(event: Record<string, unknown>): string {
    if (event.type === "message_update" && object(event.assistantMessageEvent)) {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta" && typeof update.delta === "string") {
        const heading = this.streamedText ? "" : "\nassistant: ";
        this.streamedText = true;
        return heading + update.delta;
      }
    }
    if (event.type === "message_end" && object(event.message)) {
      if (event.message.role !== "assistant") return "";
      const text = contentText(event.message.content);
      const result = this.streamedText ? "\n" : text ? `\nassistant: ${text}\n` : "";
      this.streamedText = false;
      return result;
    }
    if (event.type === "tool_execution_start") {
      return `\ntool ${event.toolName}: ${JSON.stringify(event.args ?? {})}\n`;
    }
    if (event.type === "tool_execution_update" || event.type === "tool_execution_end") {
      // Descendant activity is relayed separately, not via a spawn tool's partial transcript.
      if (event.type === "tool_execution_update" && event.toolName === SPAWN_TOOL) return "";
      const value = event.type === "tool_execution_end" ? event.result : event.partialResult;
      if (!object(value)) return "";
      const text = contentText(value.content);
      const id = String(event.toolCallId);
      const previous = this.toolOutput.get(id) ?? "";
      const delta = text.startsWith(previous) ? text.slice(previous.length) : text;
      if (event.type === "tool_execution_end") this.toolOutput.delete(id);
      else this.toolOutput.set(id, text);
      const status = event.isError ? "error" : "result";
      return delta ? `\n${event.toolName} ${status}: ${delta}\n` : "";
    }
    return "";
  }
}
