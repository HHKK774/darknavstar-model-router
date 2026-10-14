import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

for (const mixed of [false, true])
  test(
    `real pi rerun replays frozen config and preserves paired results (mixed batch: ${mixed})`,
    { timeout: 30000 },
    async (t) => {
      const dir = mkdtempSync(join(tmpdir(), "router-rerun-integration-"));
      const home = join(dir, "home"),
        agentDir = join(home, ".pi", "agent"),
        cwd = join(dir, "project");
      mkdirSync(agentDir, { recursive: true });
      mkdirSync(cwd);
      const requests: any[] = [],
        events: any[] = [];
      let children = 0;
      let holdChildren = false;
      const server = createServer(async (req, res) => {
        let input = "";
        for await (const chunk of req) input += chunk;
        const body = JSON.parse(input);
        requests.push(body);
        res.writeHead(200, { "content-type": "text/event-stream" });
        const tool = body.messages.find((message: any) => message.role === "tool");
        const child = body.model === "child-model";
        if (child && holdChildren) {
          children++;
          res.write(": waiting for cancellation\n\n");
          return;
        }
        const delta = child
          ? { role: "assistant", content: `CHILD_RESULT_${++children}` }
          : tool
            ? { role: "assistant", content: `PARENT_ANSWER_${children}` }
            : {
                role: "assistant",
                tool_calls: [
                  ...(mixed
                    ? [
                        {
                          index: 0,
                          id: "retained_bash",
                          type: "function",
                          function: {
                            name: "bash",
                            arguments: JSON.stringify({
                              command: "printf x >> executions; printf ORIGINAL_BASH_OUTPUT",
                            }),
                          },
                        },
                      ]
                    : []),
                  {
                    index: mixed ? 1 : 0,
                    id: "original_spawn",
                    type: "function",
                    function: {
                      name: "darknavstar-spawn-model-pool",
                      arguments: JSON.stringify({
                        category: "coding",
                        role: "read-only",
                        task: "Inspect original task",
                      }),
                    },
                  },
                ],
              };
        for (const [data, finish_reason] of [
          [delta, null],
          [{}, child || tool ? "stop" : "tool_calls"],
        ]) {
          res.write(
            `data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: data, finish_reason }] })}\n\n`,
          );
        }
        res.end("data: [DONE]\n\n");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      writeFileSync(
        join(agentDir, "models.json"),
        JSON.stringify({
          providers: {
            "router-test": {
              baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
              api: "openai-completions",
              apiKey: "test",
              models: ["main-model", "child-model"].map((id) => ({
                id,
                contextWindow: 32000,
                maxTokens: 1024,
              })),
            },
          },
        }),
      );
      const configPath = join(home, ".pi", "model-router.json");
      const model = { model_alias: "router-test/child-model", censored: true, include_tools: [] };
      writeFileSync(
        configPath,
        JSON.stringify({
          coding: {
            definition: "ORIGINAL_CATEGORY_DEFINITION",
            "read-only": { simple: model, medium: model },
          },
        }),
      );
      const root = fileURLToPath(new URL("../../", import.meta.url));
      writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [root] }));
      const proc = spawn(
        process.execPath,
        [
          join(root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
          "--offline",
          "--no-extensions",
          "-e",
          join(root, "darknavstar-model-router.ts"),
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
      let stderr = "",
        buffer = "";
      proc.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (chunk) => {
        buffer += chunk;
        let index: number;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
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
        for (let i = 0; i < 600; i++) {
          if (condition()) return;
          await delay(20);
        }
        assert.fail(`Timed out: ${stderr}\n${JSON.stringify(events).slice(-9000)}`);
      };
      send({ id: "initial", type: "prompt", message: "Delegate the inspection" });
      await wait(() => events.some((event) => event.type === "agent_end"));
      const first = requests.filter((request) => request.model === "main-model")[1];
      const oldResult = JSON.parse(
        first.messages.find((message: any) => message.tool_call_id === "original_spawn").content,
      );
      // New routing config must not change the replayed child's model, tools, complexity or instructions.
      writeFileSync(
        configPath,
        JSON.stringify({
          coding: {
            definition: "CHANGED_CATEGORY",
            "read-only": { hard: { ...model, model_alias: "missing/model" } },
          },
        }),
      );
      for (let attempt = 2; attempt <= 3; attempt++) {
        const previousEnds = events.filter((event) => event.type === "agent_end").length;
        send({
          id: `rerun-${attempt}`,
          type: "prompt",
          message: "/router-rerun-last-spawn --confirm",
        });
        await wait(
          () =>
            events.filter((event) => event.type === "agent_end").length > previousEnds &&
            children === attempt,
        );
        const next = requests.filter((request) => request.model === "main-model").at(-1);
        const results = next.messages.filter((message: any) => message.role === "tool");
        assert.equal(results.length, mixed ? 2 : 1);
        const spawnResult = results.find((result: any) => result.tool_call_id === "original_spawn");
        assert.equal(JSON.parse(spawnResult.content).summary, `CHILD_RESULT_${attempt}`);
        if (mixed) {
          assert.equal(readFileSync(join(cwd, "executions"), "utf8"), "x");
          assert.equal(
            results.find((result: any) => result.tool_call_id === "retained_bash").content,
            "ORIGINAL_BASH_OUTPUT",
          );
        }
        assert.doesNotMatch(JSON.stringify(next.messages), /CHILD_RESULT_1|PARENT_ANSWER_/);
        const childRequest = requests.filter((request) => request.model === "child-model").at(-1);
        assert.match(JSON.stringify(childRequest.messages), /ORIGINAL_CATEGORY_DEFINITION/);
        assert.doesNotMatch(JSON.stringify(childRequest.messages), /CHANGED_CATEGORY/);
      }
      const base = join(home, ".pi", "model-router-trajectory");
      const node = JSON.parse(
        readFileSync(join(base, `${oldResult.receipt.agent_run_id}.json`), "utf8"),
      );
      const runs = Object.values(node.entries) as any[];
      assert.equal(runs.length, 3);
      assert.equal(runs[0].summary, "CHILD_RESULT_1");
      assert.equal(runs[1].rerun_of.sub_agent_run_id, runs[0].sub_agent_run_id);
      assert.equal(runs[2].rerun_of.sub_agent_run_id, runs[1].sub_agent_run_id);
      assert.deepEqual(Object.keys(runs[0].snapshot).sort(), [
        "allowed_tools",
        "instructions",
        "project_dir",
        "version",
      ]);
      assert.deepEqual(Object.keys(runs[0].snapshot.instructions).sort(), [
        "router_category_prompt",
        "router_delegation_prompt",
      ]);
      assert.equal(runs[0].snapshot.version, 1);
      assert.equal(runs[1].task, runs[0].task);
      assert.deepEqual(runs[1].route, runs[0].route);
      assert.deepEqual(runs[1].model_config, runs[0].model_config);
      assert.deepEqual(runs[1].snapshot, runs[0].snapshot);
      assert.deepEqual(runs[2].snapshot, runs[0].snapshot);
      assert.equal(new Set(runs.map((run) => run.sub_agent_run_id)).size, 3);

      holdChildren = true;
      send({
        id: "cancelled-rerun",
        type: "prompt",
        message: "/router-rerun-last-spawn --confirm",
      });
      await wait(() => children === 4);
      send({ id: "interrupt-rerun", type: "prompt", message: "/router-interrupt NEW_DIRECTION" });
      await wait(() =>
        requests.some(
          (request) =>
            request.model === "main-model" &&
            JSON.stringify(request.messages).includes("NEW_DIRECTION"),
        ),
      );
      const interrupted = requests.filter((request) => request.model === "main-model").at(-1);
      const interruptedTools = interrupted.messages.filter(
        (message: any) => message.role === "tool",
      );
      assert.equal(interruptedTools.length, mixed ? 2 : 1);
      const abortedTool = interruptedTools.find(
        (message: any) => message.tool_call_id === "original_spawn",
      );
      assert.equal(JSON.parse(abortedTool.content).receipt.status, "aborted");
      if (mixed) assert.equal(readFileSync(join(cwd, "executions"), "utf8"), "x");
      const toolIndex = interrupted.messages.indexOf(abortedTool);
      const userIndex = interrupted.messages.findIndex((message: any) =>
        JSON.stringify(message).includes("NEW_DIRECTION"),
      );
      assert.ok(toolIndex < userIndex);
      const finalNode = JSON.parse(
        readFileSync(join(base, `${oldResult.receipt.agent_run_id}.json`), "utf8"),
      );
      const attempts = Object.values(finalNode.entries) as any[];
      assert.equal(attempts.length, 4);
      assert.equal(attempts[3].status, "aborted");
    },
  );
