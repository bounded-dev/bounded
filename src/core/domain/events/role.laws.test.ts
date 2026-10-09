import { textValueLaws, valueObjectLaws } from "../shared/value-object.laws.test-support.ts";
import { Role } from "./role.ts";

valueObjectLaws("Role", Role, ["builder", "plan-reviewer"], ["", "Builder", "plan_reviewer", "a b", "a--b", "-a", "a-"]);
textValueLaws("Role", Role, [["builder", "builder"], ["agent-2", "agent-2"]]);
