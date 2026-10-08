import type { Effect } from "../events/effect.contract.ts";
import type { Result } from "../shared/result.ts";
import type { Verdict } from "../verdicts/verdict.contract.ts";

/**
 * What an after-tool check found: a `message` for the agent (null when
 * there is nothing to say), and a `record` the core writes to the guard log
 * as a decision on the result, naming the contributing pack when
 * `refusedBy` is given.
 */
export interface AfterToolReport {
  readonly message: string | null;
  readonly record: {
    readonly verdict: Verdict;
    readonly refusedBy: { readonly effect: Effect | null } | null;
    readonly note: string;
  } | null;
}

export interface AfterToolReportFactory {
  /** A report from what an after-tool check returned (contributed code's output, so untyped), or why it is not one. Never throws. */
  parse(raw: unknown): Result<AfterToolReport>;
}
