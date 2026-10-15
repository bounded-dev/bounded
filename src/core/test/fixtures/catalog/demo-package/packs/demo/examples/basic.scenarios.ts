import { defineExampleScenarios } from "bounded/domain";

export default defineExampleScenarios({
  scenarios: [
    {
      title: "Every tool call is allowed",
      projectFiles: { ".agent-state/plan.md": "the plan\n" },
      steps: [
        { toolUse: { tool: "read", effects: [{ kind: "read", path: ".agent-state/plan.md" }] }, verdict: { kind: "allow" } },
        { toolUse: { tool: "shell", effects: [{ kind: "execute", command: "make build" }], callId: "m1" }, verdict: { kind: "allow" } },
        { toolResult: { tool: "shell", effects: [{ kind: "execute", command: "make build" }], callId: "m1", ok: true }, afterToolMessage: null },
      ],
    },
  ],
});
