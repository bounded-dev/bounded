import { valueObjectLaws } from "../shared/value-object.laws.test-support.ts";
import { SessionStart } from "./session-start.ts";

valueObjectLaws("SessionStart", SessionStart, [{ role: "planner" }, { role: null }], [{}, { role: "" }, { role: 1 }, { kind: "tool-use", role: null }]);
