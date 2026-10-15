import { defineExampleScenarios } from "bounded/domain";

export default defineExampleScenarios({
  scenarios: [
    {
      title: "A review of the current spec and contracts lets test-writer run; changing a contract or the spec makes it stale",
      projectFiles: { "spec.md": "the spec\n", "src/a.contract.ts": "export interface A {}\n" },
      steps: [
        {
          toolUse: { tool: "subagent", effects: [{ kind: "delegate", agent: "test-writer" }], callId: "t1" },
          verdict: { kind: "refuse", reason: "bounded/prereqs.rules: bounded/project's rule before delegating to 'test-writer' requires a delegation to spec-reviewer that succeeded over the current 'spec.md', 'src/**/*.contract.ts', and spec-reviewer has not succeeded over them. This call would delegate to test-writer", redirect: "Have spec-reviewer review the current spec and contracts" },
        },
        { toolUse: { tool: "write", effects: [{ kind: "write", path: "src/a.ts", change: "create" }] }, verdict: { kind: "allow" } },
        { toolUse: { tool: "subagent", effects: [{ kind: "delegate", agent: "spec-reviewer" }], callId: "r1" }, verdict: { kind: "allow" } },
        {
          toolResult: { tool: "subagent", effects: [{ kind: "delegate", agent: "spec-reviewer" }], callId: "r1", ok: true, delegatedAgentRuns: [{ finished: true, resolvedAgent: "spec-reviewer" }] },
          afterToolMessage: null,
        },
        { toolUse: { tool: "subagent", effects: [{ kind: "delegate", agent: "test-writer" }], callId: "t2" }, verdict: { kind: "allow" } },
        { changeFiles: { "src/a.contract.ts": "export interface A { readonly a: number }\n" } },
        {
          toolUse: { tool: "subagent", effects: [{ kind: "delegate", agent: "test-writer" }], callId: "t3" },
          verdict: { kind: "refuse", reason: "bounded/prereqs.rules: bounded/project's rule before delegating to 'test-writer' requires a delegation to spec-reviewer that succeeded over the current 'spec.md', 'src/**/*.contract.ts', and spec-reviewer succeeded over them, but they have changed since. This call would delegate to test-writer", redirect: "Have spec-reviewer review the current spec and contracts" },
        },
        { toolUse: { tool: "subagent", effects: [{ kind: "delegate", agent: "spec-reviewer" }], callId: "r2" }, verdict: { kind: "allow" } },
        {
          toolResult: { tool: "subagent", effects: [{ kind: "delegate", agent: "spec-reviewer" }], callId: "r2", ok: true, delegatedAgentRuns: [{ finished: true, resolvedAgent: "spec-reviewer" }] },
          afterToolMessage: null,
        },
        { toolUse: { tool: "subagent", effects: [{ kind: "delegate", agent: "test-writer" }], callId: "t4" }, verdict: { kind: "allow" } },
        { changeFiles: { "spec.md": "the spec, edited\n" } },
        {
          toolUse: { tool: "subagent", effects: [{ kind: "delegate", agent: "test-writer" }], callId: "t5" },
          verdict: { kind: "refuse", reason: "bounded/prereqs.rules: bounded/project's rule before delegating to 'test-writer' requires a delegation to spec-reviewer that succeeded over the current 'spec.md', 'src/**/*.contract.ts', and spec-reviewer succeeded over them, but they have changed since. This call would delegate to test-writer", redirect: "Have spec-reviewer review the current spec and contracts" },
        },
      ],
    },
    {
      title: "Agents are kept off the agent definitions and Bounded's records",
      steps: [
        {
          toolUse: { tool: "write", effects: [{ kind: "write", path: ".claude/agents/spec-reviewer.md", change: "modify" }] },
          verdict: {
            kind: "refuse",
            reason:
              "bounded/protected-paths refused write (modify) .claude/agents/spec-reviewer.md: the rule '.claude/agents/**' from bounded/project denies modify of '.claude/agents/spec-reviewer.md' (the agent definitions say who each agent is)",
            redirect: "Ask a person to change an agent's definition",
          },
        },
        {
          toolUse: { tool: "write", effects: [{ kind: "write", path: ".bounded/prereqs/records.jsonl", change: "modify" }] },
          verdict: {
            kind: "refuse",
            reason:
              "bounded/protected-paths refused write (modify) .bounded/prereqs/records.jsonl: the rule '.bounded/**' from bounded/project denies modify of '.bounded/prereqs/records.jsonl' (Bounded's own state, where prereqs keeps its records)",
            redirect: "Leave .bounded/ to Bounded",
          },
        },
      ],
    },
  ],
});
