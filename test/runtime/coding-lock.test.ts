import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { acquireCodingLock } from "../../src/runtime/coding-lock.ts";

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "router-coding-lock-"));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  const cwd = join(dir, "project");
  mkdirSync(cwd);
  return { cwd, baseDir: join(dir, "locks"), runId: "child", inherited: "[]" };
}

function worker(t: TestContext, cwd: string, base: string) {
  const proc = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("../fixtures/coding-lock.mjs", import.meta.url)),
      cwd,
      base,
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  let stderr = "";
  proc.stderr!.on("data", (chunk) => {
    stderr += chunk;
  });
  const messages: string[] = [];
  const waiters = new Map<string, (() => void)[]>();
  proc.on("message", (message: { type: string }) => {
    messages.push(message.type);
    for (const resolve of waiters.get(message.type) ?? []) resolve();
    waiters.delete(message.type);
  });
  const exited = once(proc, "exit");
  t.after(async () => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    await exited;
  });
  return {
    proc,
    messages,
    exited,
    async wait(type: string) {
      if (messages.includes(type)) return;
      await Promise.race([
        new Promise<void>((resolve) => {
          waiters.set(type, [...(waiters.get(type) ?? []), resolve]);
        }),
        exited.then(() => {
          throw new Error(`Worker exited before ${type}: ${stderr}`);
        }),
      ]);
    },
  };
}

test(
  "independent processes serialize canonical cwd aliases but not different cwd",
  { timeout: 10000 },
  async (t) => {
    const options = setup(t);
    const alias = join(options.cwd, "..", "alias");
    symlinkSync(options.cwd, alias, "dir");
    const first = worker(t, options.cwd, options.baseDir);
    await first.wait("acquired");
    const second = worker(t, alias, options.baseDir);
    await second.wait("waiting");
    assert.ok(!second.messages.includes("acquired"));
    const otherCwd = join(options.cwd, "..", "other");
    mkdirSync(otherCwd);
    const other = worker(t, otherCwd, options.baseDir);
    await other.wait("acquired");
    assert.ok(!second.messages.includes("acquired"));
    first.proc.send("release");
    await second.wait("acquired");
    second.proc.send("release");
    other.proc.send("release");
    await Promise.all([first.exited, second.exited, other.exited]);
    assert.deepEqual(readdirSync(options.baseDir), []);
  },
);

test("waiting cancellation does not release the owner's lock; release is idempotent", async (t) => {
  const options = setup(t);
  const owner = await acquireCodingLock(options);
  const controller = new AbortController();
  const waiting = acquireCodingLock({
    ...options,
    signal: controller.signal,
    onWait: () => controller.abort(),
  });
  await assert.rejects(waiting, /abort/i);
  assert.equal(readdirSync(options.baseDir).length, 1);
  owner.release();
  owner.release();
  const next = await acquireCodingLock(options);
  next.release();
  assert.deepEqual(readdirSync(options.baseDir), []);
});

test("ancestor lock inheritance rejects nested delegation even through cwd aliases", async (t) => {
  const options = setup(t);
  const owner = await acquireCodingLock(options);
  const alias = join(options.cwd, "..", "alias");
  symlinkSync(options.cwd, alias, "dir");
  await assert.rejects(
    acquireCodingLock({ ...options, cwd: alias, inherited: owner.ancestry }),
    /Nested coding delegation/,
  );
  owner.release();
});

test(
  "dead owners fail closed without stealing a possibly orphaned child's lock",
  { timeout: 10000 },
  async (t) => {
    const options = setup(t);
    const dead = worker(t, options.cwd, options.baseDir);
    await dead.wait("acquired");
    dead.proc.kill("SIGKILL");
    await dead.exited;
    await assert.rejects(acquireCodingLock(options), /Stale coding lock/);
    assert.equal(readdirSync(options.baseDir).length, 1);
  },
);
