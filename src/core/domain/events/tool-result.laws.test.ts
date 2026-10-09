import { valueObjectLaws } from "../shared/value-object.laws.test-support.ts";
import { ToolResult } from "./tool-result.ts";

const done = { kind: "tool-result", role: "builder", tool: "shell", effects: [{ kind: "execute", command: "make" }], ok: true, callId: "toolu_1" };
const delegated = { kind: "tool-result", role: null, tool: "subagent", effects: [{ kind: "delegate", agent: "a" }, { kind: "delegate", agent: "b" }], ok: true, callId: "toolu_3", delegatedAgentRuns: [{ finished: true }, { finished: false }] };
valueObjectLaws("ToolResult", ToolResult, [done, { ...done, ok: false, callId: "toolu_2" }, delegated], [{ ...done, ok: "yes" }, { ...done, effects: [] }, { ...done, kind: "tool-use" }, { ...delegated, delegatedAgentRuns: [{ finished: true }] }]);
