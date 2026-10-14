import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { object } from "../config.ts";

/** Inherited through all descendants, including non-coding intermediates. */
export const CODING_LOCKS_ENV = "PI_MODEL_ROUTER_CODING_LOCKS";

export interface CodingLease {
  cwd: string;
  ancestry: string;
  release(): void;
}

function ancestorCwds(value: string | undefined): string[] {
  if (value === undefined) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((cwd) => typeof cwd !== "string")) {
    throw new Error("Invalid inherited coding lock ancestry");
  }
  return parsed;
}

function ownerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw error;
  }
}

/** Atomic mkdir serializes independent pi processes as well as sibling dispatches.
 * Never steal stale locks: an orphaned child may still be modifying the working directory.
 */
export async function acquireCodingLock(options: {
  cwd: string;
  runId: string;
  signal?: AbortSignal;
  onWait?: () => void;
  baseDir?: string;
  inherited?: string;
}): Promise<CodingLease> {
  options.signal?.throwIfAborted();
  const cwd = realpathSync(options.cwd);
  const ancestors = ancestorCwds(options.inherited ?? process.env[CODING_LOCKS_ENV]);
  if (ancestors.includes(cwd)) {
    throw new Error(
      `Nested coding delegation shares an ancestor's cwd: ${cwd}; continue in the current coding node`,
    );
  }
  const base = options.baseDir ?? join(homedir(), ".pi", "model-router-locks", "coding");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const dir = join(base, createHash("sha256").update(cwd).digest("hex"));
  const file = join(dir, "owner.json");
  const token = randomUUID();
  let missingSince: number | undefined;
  let nextNotification = 0;
  for (;;) {
    options.signal?.throwIfAborted();
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner: unknown;
      try {
        owner = JSON.parse(readFileSync(file, "utf8"));
      } catch (readError) {
        const code = (readError as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && !(readError instanceof SyntaxError)) throw readError;
        // The owner may be between mkdir and writing metadata, or releasing the lock.
        missingSince ??= Date.now();
        if (Date.now() - missingSince >= 5000) {
          throw new Error(
            `Coding lock metadata unavailable: ${dir}; inspect before manual removal`,
          );
        }
      }
      if (owner !== undefined) {
        missingSince = undefined;
        if (!object(owner) || !Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0) {
          throw new Error(`Invalid coding lock owner: ${file}; inspect before manual removal`);
        }
        if (!ownerAlive(owner.pid as number)) {
          throw new Error(
            `Stale coding lock: ${dir}; verify no orphaned coding process remains before manual removal`,
          );
        }
      }
      if (Date.now() >= nextNotification) {
        options.onWait?.();
        nextNotification = Date.now() + 1000;
      }
      await delay(50, undefined, { signal: options.signal });
      continue;
    }
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, token, runId: options.runId, cwd }), {
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      // An empty, newly acquired directory is ours; never recursively delete unknown contents.
      try {
        rmdirSync(dir);
      } catch {
        /* Leave uncertain ownership for manual inspection. */
      }
      throw error;
    }
    let released = false;
    return {
      cwd,
      ancestry: JSON.stringify([...ancestors, cwd]),
      release() {
        if (released) return;
        const owner: unknown = JSON.parse(readFileSync(file, "utf8"));
        if (!object(owner) || owner.token !== token)
          throw new Error(`Coding lock ownership changed: ${dir}`);
        unlinkSync(file);
        rmdirSync(dir);
        released = true;
      },
    };
  }
}
