import { valueObjectLaws } from "../shared/value-object.laws.test-support.ts";
import { ToolResult } from "./tool-result.ts";

const done = { kind: "tool-result", role: "builder", tool: "shell", effects: [{ kind: "execute", command: "make", reading: { outcome: "unread", why: "the parser could not load" } }], ok: true, callId: "toolu_1" };
const delegated = { kind: "tool-result", role: null, tool: "subagent", effects: [{ kind: "delegate", agent: "a" }, { kind: "delegate", agent: "b" }], ok: true, callId: "toolu_3", delegatedAgentRuns: [{ finished: true }, { finished: false }] };
const launched = { ...delegated, callId: "toolu_4", delegatedAgentRuns: [{ finished: true, agentRunId: "a1", resolvedAgent: "a" }, { finished: false, agentRunId: "a2", finishReportedLater: true }] };
const neverReported = { ...delegated, callId: "toolu_5", delegatedAgentRuns: [{ finished: false, finishNeverReported: true }, { finished: true }] };
valueObjectLaws("ToolResult", ToolResult, [done, { ...done, ok: false, callId: "toolu_2" }, delegated, launched, neverReported], [{ ...delegated, delegatedAgentRuns: [{ finished: false, finishNeverReported: false }, { finished: true }] }, { ...delegated, delegatedAgentRuns: [{ finished: true, agentRunId: "a1", finishReportedLater: true }, { finished: false }] }, { ...done, ok: "yes" }, { ...done, effects: [] }, { ...done, kind: "tool-use" }, { ...delegated, delegatedAgentRuns: [{ finished: true }] }]);
