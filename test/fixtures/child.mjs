import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

const config = JSON.parse(readFileSync(process.env.PI_MODEL_ROUTER_CHILD_CONFIG, "utf8"));
const task = process.argv.at(-1).replace(/^Task:\n/, "");
const id = process.env.PI_MODEL_ROUTER_RUN_ID;
if (config.runId !== id || config.parentRunId !== process.env.PI_MODEL_ROUTER_PARENT_RUN_ID)
  process.exit(20);
if (task === "crash") {
  process.stderr.write("provider unavailable");
  process.exit(7);
}
const dir = join(config.projectDir, "model-router-trajectory");
mkdirSync(dir, { recursive: true });
const node = {
  schema_version: 2,
  agent_run_id: id,
  parent_run_id: config.parentRunId,
  session_id: `session-${id}`,
  depth: config.depth,
  entries: {},
  detail: { events: [], remaining_context: 777 },
};
const save = () => writeFileSync(join(dir, `${id}.json`), JSON.stringify(node));
save();
const emit = (event) => {
  if (["message_end", "tool_execution_start", "tool_execution_end"].includes(event.type)) {
    node.detail.events.push(event);
    save();
  }
  process.stdout.write(JSON.stringify(event) + "\n");
};
if (task !== "nostart")
  emit({
    type: "model_pool_agent_started",
    payload: { agentRunId: task === "wrong-id" ? "wrong" : id, sessionId: `session-${id}` },
  });
if (task === "hang" || task.startsWith("tree:")) {
  process.on("SIGTERM", () => {});
  if (task.startsWith("tree:")) {
    const grandchild = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],
      { stdio: "ignore" },
    );
    writeFileSync(task.slice(5), String(grandchild.pid));
  }
  setInterval(() => {}, 1000);
} else {
  if (task === "nested") {
    const grandId = `${id}-grand`;
    node.entries[grandId] = {
      agent_run_id: id,
      sub_agent_run_id: grandId,
      task: "grand task",
      status: "success",
      summary: "grand summary",
    };
    save();
    writeFileSync(
      join(dir, `${grandId}.json`),
      JSON.stringify({
        schema_version: 2,
        agent_run_id: grandId,
        parent_run_id: id,
        session_id: `session-${grandId}`,
        depth: config.depth + 1,
        entries: {},
        detail: { events: [{ type: "message_end", text: "GRANDCHILD_PRIVATE_ACTIVITY" }] },
      }),
    );
    emit({
      type: "model_pool_live",
      payload: { agentRunId: id, runId: grandId, text: "GRANDCHILD_PRIVATE_ACTIVITY" },
    });
  }
  emit({ type: "model_pool_budget", payload: { agentRunId: id, remaining: 777 } });
  emit({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "CHILD_INTERMEDIATE_TEXT" },
  });
  const slash = config.modelConfig.model_alias.indexOf("/");
  const assistant = {
    role: "assistant",
    provider: config.modelConfig.model_alias.slice(0, slash),
    model: config.modelConfig.model_alias.slice(slash + 1),
  };
  emit({
    type: "message_end",
    message: {
      ...assistant,
      stopReason: "toolUse",
      content: [{ type: "text", text: "CHILD_INTERMEDIATE_TEXT" }],
    },
  });
  emit({
    type: "tool_execution_start",
    toolCallId: "t",
    toolName: "read",
    args: { path: "test.txt" },
  });
  emit({
    type: "tool_execution_end",
    toolCallId: "t",
    toolName: "read",
    result: { content: [{ type: "text", text: "CHILD_PRIVATE_TOOL_OUTPUT" }] },
    isError: false,
  });
  setTimeout(
    () => {
      const text = JSON.stringify({
        task,
        runId: id,
        tools: config.allowedTools,
        args: process.argv.slice(2),
        note: "动作和结果 🌲",
      });
      const event = {
        type: "message_end",
        message: {
          ...assistant,
          model: task === "wrong-model" ? "wrong-model" : assistant.model,
          stopReason: task === "error" ? "error" : task === "length" ? "length" : "stop",
          errorMessage: task === "error" ? "provider error" : undefined,
          content: [{ type: "text", text }],
        },
      };
      node.detail.events.push(event);
      save();
      // Deliberately split UTF-8 bytes and omit the final newline.
      const bytes = Buffer.from(JSON.stringify(event));
      const split = bytes.indexOf(Buffer.from("🌲")) + 2;
      process.stdout.write(bytes.subarray(0, split));
      setTimeout(() => process.stdout.write(bytes.subarray(split)), 5);
    },
    task === "slow" ? 80 : 5,
  );
}
