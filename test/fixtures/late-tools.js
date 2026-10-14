// Mirrors declarative-tools: tools are registered asynchronously during session_start.
export default function lateTools(pi) {
  pi.on("session_start", async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (process.env.PI_MODEL_ROUTER_CHILD_CONFIG && process.env.ROUTER_TEST_MISSING_CHILD_TOOL) {
      return;
    }
    pi.registerTool({
      name: "calculator",
      label: "Calculator",
      description: "Test calculator registered after extension initialization.",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: [{ type: "text", text: "CHILD_PRIVATE_TOOL_RESULT=2" }], details: {} };
      },
    });
  });
}
