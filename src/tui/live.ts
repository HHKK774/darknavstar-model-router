import { stripVTControlCharacters } from "node:util";
import type { LiveUpdate, LiveActionUpdate } from "../runtime/events.ts";
import type { Receipt } from "../runtime/records.ts";
import { actionTitle } from "./action-title.ts";

export interface LiveAction extends LiveActionUpdate {
  heading?: { title: string; showArgs: boolean };
  truncated?: boolean;
}

/** Keep headers separate from rolling tool output. Replay uses an unlimited cap. */
export function appendAction(actions: LiveAction[], update: LiveActionUpdate, maxChars: number) {
  let action = actions.find((item) => item.id === update.id && item.kind === update.kind);
  if (!action) {
    action = { id: update.id, kind: update.kind, text: "" };
    actions.push(action);
  }
  for (const key of ["title", "args"] as const) {
    if (update[key] !== undefined) {
      const value = displayText(update[key]);
      action[key] = value.slice(0, maxChars);
      if (value.length > maxChars) {
        action[key] += "\n[Header shortened; expand to load child record.]";
        action.truncated = true;
      }
    }
  }
  if (update.args !== undefined) {
    // Extract the target before truncating large write/edit argument payloads.
    const heading = actionTitle({ ...action, args: update.args, heading: undefined });
    const title = displayText(heading.title);
    action.heading = { ...heading, title: title.slice(0, maxChars) };
    if (title.length > maxChars) {
      action.heading.title += "… [expand for full action]";
      action.truncated = true;
    }
  }
  if (update.status) action.status = update.status;
  const text = action.text + displayText(update.text);
  if (text.length > maxChars) action.truncated = true;
  action.text = text.slice(-maxChars);
}

export interface LiveTurn {
  actions?: LiveAction[];
  runId: string;
  turn: number;
  text: string;
  truncated?: boolean;
}

export function displayText(text: string): string {
  return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

export interface LiveProgressResult {
  content: { type: "text"; text: string }[];
  details: { receipt: Receipt; live: string; turns: LiveTurn[]; truncated: boolean };
}

/** Per-call, bounded, UI-only memory. Never included in the final tool result or node file. */
export function createLiveProgress(
  update: ((result: LiveProgressResult) => void) | undefined,
  relay?: (activity: LiveUpdate) => void,
  maxChars = 8 * 1024,
) {
  let current: Receipt | undefined;
  let transcript = "";
  let lastRun = "";
  let truncated = false;
  const turns: LiveTurn[] = [];
  const publish = () => {
    if (!current) return;
    const live =
      (truncated ? "[Earlier live output omitted; see child record.]\n" : "") + transcript;
    update?.({
      content: [
        {
          type: "text",
          text: `${current.sub_agent_run_id} | ${current.start_time} | ${current.status}\n${live}`,
        },
      ],
      details: {
        receipt: current,
        live,
        turns: turns.map((turn) => ({
          ...turn,
          ...(turn.actions ? { actions: turn.actions.map((action) => ({ ...action })) } : {}),
        })),
        truncated: turns.some((turn) => turn.truncated),
      },
    });
  };
  return {
    onProgress(receipt: Receipt) {
      current = receipt;
      publish();
    },
    onActivity(activity: LiveUpdate) {
      const text = displayText(activity.text);
      relay?.({ ...activity, text });
      if (!text && !activity.action) return;
      const turnNumber = activity.turn ?? 0;
      let turn = turns.find((item) => item.runId === activity.runId && item.turn === turnNumber);
      if (!turn) {
        turn = { runId: activity.runId, turn: turnNumber, text: "" };
        turns.push(turn);
      }
      if (activity.action) {
        appendAction((turn.actions ??= []), activity.action, maxChars);
        if (turn.actions.some((action) => action.truncated)) turn.truncated = true;
      }
      // Preserve every box with a rolling latest-output preview; never evict another turn.
      if (turn.text.length + text.length > maxChars) turn.truncated = true;
      turn.text = (turn.text + text).slice(-maxChars);
      if (lastRun !== activity.runId) transcript += `\n[${activity.runId}]\n`;
      lastRun = activity.runId;
      transcript += text;
      if (transcript.length > maxChars) {
        transcript = transcript.slice(-maxChars);
        truncated = true;
      }
      publish();
    },
  };
}
