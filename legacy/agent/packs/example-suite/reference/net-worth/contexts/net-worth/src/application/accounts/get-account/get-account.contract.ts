import type { Account, AccountId, Result, WorkspaceId } from "@dogfood/net-worth/domain";

// Wire input: what callers send.
export interface GetAccountInput {
  readonly workspaceId: string;
  readonly accountId: string;
}

// Command: the input once validated into value objects.
export interface GetAccountCommand {
  readonly __brand: "GetAccountCommand";
  readonly workspaceId: WorkspaceId;
  readonly accountId: AccountId;
}

export interface GetAccountCommandFactory {
  parse(raw: unknown): Result<GetAccountCommand>;
}

// In port: what this feature offers.
/**
 * Get one account of a workspace with every field: kind, provider, currency, dates, opening balance, balance source, tags and owners
 * @exposedVia trpc mcp
 */
export interface GetAccount {
  execute(command: GetAccountCommand): Promise<Result<Account>>;
}

// Out port: exactly what this feature needs.
export interface GetAccountStore {
  findAccount(workspaceId: WorkspaceId, id: AccountId): Promise<Account | undefined>;
}
