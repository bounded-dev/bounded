import type { WorkspaceId } from "../workspaces/workspace-id.contract.ts";
import type { AccountId } from "./account-id.contract.ts";
import type { Amount } from "./amount.contract.ts";
import type { CalendarDate } from "./calendar-date.contract.ts";
import type { RevaluationId } from "./revaluation-id.contract.ts";

/** A new value for a fixed account, applying from its effective date onward. */
export interface Revaluation {
  readonly __brand: "Revaluation";
  readonly id: RevaluationId;
  readonly workspaceId: WorkspaceId;
  readonly accountId: AccountId;
  readonly effectiveDate: CalendarDate;
  readonly value: Amount;
  equals(other: Revaluation): boolean;
  toJSON(): {
    readonly id: string;
    readonly workspaceId: string;
    readonly accountId: string;
    readonly effectiveDate: string;
    readonly value: number;
  };
}

export interface RevaluationFactory {
  new (
    id: RevaluationId,
    workspaceId: WorkspaceId,
    accountId: AccountId,
    effectiveDate: CalendarDate,
    value: Amount,
  ): Revaluation;
}
