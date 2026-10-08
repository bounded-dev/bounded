import type { GuardLog } from "./judge-event.contract.ts";
import type { Decision } from "bounded/domain";

/** Decisions kept in memory, in the order recorded: a test double of GuardLog, for tests only (ADR 2026-017). */
export class InMemoryGuardLog implements GuardLog {
  private readonly kept: Decision[] = [];

  async record(decision: Decision): Promise<void> {
    this.kept.push(decision);
  }

  /** Every decision recorded so far, in order. */
  decisions(): readonly Decision[] {
    return [...this.kept];
  }
}
