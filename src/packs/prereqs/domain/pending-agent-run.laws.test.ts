import { valueObjectLaws } from "../../../core/domain/shared/value-object.laws.test-support.ts";
import { PendingAgentRun } from "./pending-agent-run.ts";

const fingerprint = { sha256: "a".repeat(64), fileCount: 1 };
const start = { delegate: "plan-reviewer", unchangedSince: [".agent-state/*/plan.md"], fingerprint };
const pending = { agentRunId: "a1", callId: "toolu_1", startedAt: "2026-10-09T12:00:00.000Z", starts: [start] };
valueObjectLaws(
  "PendingAgentRun",
  PendingAgentRun,
  [pending, { agentRunId: "a2", callId: "toolu_2", startedAt: "2026-10-09T12:05:00.000Z", starts: [start, { ...start, delegate: "spec-reviewer", unchangedSince: ["spec.md"] }] }],
  [{}, { ...pending, starts: [] }, { ...pending, agentRunId: "" }, { ...pending, startedAt: "now" }, { ...pending, callId: 7 }],
);
