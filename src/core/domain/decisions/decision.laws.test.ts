import { valueObjectLaws } from "../shared/value-object.laws.test-support.ts";
import { Decision } from "./decision.ts";

const TIME = "2026-10-07T12:00:00.000Z";
const line = { id: "d-0", time: TIME, event: "tool-use", role: "builder", tool: "edit", effects: ["read a.ts"], verdict: { kind: "allow" }, note: null };
const adapterLine = { ...line, id: "d-00", event: "adapter", role: null, tool: null, effects: [], verdict: { kind: "refuse", reason: "r", redirect: "d", pack: null, effect: null }, host: { tool: "Bash", input: "{}" } };
const finishLine = { ...line, id: "d-000", event: "agent-run-finished", role: null, tool: null, effects: [], note: "plan-reviewer's run a1 finished (ran to its end: not said): recorded" };
valueObjectLaws("Decision", Decision, [line, adapterLine, finishLine], [{ ...line, id: "" }, { ...line, event: "other" }, { ...line, effects: "read a.ts" }, { ...line, verdict: { kind: "maybe" } }, { ...line, tool: "bash" }]);
