// Example scenarios (ADR 2026-031) as an author writes them: every step kind,
// the normal form's nulls left out or written, an execute effect as a command
// still to be read. Nothing here may fail to compile.
import { defineExampleScenarios, type ExampleScenariosJSON } from "bounded/domain";

export const scenarios: ExampleScenariosJSON = defineExampleScenarios({
  scenarios: [
    {
      title: "Every step kind",
      projectFiles: { "plan.md": "the plan\n" },
      steps: [
        { toolUse: { tool: "write", effects: [{ kind: "write", path: "src/a.ts", change: "modify" }] }, verdict: { kind: "refuse", reason: "Not yet", redirect: "Review first" } },
        { toolUse: { role: null, tool: "subagent", effects: [{ kind: "delegate", agent: "reviewer" }], callId: "r1" }, verdict: { kind: "allow" } },
        { toolResult: { tool: "subagent", effects: [{ kind: "delegate", agent: "reviewer" }], callId: "r1", ok: true, delegatedAgentRuns: [{ finished: true, resolvedAgent: "reviewer" }] }, afterToolMessage: null },
        { changeFiles: { "plan.md": "edited\n", "old.md": null } },
        { toolUse: { role: "builder", tool: "shell", effects: [{ kind: "execute", command: "make", cwd: "apps" }] }, verdict: { kind: "allow" } },
        { toolUse: { tool: "search", effects: [{ kind: "list", root: "src", filter: null }, { kind: "read", path: "src" }] }, verdict: { kind: "allow" } },
        { toolResult: { tool: "web", effects: [{ kind: "fetch", url: "https://example.com" }], ok: false }, afterToolMessage: "Fetched nothing" },
      ],
    },
    { title: "No project files", steps: [{ toolUse: { tool: "read", effects: [{ kind: "read", path: "README.md" }] }, verdict: { kind: "allow" } }] },
  ],
});
