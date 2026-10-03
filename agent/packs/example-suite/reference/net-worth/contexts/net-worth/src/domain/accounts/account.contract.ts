import type { CurrencyCode } from "../currencies/currency-code.contract.ts";
import type { Member } from "../members/member.contract.ts";
import type { Result } from "../shared/result.ts";
import type { Tag } from "../tagging-schemes/tag.contract.ts";
import type { TaggingScheme } from "../tagging-schemes/tagging-scheme.contract.ts";
import type { Workspace } from "../workspaces/workspace.contract.ts";
import type { WorkspaceId } from "../workspaces/workspace-id.contract.ts";
import type { AccountId } from "./account-id.contract.ts";
import type { AccountKind } from "./account-kind.contract.ts";
import type { AccountName } from "./account-name.contract.ts";
import type { AccountTags } from "./account-tags.contract.ts";
import type { Amount } from "./amount.contract.ts";
import type { BalanceSource } from "./balance-source.contract.ts";
import type { CalendarDate } from "./calendar-date.contract.ts";
import type { EndDate } from "./end-date.contract.ts";
import type { Ownership } from "./ownership.contract.ts";
import type { Provider } from "./provider.contract.ts";
import type { Revaluation } from "./revaluation.contract.ts";

/**
 * Anything with a value in a workspace: an asset or a liability, held in one
 * native currency, from its start date (with its opening balance) until its
 * end date, if any. Equality is by id.
 */
export interface Account {
  readonly __brand: "Account";
  readonly id: AccountId;
  readonly workspaceId: WorkspaceId;
  readonly name: AccountName;
  readonly kind: AccountKind;
  readonly provider: Provider;
  readonly nativeCurrency: CurrencyCode;
  readonly startDate: CalendarDate;
  readonly openingBalance: Amount;
  readonly endDate: EndDate;
  readonly balanceSource: BalanceSource;
  readonly tags: AccountTags;
  readonly owners: Ownership;
  equals(other: Account): boolean;
  toJSON(): {
    readonly id: string;
    readonly workspaceId: string;
    readonly name: string;
    readonly kind: string;
    readonly provider: string;
    readonly nativeCurrency: string;
    readonly startDate: string;
    readonly openingBalance: number;
    readonly endDate: string;
    readonly balanceSource: string;
    readonly tags: string;
    readonly owners: string;
  };
  /**
   * Whether this account is valid in its workspace, given everything of the
   * workspace's schemes, tags (of every scheme) and members. Returns this very
   * account, or the first failing check's error: E14, E15, E4, E6, E16, E3 in
   * that order (TN-2, "Account").
   */
  checkAgainst(
    workspace: Workspace,
    schemes: readonly TaggingScheme[],
    tags: readonly Tag[],
    members: readonly Member[],
  ): Result<Account>;
  /**
   * Whether the account's effective tag in the tag's scheme is that tag; with
   * no entry for the scheme, the effective tag is the scheme's Unspecified tag.
   */
  hasTag(tag: Tag): boolean;
  /**
   * The value of a fixed account on a day: undefined if it is not fixed or the
   * day is before its start; 0 from its end date on; else the latest of its own
   * revaluations effective on or before the day, or the opening balance.
   */
  fixedValueAt(date: CalendarDate, revaluations: readonly Revaluation[]): Amount | undefined;
}

export interface AccountFactory {
  new (
    id: AccountId,
    workspaceId: WorkspaceId,
    name: AccountName,
    kind: AccountKind,
    provider: Provider,
    nativeCurrency: CurrencyCode,
    startDate: CalendarDate,
    openingBalance: Amount,
    endDate: EndDate,
    balanceSource: BalanceSource,
    tags: AccountTags,
    owners: Ownership,
  ): Account;
}
