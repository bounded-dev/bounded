// Every line of code marked `// rejected: <reason>` must fail to compile with
// an error whose message contains <reason>, and no other line may fail.
// Example scenarios (ADR 2026-031) are typed as authored data.
import { defineExampleScenarios } from "bounded/domain";

const read = { kind: "read", path: "README.md" } as const;

// A tool use step gives the verdict it expects.
export const noVerdict = defineExampleScenarios({ scenarios: [{ title: "t", steps: [{ toolUse: { tool: "read", effects: [read] } }] }] }); // rejected: verdict
// An execute effect is a command still to be read: never a reading.
export const withReading = defineExampleScenarios({ scenarios: [{ title: "t", steps: [{ toolUse: { tool: "shell", effects: [{ kind: "execute", command: "make", reading: { outcome: "unread", why: "x" } }] }, verdict: { kind: "allow" } }] }] }); // rejected: reading
// A refusal has its redirect.
export const noRedirect = defineExampleScenarios({ scenarios: [{ title: "t", steps: [{ toolUse: { tool: "read", effects: [read] }, verdict: { kind: "refuse", reason: "No" } }] }] }); // rejected: redirect
// A write's change is create, modify or delete.
export const renamed = defineExampleScenarios({ scenarios: [{ title: "t", steps: [{ toolUse: { tool: "write", effects: [{ kind: "write", path: "a", change: "rename" }] }, verdict: { kind: "allow" } }] }] }); // rejected: "rename"
// A call id is text.
export const numberedCall = defineExampleScenarios({ scenarios: [{ title: "t", steps: [{ toolUse: { tool: "read", effects: [read], callId: 1 }, verdict: { kind: "allow" } }] }] }); // rejected: number
// There is no agent-run-finish step.
export const finished = defineExampleScenarios({ scenarios: [{ title: "t", steps: [{ toolUse: { tool: "read", effects: [read] }, verdict: { kind: "allow" } }, { agentRunFinished: { agentRunId: "run-1" } }] }] }); // rejected: agentRunFinished
// A scenario's tool use carries no kind.
export const kinded = defineExampleScenarios({ scenarios: [{ title: "t", steps: [{ toolUse: { kind: "tool-use", tool: "read", effects: [read] }, verdict: { kind: "allow" } }] }] }); // rejected: kind
