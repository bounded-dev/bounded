import { textValueLaws, valueObjectLaws } from "../shared/value-object.laws.test-support.ts";
import { AgentName } from "./agent-name.ts";

valueObjectLaws("AgentName", AgentName, ["explore", "Plan reviewer"], ["", " ", "a\nb"]);
textValueLaws("AgentName", AgentName, [["explore", "explore"], ["Plan reviewer", "Plan reviewer"]]);
