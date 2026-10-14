import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Box,
  Container,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { displayText, type LiveTurn } from "./live.ts";
import { createRecordedTurnLoader } from "./live-records.ts";
import { actionTitle } from "./action-title.ts";
import { readableStructuredText } from "./structured-text.ts";

/** Background-only boxes blend into pi's outer tool panel; draw explicit boundaries. */
function framed(content: Component, theme: Theme): Component {
  return {
    invalidate() {
      content.invalidate();
    },
    render(width) {
      if (width <= 0) return [];
      if (width < 4) return content.render(width).map((line) => truncateToWidth(line, width));
      const innerWidth = width - 2;
      const edge = (text: string) => theme.fg("borderMuted", text);
      return [
        edge(`╭${"─".repeat(innerWidth)}╮`),
        ...content.render(innerWidth).map((line) => {
          const fitted = truncateToWidth(line, innerWidth);
          return (
            edge("│") +
            fitted +
            " ".repeat(Math.max(0, innerWidth - visibleWidth(fitted))) +
            edge("│")
          );
        }),
        edge(`╰${"─".repeat(innerWidth)}╯`),
      ];
    },
  };
}

/** One box per turn, with action sections inside; startup is plain progress text. */
export function renderLiveTurns(
  turns: readonly LiveTurn[],
  status: string,
  summary: string | undefined,
  truncated: boolean,
  expanded: boolean,
  theme: Theme,
): Component {
  const loadTurn = expanded ? createRecordedTurnLoader() : undefined;
  // Rebuild on render so terminal resizing and theme invalidation do not leave stale styling.
  return {
    invalidate() {},
    render(width) {
      if (width <= 0) return [];
      const container = new Container();
      if (status) container.addChild(new Text(theme.fg("muted", displayText(status)), 0, 0));
      if (truncated) {
        container.addChild(
          new Text(
            theme.fg("muted", "[Live previews shortened; expand to load recorded output.]"),
            0,
            0,
          ),
        );
      }
      const addBox = (
        title: string,
        text: string,
        notice?: string,
        latest = false,
        header?: string,
        parent: Pick<Container, "addChild"> = container,
        section = false,
      ) => {
        const box = section
          ? new Container()
          : new Box(1, 0, (line) => theme.bg("toolPendingBg", line));
        if (title) box.addChild(new Text(theme.fg("toolTitle", displayText(title)), 0, 0));
        if (header) {
          const full = displayText(header);
          const shown = expanded ? full : full.split("\n").slice(0, 6).join("\n").slice(0, 512);
          box.addChild(new Text(theme.fg("toolOutput", shown), 0, 0));
          if (shown.length < full.length) {
            box.addChild(
              new Text(
                theme.fg("muted", "[Arguments shortened; ") +
                  keyHint("app.tools.expand", "to expand") +
                  theme.fg("muted", "]"),
                0,
                0,
              ),
            );
          }
        }
        const output = new Text(theme.fg("toolOutput", displayText(text).trim()), 0, 0);
        box.addChild({
          invalidate() {
            output.invalidate();
          },
          render(outputWidth) {
            // Count wrapped terminal rows, not newline-delimited source lines (JSON may be one line).
            const lines = output.render(outputWidth);
            if (expanded || lines.length <= 10) return lines;
            const visible = latest ? lines.slice(-10) : lines.slice(0, 10);
            const hint = new Text(
              theme.fg(
                "muted",
                `... (${lines.length - visible.length} ${latest ? "earlier" : "more"} lines, `,
              ) +
                keyHint("app.tools.expand", "to expand") +
                theme.fg("muted", ")"),
              0,
              0,
            ).render(outputWidth);
            return latest ? [...hint, ...visible] : [...visible, ...hint];
          },
        });
        if (notice) box.addChild(new Text(theme.fg("muted", notice), 0, 0));
        parent.addChild(new Spacer(1));
        parent.addChild(section ? box : framed(box, theme));
      };
      for (const turn of turns) {
        let text = turn.text;
        let actions = turn.actions;
        let notice: string | undefined;
        if (turn.truncated) {
          const recorded = loadTurn?.(turn.runId, turn.turn);
          if (recorded?.text) {
            text = recorded.text;
            if (recorded.actions?.length) {
              actions = actions?.length
                ? actions.map((live) => {
                    const saved = recorded.actions!.find(
                      (item) => item.id === live.id && item.kind === live.kind,
                    );
                    // Do not replace newer streaming output with a stale disk snapshot.
                    const matches = saved && saved.text.endsWith(live.text);
                    return saved && (!status || recorded.complete || matches)
                      ? { ...saved, status: live.status }
                      : live;
                  })
                : recorded.actions;
            }
            notice =
              status && !recorded.complete
                ? "[Recorded output so far; in-flight output may not yet be saved.]"
                : "[Loaded from child record; unrecorded live-only output is not recoverable.]";
          } else {
            notice = expanded
              ? "[Full recorded output unavailable or not yet saved; showing live preview.]"
              : "[Live preview shortened; " +
                keyHint("app.tools.expand", "to load child record") +
                "]";
          }
        }
        // Startup includes unstructured lifecycle notices as well as possible stderr.
        if (turn.turn === 0) {
          addBox("", text, notice, true, undefined, container, true);
          continue;
        }
        const title = `[${turn.runId}] Turn ${turn.turn}`;
        if (actions?.length) {
          const turnBox = new Box(1, 0, (line) => theme.bg("toolPendingBg", line));
          turnBox.addChild(new Text(theme.fg("toolTitle", title), 0, 0));
          container.addChild(new Spacer(1));
          container.addChild(framed(turnBox, theme));
          for (const action of actions) {
            const state = action.status === "running" && !status ? "unfinished" : action.status;
            const heading = actionTitle(action);
            const shortTitle = expanded
              ? heading.title
              : heading.title.split("\n").slice(0, 6).join("\n").slice(0, 512);
            const label =
              shortTitle +
              (shortTitle.length < heading.title.length ? "… [Action shortened; expand]" : "");
            const readable = (text: string) =>
              action.kind === "tool" && action.title === "codemode"
                ? readableStructuredText(text)
                : text;
            addBox(
              action.kind === "assistant"
                ? (action.title ?? "assistant")
                : `${label} · ${state ?? "unknown"}`,
              readable(action.text),
              action.truncated ? notice : undefined,
              true,
              action.kind === "tool" && (expanded || heading.showArgs) && action.args
                ? readable(action.args)
                : undefined,
              turnBox,
              true,
            );
          }
          if (notice && !actions.some((action) => action.truncated)) {
            turnBox.addChild(new Text(theme.fg("muted", notice), 0, 0));
          }
          continue;
        }
        addBox(title, text, notice, true);
      }
      if (summary !== undefined) addBox("Result", summary, undefined, true);
      return container.render(width);
    },
  };
}
