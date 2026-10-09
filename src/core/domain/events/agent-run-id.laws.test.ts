import { textValueLaws, valueObjectLaws } from "../shared/value-object.laws.test-support.ts";
import { AgentRunId } from "./agent-run-id.ts";

valueObjectLaws("AgentRunId", AgentRunId, ["a6eef1505a0b443a2", "run/1:x"], ["", " ", "a\nb", "x".repeat(257), 42]);
textValueLaws("AgentRunId", AgentRunId, [["a6eef1505a0b443a2", "a6eef1505a0b443a2"], ["x".repeat(256), "x".repeat(256)]]);
