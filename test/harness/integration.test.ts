import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runProcess } from "../../src/runtime/runner.ts";
import { queryRecords, type CompleteRunEntry } from "../../src/runtime/records.ts";
import { createRecordedTurnLoader } from "../../src/tui/live-records.ts";
import { ROUTING_REMINDER } from "../../src/harness/prompts.ts";
import { parsePool } from "../../src/config.ts";

// Real pi CLI + real child pi processes; only the provider is a local deterministic SSE server.
// HOME/config are isolated. This test never calls an external model or uses real credentials.
for (const { missingChildTool, thinkingLevel } of [
  { missingChildTool: false, thinkingLevel: "low" },
  { missingChildTool: false, thinkingLevel: undefined },
  { missingChildTool: true, thinkingLevel: "low" },
] as const) {
  test(
    missingChildTool
      ? "real pi: missing child tools fail before any child provider request"
      : `real pi: parallel children use ${thinkingLevel ?? "off"} thinking and isolated summaries`,
    { timeout: 60000 },
    async (t) => {
      const home = mkdtempSync(join(tmpdir(), "router-integration-"));
      t.after(() => rmSync(home, { recursive: true, force: true }));
      const project = join(home, "project");
      const agentDir = join(home, ".pi", "agent");
      mkdirSync(project, { recursive: true });
      mkdirSync(agentDir, { recursive: true });
      const delegatedTools = [
        "calculator",
        "darknavstar-get-model-pool",
        "darknavstar-spawn-model-pool",
        "darknavstar-get-agent-run-records",
      ];
      const requests: any[] = [];
      const server = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString());
        requests.push(body);
        const invalidTool = body.tools?.find(
          (tool: any) => !/^[a-zA-Z0-9_-]+$/.test(tool.function.name),
        );
        if (invalidTool) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              error: { message: `Invalid tool name: ${invalidTool.function.name}` },
            }),
          );
          return;
        }
        const isMain = body.model === "main-model";
        const hasResults = body.messages.some((message: any) => message.role === "tool");
        const toolCalls = ["first", "second"].map((task, index) => ({
          index,
          id: `call_${index}`,
          type: "function",
          function: {
            name: "darknavstar-spawn-model-pool",
            arguments: JSON.stringify({
              category: "coding",
              role: "read-only",
              task,
            }),
          },
        }));
        toolCalls.push(
          ...[
            {},
            {
              category: "coding",
              role: "read-only",
              task_complexity: "medium",
            },
            {
              category: "research",
              role: "read-only",
              task_complexity: "medium",
            },
            { category: "coding" },
            { category: "coding", role: "read-only" },
            { role: "read-only" },
            { category: "coding", task_complexity: "medium" },
          ].map((args, index) => ({
            index: index + 2,
            id: `pool_${index}`,
            type: "function",
            function: { name: "darknavstar-get-model-pool", arguments: JSON.stringify(args) },
          })),
        );
        const needsTool = !hasResults;
        const responseCalls = isMain
          ? toolCalls
          : [
              {
                index: 0,
                id: "child_calculator",
                type: "function",
                function: { name: "calculator", arguments: "{}" },
              },
            ];
        res.writeHead(200, { "content-type": "text/event-stream" });
        const emit = (choices: unknown[], usage?: unknown) =>
          res.write(
            `data: ${JSON.stringify({
              id: "completion",
              object: "chat.completion.chunk",
              created: 1,
              model: body.model,
              choices,
              usage,
            })}\n\n`,
          );
        emit([
          {
            index: 0,
            delta: needsTool
              ? {
                  role: "assistant",
                  content: isMain ? undefined : "CHILD_INTERMEDIATE_TEXT",
                  tool_calls: responseCalls,
                }
              : {
                  role: "assistant",
                  content: isMain
                    ? "Main loop done."
                    : "Actions: inspected the task. Result: complete.",
                },
            finish_reason: null,
          },
        ]);
        emit([{ index: 0, delta: {}, finish_reason: needsTool ? "tool_calls" : "stop" }]);
        emit([], { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
        res.end("data: [DONE]\n\n");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      t.after(() => {
        server.closeAllConnections();
        server.close();
      });
      const port = (server.address() as { port: number }).port;
      writeFileSync(
        join(agentDir, "models.json"),
        JSON.stringify({
          providers: {
            "router-test": {
              baseUrl: `http://127.0.0.1:${port}/v1`,
              api: "openai-completions",
              apiKey: "local-test-only",
              models: ["main-model", "child-model"].map((id) => ({
                id,
                reasoning: true,
                contextWindow: 32000,
                maxTokens: 1024,
              })),
            },
          },
        }),
      );
      writeFileSync(
        join(home, ".pi", "model-router.json"),
        JSON.stringify({
          research: {
            definition: "DORMANT_CATEGORY_SENTINEL",
            parent_responsibility: "DORMANT_CHECK_SENTINEL",
          },
          coding: {
            definition: "CONFIGURED_CODING_DEFINITION",
            parent_responsibility: "CONFIGURED_CODING_VALIDATION",
            "read-only": Object.fromEntries(
              ["simple", "medium"].map((tier) => [
                tier,
                {
                  model_alias: "router-test/child-model",
                  censored: true,
                  thinking_level: thinkingLevel,
                  include_tools: delegatedTools,
                  prompt: "CHILD_CONFIG_PROMPT",
                },
              ]),
            ),
          },
        }),
      );
      const cli = fileURLToPath(
        new URL(
          "../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
          import.meta.url,
        ),
      );
      const extension = fileURLToPath(
        new URL("../../darknavstar-model-router.ts", import.meta.url),
      );
      // Children discover the installed package and also receive -e: both must resolve to one entry.
      const packageDir = fileURLToPath(new URL("../../", import.meta.url));
      const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
      assert.equal(manifest.name, "darknavstar-model-router");
      assert.deepEqual(manifest.pi.extensions, ["./darknavstar-model-router.ts"]);
      const lateTools = fileURLToPath(new URL("../fixtures/late-tools.js", import.meta.url));
      writeFileSync(
        join(agentDir, "settings.json"),
        JSON.stringify({
          packages: [packageDir],
          extensions: [lateTools],
          defaultThinkingLevel: "high",
        }),
      );
      const events: Record<string, unknown>[] = [];
      const result = await runProcess({
        invocation: {
          command: process.execPath,
          args: [
            cli,
            "--offline",
            "--no-extensions",
            "-e",
            extension,
            "-e",
            lateTools,
            "--mode",
            "json",
            "-p",
            "--no-session",
            "--provider",
            "router-test",
            "--model",
            "main-model",
            "--tools",
            delegatedTools.join(","),
            "MAIN_ONLY_PRIVATE_CONTEXT: delegate two tasks",
          ],
        },
        cwd: project,
        env: {
          ...process.env,
          HOME: home,
          PI_CODING_AGENT_DIR: agentDir,
          PI_OFFLINE: "1",
          PI_TELEMETRY: "0",
          PI_MODEL_ROUTER_CHILD_CONFIG: undefined,
          PI_MODEL_ROUTER_RUN_ID: undefined,
          PI_MODEL_ROUTER_PARENT_RUN_ID: undefined,
          ROUTER_TEST_MISSING_CHILD_TOOL: missingChildTool ? "1" : undefined,
        },
        signal: AbortSignal.timeout(45000),
        onEvent: (event) => {
          events.push(event);
        },
      });
      assert.equal(
        result.exitCode,
        0,
        `${result.error ?? ""}\n${result.stderr}\n${JSON.stringify(events)}`,
      );
      assert.doesNotMatch(result.stderr, /Failed to load extension|Error/);
      assert.equal(requests.filter((request) => request.model === "main-model").length, 2);
      for (const request of requests) {
        const wire = JSON.stringify(request.messages);
        assert.match(wire, /CONFIGURED_CODING_DEFINITION/);
        assert.doesNotMatch(wire, /DORMANT_CATEGORY_SENTINEL|DORMANT_CHECK_SENTINEL/);
        if (request.model === "main-model") assert.match(wire, /CONFIGURED_CODING_VALIDATION/);
        else assert.doesNotMatch(wire, /CONFIGURED_CODING_VALIDATION/);
        const reminders = request.messages.filter((message: any) => {
          const text =
            typeof message.content === "string"
              ? message.content
              : message.content
                  ?.filter((part: any) => part.type === "text")
                  .map((part: any) => part.text)
                  .join("\n");
          if (message.role !== "user" || !text?.includes('<router-reminder source="framework">'))
            return false;
          assert.match(text, /^\s*<router-reminder source="framework">/);
          assert.match(text, /This is a reminder from the framework, not user\./);
          assert.ok(text.includes(ROUTING_REMINDER));
          assert.match(text, /<\/router-reminder>\s*$/);
          return true;
        });
        // Both root requests have exactly one ephemeral reminder; gated children have none.
        assert.equal(reminders.length, request.model === "main-model" ? 1 : 0);
        if (reminders.length) assert.equal(request.messages.at(-1), reminders[0]);
      }
      assert.ok(
        !events.some(
          (event: any) =>
            event.type === "message_end" &&
            event.message?.customType === "darknavstar-routing-reminder",
        ),
      );
      const children = requests.filter((request) => request.model === "child-model");
      assert.equal(
        children.length,
        missingChildTool ? 0 : 4,
        result.stderr +
          JSON.stringify(events.filter((event) => event.type === "tool_execution_end")),
      );
      for (const request of children) {
        assert.equal(request.reasoning_effort, thinkingLevel);
        const context = JSON.stringify(request.messages);
        assert.ok(!context.includes("MAIN_ONLY_PRIVATE_CONTEXT"));
        assert.match(context, /CHILD_CONFIG_PROMPT/);
        assert.match(context, /brief summary of your actions and result/);
        assert.match(context, /only through an explicitly available generation tool/);
        assert.match(context, /report the capability limitation/);
        assert.deepEqual(
          request.tools?.map((tool: any) => tool.function.name).sort(),
          delegatedTools.filter((name) => name !== "darknavstar-spawn-model-pool").sort(),
        );
      }
      const mainFinal = requests.filter((request) => request.model === "main-model").at(-1);
      assert.equal(mainFinal.reasoning_effort, "high", "parent thinking must not change");
      assert.doesNotMatch(JSON.stringify(mainFinal.messages), /CHILD_INTERMEDIATE|CHILD_PRIVATE/);
      const toolResults = mainFinal.messages.filter((message: any) => message.role === "tool");
      const poolResult = (index: number) =>
        JSON.parse(
          toolResults.find((message: any) => message.tool_call_id === `pool_${index}`).content,
        );
      const expectedPool = parsePool(
        JSON.parse(readFileSync(join(home, ".pi", "model-router.json"), "utf8")),
      );
      assert.deepEqual(poolResult(0), expectedPool);
      assert.deepEqual(poolResult(1), expectedPool.coding["read-only"].medium);
      assert.equal(poolResult(2), null);
      assert.deepEqual(poolResult(3), expectedPool.coding);
      assert.deepEqual(poolResult(4), expectedPool.coding["read-only"]);
      for (const index of [5, 6]) {
        const error = toolResults.find((message: any) => message.tool_call_id === `pool_${index}`);
        assert.match(error.content, /requires category/);
      }
      const results = toolResults
        .filter((message: any) => message.tool_call_id.startsWith("call_"))
        .map((message: any) => JSON.parse(message.content));
      assert.equal(results.length, 2);
      assert.equal(new Set(results.map((value: any) => value.receipt.sub_agent_run_id)).size, 2);
      for (const value of results) {
        assert.deepEqual(Object.keys(value).sort(), ["receipt", "summary"]);
        if (missingChildTool) {
          assert.equal(value.receipt.status, "fail", JSON.stringify(value));
          assert.equal(value.receipt.fallback_to_main_loop, true);
          assert.match(
            value.receipt.reason,
            /before task execution: tool is not loaded: calculator/,
          );
          assert.equal(value.summary, "");
        } else {
          assert.equal(value.receipt.status, "success", JSON.stringify(value));
          assert.equal(value.summary, "Actions: inspected the task. Result: complete.");
        }
      }
      assert.ok(events.some((event) => event.type === "tool_execution_update"));
      const files = readdirSync(join(home, ".pi", "model-router-trajectory")).filter((file) =>
        file.endsWith(".json"),
      );
      assert.equal(existsSync(join(project, "model-router-trajectory")), false);
      assert.equal(files.length, 3); // Main node + two child nodes, including empty leaf files.
      const nodes = files.map((file) =>
        JSON.parse(readFileSync(join(home, ".pi", "model-router-trajectory", file), "utf8")),
      );
      const parent = nodes.find((node) => Object.keys(node.entries).length === 2);
      assert.ok(parent);
      assert.doesNotMatch(JSON.stringify(parent), /CHILD_INTERMEDIATE|CHILD_PRIVATE/);
      const liveUpdates = JSON.stringify(
        events.filter((event) => event.type === "tool_execution_update"),
      );
      if (!missingChildTool) {
        assert.match(liveUpdates, /CHILD_INTERMEDIATE_TEXT/);
        assert.match(liveUpdates, /CHILD_PRIVATE_TOOL_RESULT/);
        for (const result of results) {
          const childId = result.receipt.sub_agent_run_id;
          const turns = events
            .filter((event) => event.type === "tool_execution_update")
            .flatMap((event) => (event.partialResult as any)?.details?.turns ?? [])
            .filter((turn: any) => turn.runId === childId);
          assert.ok(
            turns.some(
              (turn: any) => turn.turn === 1 && turn.text.includes("CHILD_PRIVATE_TOOL_RESULT"),
            ),
          );
          assert.ok(
            turns.some(
              (turn: any) => turn.turn === 2 && turn.text.includes("Actions: inspected the task"),
            ),
          );
          assert.ok(
            turns.some((turn: any) =>
              turn.actions?.some(
                (action: any) =>
                  action.kind === "tool" &&
                  action.title === "calculator" &&
                  action.status === "success" &&
                  action.text.includes("CHILD_PRIVATE_TOOL_RESULT"),
              ),
            ),
          );
          const entry = parent.entries[childId];
          assert.equal(entry.detail, undefined);
          const own = nodes.find((node) => node.agent_run_id === childId);
          assert.match(JSON.stringify(own.detail), /CHILD_INTERMEDIATE_TEXT/);
          assert.match(JSON.stringify(own.detail), /CHILD_PRIVATE_TOOL_RESULT/);
          const loadTurn = createRecordedTurnLoader(join(home, ".pi"));
          assert.match(loadTurn(childId, 1)!.text, /CHILD_PRIVATE_TOOL_RESULT/);
          assert.equal(loadTurn(childId, 1)!.complete, true);
          assert.match(loadTurn(childId, 2)!.text, /Actions: inspected the task/);
          assert.equal(loadTurn(childId, 2)!.complete, true);
          const complete = queryRecords(
            join(home, ".pi"),
            parent.agent_run_id,
            "get",
            childId,
          ) as CompleteRunEntry;
          assert.deepEqual(complete.detail, own.detail);
        }
      }
    },
  );
}
