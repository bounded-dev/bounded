import { valueObjectLaws } from "../shared/value-object.laws.test-support.ts";
import { AgentRunFinished } from "./agent-run-finished.ts";

const finish = { role: null, agent: "plan-reviewer", agentRunId: "a6eef1505a0b443a2", ranToEnd: null };
valueObjectLaws(
  "AgentRunFinished",
  AgentRunFinished,
  [finish, { ...finish, role: "builder", ranToEnd: true }, { ...finish, agentRunId: "a2", ranToEnd: false }],
  [{}, { ...finish, ranToEnd: "yes" }, { ...finish, agent: "" }, { ...finish, agentRunId: "" }, { ...finish, kind: "tool-use" }],
);
