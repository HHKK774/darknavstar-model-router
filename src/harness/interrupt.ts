import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const INTERRUPT_COMMAND = "router-interrupt";

/** Command handlers run immediately, unlike steering input. No lifecycle handler waits for idle. */
export function registerInterruptCommand(pi: ExtensionAPI, cancelChildren: () => Promise<unknown>) {
  let pending = false;
  let generation = 0;
  pi.registerCommand(INTERRUPT_COMMAND, {
    description: "Cancel the current run and its children, then send a new user message",
    async handler(args, ctx) {
      const message = args.trim();
      if (!message) {
        ctx.ui.notify(`Usage: /${INTERRUPT_COMMAND} <new message>`, "warning");
        return;
      }
      if (pending) {
        ctx.ui.notify(
          "Interruption is already in progress; this message was not sent. Retry after cleanup.",
          "warning",
        );
        return;
      }
      // TUI abort restores queued messages to the editor. Other modes do not expose queue
      // removal through ExtensionAPI, so refuse rather than replay older queued work first.
      if (ctx.mode !== "tui" && ctx.hasPendingMessages()) {
        ctx.ui.notify(
          "Clear queued messages before using /router-interrupt in non-TUI mode; this message was not sent.",
          "warning",
        );
        return;
      }
      pending = true;
      const current = generation;
      const sessionId = ctx.sessionManager.getSessionId();
      try {
        ctx.abort();
        // Controllers cover both running processes and dispatches waiting for a coding lock.
        // Idle also waits for pi to finalize toolResult messages, not just child exit.
        await cancelChildren();
        await ctx.waitForIdle();
        if (current !== generation || ctx.sessionManager.getSessionId() !== sessionId) {
          return; // Never send a captured request into a replaced session/runtime.
        }
        if (!ctx.isIdle())
          throw new Error("Agent resumed during interruption; new message was not sent");
        pending = false;
        pi.sendUserMessage(message);
      } finally {
        pending = false;
      }
    },
  });
  return {
    isPending: () => pending,
    invalidate() {
      generation++;
    },
  };
}
