import { defineExampleScenarios } from "bounded/domain";

export default defineExampleScenarios({
  scenarios: [
    {
      title: "A review of the current infra/ files lets terraform apply run; changing infra/ makes it stale; terraform plan always runs",
      projectFiles: { "infra/main.tf": "terraform {}\n" },
      steps: [
        {
          toolUse: { tool: "shell", effects: [{ kind: "execute", command: "terraform apply" }], callId: "a1" },
          verdict: { kind: "refuse", reason: "bounded/prereqs.rules: bounded/project's rule before executing 'terraform apply' requires a delegation to infra-reviewer that succeeded over the current 'infra/**', and infra-reviewer has not succeeded over them. This call would execute `terraform apply`, which runs 'terraform apply'", redirect: "Have infra-reviewer review the current infra/ changes" },
        },
        { toolUse: { tool: "shell", effects: [{ kind: "execute", command: "terraform plan" }], callId: "p1" }, verdict: { kind: "allow" } },
        { toolUse: { tool: "subagent", effects: [{ kind: "delegate", agent: "infra-reviewer" }], callId: "r1" }, verdict: { kind: "allow" } },
        {
          toolResult: { tool: "subagent", effects: [{ kind: "delegate", agent: "infra-reviewer" }], callId: "r1", ok: true, delegatedAgentRuns: [{ finished: true, resolvedAgent: "infra-reviewer" }] },
          afterToolMessage: null,
        },
        { toolUse: { tool: "shell", effects: [{ kind: "execute", command: "terraform apply" }], callId: "a2" }, verdict: { kind: "allow" } },
        { changeFiles: { "infra/main.tf": 'terraform { required_version = ">= 1.0" }\n' } },
        {
          toolUse: { tool: "shell", effects: [{ kind: "execute", command: "terraform apply" }], callId: "a3" },
          verdict: { kind: "refuse", reason: "bounded/prereqs.rules: bounded/project's rule before executing 'terraform apply' requires a delegation to infra-reviewer that succeeded over the current 'infra/**', and infra-reviewer succeeded over them, but they have changed since. This call would execute `terraform apply`, which runs 'terraform apply'", redirect: "Have infra-reviewer review the current infra/ changes" },
        },
        { toolUse: { tool: "shell", effects: [{ kind: "execute", command: "terraform plan" }], callId: "p2" }, verdict: { kind: "allow" } },
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
          toolUse: { tool: "write", effects: [{ kind: "write", path: ".claude/agents/infra-reviewer.md", change: "create" }] },
          verdict: {
            kind: "refuse",
            reason:
              "bounded/protected-paths refused write (create) .claude/agents/infra-reviewer.md: the rule '.claude/agents/**' from bounded/project denies create of '.claude/agents/infra-reviewer.md' (the agent definitions say who each agent is)",
            redirect: "Ask a person to change an agent's definition",
          },
        },
      ],
    },
    {
      title: "terraform apply is refused however it is run, and a program only the shell can name is refused as one bounded cannot see",
      projectFiles: { "infra/main.tf": "terraform {}\n" },
      steps: [
        {
          toolUse: { tool: "shell", effects: [{ kind: "execute", command: "sudo terraform apply" }], callId: "s1" },
          verdict: { kind: "refuse", reason: "bounded/prereqs.rules: bounded/project's rule before executing 'terraform apply' requires a delegation to infra-reviewer that succeeded over the current 'infra/**', and infra-reviewer has not succeeded over them. This call would execute `sudo terraform apply`, which runs 'terraform apply'", redirect: "Have infra-reviewer review the current infra/ changes" },
        },
        {
          toolUse: { tool: "shell", effects: [{ kind: "execute", command: "env TF_LOG=DEBUG terraform apply" }], callId: "s2" },
          verdict: { kind: "refuse", reason: "bounded/prereqs.rules: bounded/project's rule before executing 'terraform apply' requires a delegation to infra-reviewer that succeeded over the current 'infra/**', and infra-reviewer has not succeeded over them. This call would execute `env TF_LOG=DEBUG terraform apply`, which runs 'terraform apply'", redirect: "Have infra-reviewer review the current infra/ changes" },
        },
        {
          toolUse: { tool: "shell", effects: [{ kind: "execute", command: "bash -c 'terraform apply'" }], callId: "s3" },
          verdict: { kind: "refuse", reason: "bounded/prereqs.rules: bounded/project's rule before executing 'terraform apply' requires a delegation to infra-reviewer that succeeded over the current 'infra/**', and infra-reviewer has not succeeded over them. This call would execute `bash -c 'terraform apply'`, which runs 'terraform apply'", redirect: "Have infra-reviewer review the current infra/ changes" },
        },
        {
          toolUse: { tool: "shell", effects: [{ kind: "execute", command: "terraform -chdir=infra apply" }], callId: "s4" },
          verdict: { kind: "refuse", reason: "bounded/prereqs.rules: bounded/project's rule before executing 'terraform apply' requires a delegation to infra-reviewer that succeeded over the current 'infra/**', and infra-reviewer has not succeeded over them. This call would execute `terraform -chdir=infra apply`, which runs 'terraform apply'", redirect: "Have infra-reviewer review the current infra/ changes" },
        },
        {
          toolUse: { tool: "shell", effects: [{ kind: "execute", command: "$TF apply" }], callId: "s5" },
          verdict: { kind: "refuse", reason: "bounded/prereqs.rules: bounded/project's rule before executing 'terraform apply' requires a delegation to infra-reviewer that succeeded over the current 'infra/**', and infra-reviewer has not succeeded over them. This call would execute `$TF apply`, and bounded cannot see whether it runs 'terraform apply': it runs a program whose name only the shell can resolve ('$TF')", redirect: "Have infra-reviewer review the current infra/ changes (or, if this command does not run 'terraform apply', write it so that bounded can read it: no words only the shell can resolve where a program, its leading arguments or a written path stand)" },
        },
      ],
    },
  ],
});
