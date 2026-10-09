import type { Result } from "../shared/result.ts";
import type { Verdict } from "../verdicts/verdict.contract.ts";

/**
 * What a check on an agent run's finish found (ADR 2026-025): a `record` the
 * core writes to the Bounded log as a decision on the finish, or null to
 * write nothing. A refusal is recorded naming the contributing pack. There is
 * no message: no agent is told about a finish.
 */
export interface AgentRunFinishReport {
  readonly record: {
    readonly verdict: Verdict;
    readonly note: string;
  } | null;
}

export interface AgentRunFinishReportFactory {
  /** A report from what a finish check returned (contributed code's output, so untyped), or why it is not one. Never throws. */
  parse(raw: unknown): Result<AgentRunFinishReport>;
}
