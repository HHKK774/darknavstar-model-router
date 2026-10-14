import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import { INTERRUPT_COMMAND, registerInterruptCommand } from "../../src/harness/interrupt.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  const calls: string[] = [];
  const sent: string[] = [];
  const notices: string[] = [];
  const children = deferred();
  const idle = deferred();
  let command!: Omit<RegisteredCommand, "name" | "sourceInfo">;
  let pendingMessages = false;
  const pi = {
    registerCommand(name: string, value: typeof command) {
      assert.equal(name, INTERRUPT_COMMAND);
      command = value;
    },
    sendUserMessage(text: string) {
      sent.push(text);
    },
  } as unknown as ExtensionAPI;
  const control = registerInterruptCommand(pi, () => {
    calls.push("cancelChildren");
    return children.promise;
  });
  const ctx = {
    mode: "tui",
    sessionManager: { getSessionId: () => "session" },
    abort: () => calls.push("abort"),
    waitForIdle: () => {
      calls.push("waitForIdle");
      return idle.promise;
    },
    isIdle: () => true,
    hasPendingMessages: () => pendingMessages,
    ui: { notify: (text: string) => notices.push(text) },
  } as unknown as ExtensionCommandContext;
  return {
    calls,
    sent,
    notices,
    children,
    idle,
    control,
    ctx,
    queue() {
      pendingMessages = true;
    },
    run: (text: string) => command.handler(text, ctx),
  };
}

test("interrupt aborts immediately, then waits for cleanup and tool results before resending", async () => {
  const h = setup();
  const work = h.run("  revised request  ");
  assert.deepEqual(h.calls, ["abort", "cancelChildren"]);
  assert.ok(h.control.isPending());
  assert.deepEqual(h.sent, []);
  h.children.resolve();
  await Promise.resolve();
  assert.deepEqual(h.calls, ["abort", "cancelChildren", "waitForIdle"]);
  assert.deepEqual(h.sent, []);
  h.idle.resolve();
  await work;
  assert.deepEqual(h.sent, ["revised request"]);
  assert.equal(h.control.isPending(), false);
});

test("empty input never cancels and duplicate interrupts are explicitly rejected", async () => {
  const h = setup();
  await h.run(" ");
  assert.deepEqual(h.calls, []);
  assert.match(h.notices[0], /Usage/);
  const first = h.run("first");
  await h.run("second");
  assert.match(h.notices.at(-1)!, /already in progress.*not sent/);
  h.children.resolve();
  h.idle.resolve();
  await first;
  assert.deepEqual(h.sent, ["first"]);
});

test("shutdown/session replacement prevents sending captured text to a different session", async () => {
  const h = setup();
  const work = h.run("old request");
  h.control.invalidate();
  h.children.resolve();
  h.idle.resolve();
  await work;
  assert.deepEqual(h.sent, []);
  assert.equal(h.control.isPending(), false);
});

test("idle wait failure never sends a new message and clears pending state", async () => {
  const h = setup();
  h.ctx.waitForIdle = async () => {
    throw new Error("cleanup failed");
  };
  const work = h.run("request");
  h.children.resolve();
  await assert.rejects(work, /cleanup failed/);
  assert.deepEqual(h.sent, []);
  assert.equal(h.control.isPending(), false);
});

test("non-TUI queued input must be cleared explicitly instead of replayed before new instructions", async () => {
  const h = setup();
  h.ctx.mode = "rpc";
  h.queue();
  await h.run("request");
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.sent, []);
  assert.match(h.notices[0], /Clear queued messages/);
});
