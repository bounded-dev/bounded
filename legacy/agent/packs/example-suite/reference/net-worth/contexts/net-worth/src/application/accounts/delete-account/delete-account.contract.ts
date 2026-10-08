import type { Account, AccountId, Result, WorkspaceId } from "@dogfood/net-worth/domain";

// Wire input: what callers send.
export interface DeleteAccountInput {
  readonly workspaceId: string;
  readonly accountId: string;
}

// Command: the input once validated into value objects.
export interface DeleteAccountCommand {
  readonly __brand: "DeleteAccountCommand";
  readonly workspaceId: WorkspaceId;
  readonly accountId: AccountId;
}

export interface DeleteAccountCommandFactory {
  parse(raw: unknown): Result<DeleteAccountCommand>;
}

// In port: what this feature offers.
/**
 * Delete an account and its revaluation history for good (closing it with an end date is the normal way to retire an account); returns the deleted account
 * @exposedVia trpc mcp
 */
export interface DeleteAccount {
  execute(command: DeleteAccountCommand): Promise<Result<Account>>;
}

// Out port: exactly what this feature needs.
export interface DeleteAccountStore {
  findAccount(workspaceId: WorkspaceId, id: AccountId): Promise<Account | undefined>;
  /** Removes the account and every revaluation of it, in one transaction. */
  delete(account: Account): Promise<void>;
}
