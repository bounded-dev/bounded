import type { DecisionLog } from "bounded/application";
import type { Decision } from "bounded/domain";

/** Decisions kept in memory, in the order recorded: for tests and short-lived hosts. */
export class InMemoryDecisionLog implements DecisionLog {
  private readonly kept: Decision[] = [];

  async record(decision: Decision): Promise<void> {
    this.kept.push(decision);
  }

  /** Every decision recorded so far, in order. */
  decisions(): readonly Decision[] {
    return [...this.kept];
  }
}
