import { statSync } from "node:fs";
import { object } from "../config.ts";
import { LiveFormatter } from "../runtime/events.ts";
import { appendAction, type LiveAction } from "./live.ts";
import { readNode, recordPath, trajectoryBaseDir } from "../runtime/records.ts";

export interface RecordedTurn {
  actions?: LiveAction[];
  text: string;
  complete: boolean;
}

/** UI-only, lazy disk replay. Each expanded component owns its cache; collapse releases it. */
export function createRecordedTurnLoader(baseDir = trajectoryBaseDir()) {
  const cache = new Map<string, { stamp: string; turns: Map<number, RecordedTurn> }>();
  return (runId: string, wanted: number): RecordedTurn | undefined => {
    try {
      const stat = statSync(recordPath(baseDir, runId));
      const stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
      let cached = cache.get(runId);
      if (!cached || cached.stamp !== stamp) {
        const events = readNode(baseDir, runId).detail?.events ?? [];
        const marked = events.some((event) => object(event) && event.type === "turn_start");
        const formatter = new LiveFormatter();
        const turns = new Map<number, RecordedTurn>();
        let number = 0;
        for (const event of events) {
          if (!object(event)) continue;
          if (
            marked
              ? event.type === "turn_start"
              : event.type === "message_end" &&
                object(event.message) &&
                event.message.role === "assistant"
          )
            number++;
          const text = formatter.format(event);
          const action = formatter.action(event, text);
          if (text || action || event.type === "turn_end") {
            const turn: RecordedTurn = turns.get(number) ?? { text: "", complete: false };
            turn.text += text;
            if (action) appendAction((turn.actions ??= []), action, Infinity);
            if (event.type === "turn_end") turn.complete = true;
            turns.set(number, turn);
          }
        }
        cached = { stamp, turns };
        cache.set(runId, cached);
      }
      return cached.turns.get(wanted);
    } catch {
      // Missing/corrupt/inaccessible records must not break rendering or invent full output.
      cache.delete(runId);
      return undefined;
    }
  };
}
