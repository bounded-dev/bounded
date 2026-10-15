import { defineExampleScenarios } from "bounded/domain";

export default defineExampleScenarios({
  scenarios: [
    {
      title: "A review of the current plan lets builder run and src/ be edited; editing the plan makes it stale",
      projectFiles: { ".agent-state/item/plan.md": "the plan\n", "src/a.ts": "export const a = 1;\n" },
      steps: [
        {
          toolUse: { tool: "write", effects: [{ kind: "write", path: "src/a.ts", change: "modify" }] },
          verdict: { kind: "refuse", reason: "bounded/prereqs.rules: bounded/project's rule before write 'src/**' requires a delegation to plan-reviewer that succeeded over the current '.agent-state/*/plan.md', and plan-reviewer has not succeeded over them. This call would write (modify) src/a.ts", redirect: "Have plan-reviewer review the current plan before editing src/" },
        },
        {
          toolUse: { tool: "subagent", effects: [{ kind: "delegate", agent: "builder" }], callId: "b1" },
          verdict: { kind: "refuse", reason: "bounded/prereqs.rules: bounded/project's rule before delegating to 'builder' requires a delegation to plan-reviewer that succeeded over the current '.agent-state/*/plan.md', and plan-reviewer has not succeeded over them. This call would delegate to builder", redirect: "Have plan-reviewer review the current plan" },
        },
        { toolUse: { tool: "subagent", effects: [{ kind: "delegate", agent: "plan-reviewer" }], callId: "r1" }, verdict: { kind: "allow" } },
        {
          toolResult: { tool: "subagent", effects: [{ kind: "delegate", agent: "plan-reviewer" }], callId: "r1", ok: true, delegatedAgentRuns: [{ finished: true, resolvedAgent: "plan-reviewer" }] },
          afterToolMessage: null,
        },
        { toolUse: { tool: "write", effects: [{ kind: "write", path: "src/a.ts", change: "modify" }] }, verdict: { kind: "allow" } },
        { toolUse: { tool: "subagent", effects: [{ kind: "delegate", agent: "builder" }], callId: "b2" }, verdict: { kind: "allow" } },
        { changeFiles: { ".agent-state/item/plan.md": "the plan, edited\n" } },
        {
          toolUse: { tool: "write", effects: [{ kind: "write", path: "src/a.ts", change: "modify" }] },
          verdict: { kind: "refuse", reason: "bounded/prereqs.rules: bounded/project's rule before write 'src/**' requires a delegation to plan-reviewer that succeeded over the current '.agent-state/*/plan.md', and plan-reviewer succeeded over them, but they have changed since. This call would write (modify) src/a.ts", redirect: "Have plan-reviewer review the current plan before editing src/" },
        },
        {
          toolUse: { tool: "subagent", effects: [{ kind: "delegate", agent: "builder" }], callId: "b3" },
          verdict: { kind: "refuse", reason: "bounded/prereqs.rules: bounded/project's rule before delegating to 'builder' requires a delegation to plan-reviewer that succeeded over the current '.agent-state/*/plan.md', and plan-reviewer succeeded over them, but they have changed since. This call would delegate to builder", redirect: "Have plan-reviewer review the current plan" },
        },
      ],
    },
    {
      title: "Agents are kept off Bounded's records and the agent definitions",
      steps: [
        {
          toolUse: { tool: "write", effects: [{ kind: "write", path: ".bounded/prereqs/records.jsonl", change: "modify" }] },
          verdict: {
            kind: "refuse",
            reason:
              "bounded/protected-paths refused write (modify) .bounded/prereqs/records.jsonl: the rule '.bounded/**' from bounded/project denies modify of '.bounded/prereqs/records.jsonl' (Bounded's own state, where prereqs keeps its records)",
            redirect: "Leave .bounded/ to Bounded",
          },
        },
        {
          toolUse: { tool: "write", effects: [{ kind: "write", path: ".claude/agents/plan-reviewer.md", change: "create" }] },
          verdict: {
            kind: "refuse",
            reason:
              "bounded/protected-paths refused write (create) .claude/agents/plan-reviewer.md: the rule '.claude/agents/**' from bounded/project denies create of '.claude/agents/plan-reviewer.md' (the agent definitions say who each agent is)",
            redirect: "Ask a person to change an agent's definition",
          },
        },
      ],
    },
  ],
});
