import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { object } from "../config.ts";

export interface Invocation {
  command: string;
  args: string[];
}
export interface ProcessResult {
  exitCode: number | null;
  signal: string | null;
  aborted: boolean;
  error?: string;
  stderr: string;
}

// Reuse the dispatching CLI, including source checkouts and packaged executables.
export function piInvocation(args: string[]): Invocation {
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/root/") && existsSync(script)) {
    return { command: process.execPath, args: [script, ...args] };
  }
  if (!/^(node|bun)(\.exe)?$/i.test(basename(process.execPath)))
    return { command: process.execPath, args };
  return { command: "pi", args };
}

function descendantPids(pid: number): number[] {
  if (process.platform === "win32") return [pid];
  try {
    const rows = execFileSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" })
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number));
    const found = new Set([pid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [child, parent] of rows) {
        if (found.has(parent) && !found.has(child)) {
          found.add(child);
          changed = true;
        }
      }
    }
    return [...found].reverse();
  } catch {
    return [pid];
  }
}

function killPids(pids: number[], signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    const root = pids.at(-1);
    if (root) {
      try {
        execFileSync("taskkill", ["/pid", String(root), "/T", "/F"], { stdio: "ignore" });
      } catch {
        /* Already exited. */
      }
    }
    return;
  }
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      /* Already exited. */
    }
  }
}

/** Separate env/stdout/parser closure for every invocation, including parallel calls. */
export function runProcess(options: {
  invocation: Invocation;
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onEvent: (event: Record<string, unknown>) => void;
  onTick?: () => void;
  onStderr?: (text: string) => void;
  killGraceMs?: number;
}): Promise<ProcessResult> {
  if (options.signal?.aborted)
    return Promise.resolve({ exitCode: null, signal: null, aborted: true, stderr: "" });
  return new Promise((resolve) => {
    const proc = spawn(options.invocation.command, options.invocation.args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buffer = "";
    let stderr = "";
    let error: string | undefined;
    let aborted = false;
    let closed = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let targets: number[] = [];
    let exitCode: number | null = null;
    let exitSignal: string | null = null;

    const finish = () => {
      if (!closed || killTimer) return;
      clearInterval(ticker);
      options.signal?.removeEventListener("abort", abort);
      resolve({ exitCode, signal: exitSignal, aborted, stderr, error });
    };
    const terminate = () => {
      if (killTimer || closed) return;
      targets = proc.pid ? descendantPids(proc.pid) : [];
      killPids(targets, "SIGTERM");
      killTimer = setTimeout(() => {
        killPids(targets, "SIGKILL");
        killTimer = undefined;
        finish();
      }, options.killGraceMs ?? 1000);
    };
    const abort = () => {
      aborted = true;
      terminate();
    };
    const fail = (cause: unknown) => {
      error ??= cause instanceof Error ? cause.message : String(cause);
      terminate();
    };
    const diagnostic = (text: string) => {
      stderr = (stderr + text).slice(-50 * 1024);
      try {
        options.onStderr?.(text);
      } catch (cause) {
        fail(cause);
      }
    };
    const line = (value: string) => {
      if (!value.trim() || error) return;
      let event: unknown;
      try {
        event = JSON.parse(value);
      } catch {
        diagnostic(`\n[non-JSON stdout] ${value}`);
        return;
      }
      if (object(event)) {
        try {
          options.onEvent(event);
        } catch (cause) {
          fail(cause);
        }
      }
    };
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        line(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
      if (buffer.length > 16 * 1024 * 1024) {
        buffer = "";
        fail(new Error("Sub-agent JSON line exceeds 16 MiB"));
      }
    });
    proc.stderr.on("data", diagnostic);
    proc.on("error", fail);
    proc.on("close", (code, signal) => {
      if (buffer.trim()) line(buffer);
      exitCode = code;
      exitSignal = signal;
      closed = true;
      finish();
    });
    const ticker = setInterval(() => {
      try {
        options.onTick?.();
      } catch (cause) {
        fail(cause);
      }
    }, 1000);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}
