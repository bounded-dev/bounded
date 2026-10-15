import { defineExampleScenarios } from "bounded/domain";

export default defineExampleScenarios({
  scenarios: [
    {
      title: "A write is refused; a read and a command are allowed",
      projectFiles: { "README.md": "Read me.\n" },
      steps: [
        { toolUse: { tool: "read", effects: [{ kind: "read", path: "README.md" }] }, verdict: { kind: "allow" } },
        { toolUse: { tool: "shell", effects: [{ kind: "execute", command: "make build", cwd: "apps" }], callId: "m1" }, verdict: { kind: "allow" } },
        { toolResult: { tool: "shell", effects: [{ kind: "execute", command: "make build", cwd: "apps" }], callId: "m1", ok: true }, afterToolMessage: null },
        {
          toolUse: { tool: "write", effects: [{ kind: "write", path: "src/a.ts", change: "create" }] },
          verdict: { kind: "refuse", reason: "refusing-package/refusing refused write (create) src/a.ts: this pack refuses every write", redirect: "Write nothing here" },
        },
      ],
    },
  ],
});
