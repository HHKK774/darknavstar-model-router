import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

const userText = (message: any): string =>
  typeof message.content === "string"
    ? message.content
    : message.content
        ?.filter((part: any) => part.type === "text")
        .map((part: any) => part.text)
        .join("\n");

test(
  "real pi interrupt cancels running/queued children and sends receipts before the new request",
  { timeout: 30000 },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "router-interrupt-integration-"));
    const home = join(dir, "home");
    const agentDir = join(home, ".pi", "agent");
    const cwd = join(dir, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd);
    const requests: any[] = [];
    const events: any[] = [];
    let closedChildren = 0;
    const server = createServer(async (req, res) => {
      let input = "";
      for await (const chunk of req) input += chunk;
      const body = JSON.parse(input);
      requests.push(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (body.model === "child-model") {
        // Hold the child's provider call open until its process is terminated.
        res.write(": waiting\n\n");
        res.on("close", () => {
          closedChildren++;
        });
        return;
      }
      const resumed = body.messages.some(
        (m: any) => m.role === "user" && userText(m) === "NEW_USER_DIRECTION",
      );
      const calls = ["coding", "coding", "research"].map((category, index) => ({
        index,
        id: `spawn_${index}`,
        type: "function",
        function: {
          name: "darknavstar-spawn-model-pool",
          arguments: JSON.stringify({
            category,
            role: "read-only",
            task: `Inspect task ${index}`,
          }),
        },
      }));
      const chunk = (delta: unknown, finish_reason: string | null) =>
        res.write(
          `data: ${JSON.stringify({
            id: "reply",
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices: [{ index: 0, delta, finish_reason }],
          })}\n\n`,
        );
      chunk(
        resumed
          ? { role: "assistant", content: "Replanned." }
          : { role: "assistant", tool_calls: calls },
        null,
      );
      chunk({}, resumed ? "stop" : "tool_calls");
      res.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    writeFileSync(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          "router-test": {
            baseUrl,
            api: "openai-completions",
            apiKey: "local-test-only",
            models: ["main-model", "child-model"].map((id) => ({
              id,
              contextWindow: 32000,
              maxTokens: 1024,
            })),
          },
        },
      }),
    );
    const config = { model_alias: "router-test/child-model", censored: true, include_tools: [] };
    writeFileSync(
      join(home, ".pi", "model-router.json"),
      JSON.stringify(
        Object.fromEntries(
          ["coding", "research"].map((category) => [
            category,
            { "read-only": { simple: config, medium: config } },
          ]),
        ),
      ),
    );
    const extension = fileURLToPath(new URL("../../darknavstar-model-router.ts", import.meta.url));
    const cli = fileURLToPath(
      new URL(
        "../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
        import.meta.url,
      ),
    );
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ packages: [fileURLToPath(new URL("../../", import.meta.url))] }),
    );
    const proc = spawn(
      process.execPath,
      [
        cli,
        "--offline",
        "--no-extensions",
        "-e",
        extension,
        "--mode",
        "rpc",
        "--no-session",
        "--provider",
        "router-test",
        "--model",
        "main-model",
      ],
      {
        cwd,
        env: {
          ...process.env,
          HOME: home,
          PI_CODING_AGENT_DIR: agentDir,
          PI_OFFLINE: "1",
          PI_TELEMETRY: "0",
          PI_MODEL_ROUTER_CHILD_CONFIG: undefined,
          PI_MODEL_ROUTER_RUN_ID: undefined,
          PI_MODEL_ROUTER_PARENT_RUN_ID: undefined,
          PI_MODEL_ROUTER_CODING_LOCKS: undefined,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const exited = once(proc, "exit");
    let stderr = "";
    let buffer = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (line.trim()) events.push(JSON.parse(line));
      }
    });
    const send = (value: unknown) => proc.stdin.write(JSON.stringify(value) + "\n");
    t.after(async () => {
      if (proc.exitCode === null && proc.signalCode === null) {
        send({ type: "abort" });
        proc.stdin.end();
        const timer = setTimeout(() => proc.kill("SIGKILL"), 5000);
        await exited;
        clearTimeout(timer);
      }
      server.closeAllConnections();
      server.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const wait = async (condition: () => boolean) => {
      for (let n = 0; n < 600; n++) {
        if (condition()) return;
        await delay(20);
      }
      assert.fail(`Timed out: ${stderr}\n${JSON.stringify(events).slice(-6000)}`);
    };
    send({ id: "start", type: "prompt", message: "Delegate three tasks" });
    await wait(
      () =>
        requests.filter((request) => request.model === "child-model").length === 2 &&
        events.some(
          (e) =>
            e.type === "tool_execution_update" &&
            JSON.stringify(e).includes("Waiting for another coding task"),
        ),
    );
    send({
      id: "interrupt",
      type: "prompt",
      message: "/router-interrupt NEW_USER_DIRECTION",
      streamingBehavior: "steer",
    });
    await wait(() => requests.filter((request) => request.model === "main-model").length === 2);
    const next = requests.filter((request) => request.model === "main-model")[1];
    const receipts = next.messages
      .filter((m: any) => m.role === "tool")
      .map((m: any) => JSON.parse(m.content));
    assert.equal(receipts.length, 3);
    assert.ok(receipts.every((result: any) => result.receipt.status === "aborted"));
    assert.ok(receipts.every((result: any) => result.receipt.fallback_to_main_loop));
    assert.ok(
      next.messages.some((m: any) => m.role === "user" && userText(m) === "NEW_USER_DIRECTION"),
      JSON.stringify(next.messages),
    );
    assert.equal(requests.filter((request) => request.model === "child-model").length, 2);
    assert.deepEqual(readdirSync(join(home, ".pi", "model-router-locks", "coding")), []);
    for (const result of receipts) {
      const node = JSON.parse(
        readFileSync(
          join(home, ".pi", "model-router-trajectory", `${result.receipt.agent_run_id}.json`),
          "utf8",
        ),
      );
      const entry = node.entries[result.receipt.sub_agent_run_id];
      assert.equal(entry.status, "aborted");
      assert.ok(entry.end_time);
    }
    await wait(() => closedChildren === 2);
    await wait(() =>
      events.some(
        (e) => e.type === "message_end" && JSON.stringify(e.message).includes("Replanned."),
      ),
    );
    assert.equal(events.find((e) => e.id === "interrupt" && e.type === "response")?.success, true);
  },
);
