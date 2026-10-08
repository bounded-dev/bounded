import { valueObjectLaws } from "../shared/value-object.laws.test-support.ts";
import { ToolResult } from "./tool-result.ts";

const done = { kind: "tool-result", role: "builder", tool: "shell", effects: [{ kind: "execute", command: "make" }], ok: true, callId: "toolu_1" };
valueObjectLaws("ToolResult", ToolResult, [done, { ...done, ok: false, callId: "toolu_2" }], [{ ...done, ok: "yes" }, { ...done, effects: [] }, { ...done, kind: "tool-use" }]);
