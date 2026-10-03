import type {
  Account,
  AccountId,
  Amount,
  CalendarDate,
  Result,
  Revaluation,
  WorkspaceId,
} from "@dogfood/net-worth/domain";

// Wire input: what callers send.
export interface RevalueAccountInput {
  readonly workspaceId: string;
  readonly accountId: string;
  readonly effectiveDate: string;
  readonly value: number;
}

// Command: the input once validated into value objects.
export interface RevalueAccountCommand {
  readonly __brand: "RevalueAccountCommand";
  readonly workspaceId: WorkspaceId;
  readonly accountId: AccountId;
  readonly effectiveDate: CalendarDate;
  readonly value: Amount;
}

export interface RevalueAccountCommandFactory {
  parse(raw: unknown): Result<RevalueAccountCommand>;
}

// In port: what this feature offers.
/**
 * Record a new value for a fixed account, applying from effectiveDate ("YYYY-MM-DD", on or after its start date) onward; a revaluation on the same date replaces the earlier one
 * @exposedVia trpc mcp
 */
export interface RevalueAccount {
  execute(command: RevalueAccountCommand): Promise<Result<Revaluation>>;
}

// Out port: exactly what this feature needs.
export interface RevalueAccountStore {
  findAccount(workspaceId: WorkspaceId, id: AccountId): Promise<Account | undefined>;
  revaluationsOf(workspaceId: WorkspaceId, accountId: AccountId): Promise<Revaluation[]>;
  save(revaluation: Revaluation): Promise<void>;
}
