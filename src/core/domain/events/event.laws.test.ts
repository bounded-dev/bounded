import { valueObjectLaws } from "../shared/value-object.laws.test-support.ts";
import { Event } from "./event.ts";

const write = { kind: "tool-use", role: "builder", tool: "write", effects: [{ kind: "write", path: "a.ts", change: "create" }] };
const start = { kind: "session-start", role: "builder" };
valueObjectLaws("Event", Event, [write, start], [{ kind: "tool-use", role: null }, { role: null }, { kind: "session-end", role: null }]);
