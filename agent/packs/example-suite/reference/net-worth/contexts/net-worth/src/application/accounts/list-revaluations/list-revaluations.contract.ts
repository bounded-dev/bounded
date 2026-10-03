import type { AccountId, Result, Revaluation, WorkspaceId } from "@dogfood/net-worth/domain";

// Wire input: what callers send.
export interface ListRevaluationsInput {
  readonly workspaceId: string;
  readonly accountId: string;
}

// Command: the input once validated into value objects.
export interface ListRevaluationsCommand {
  readonly __brand: "ListRevaluationsCommand";
  readonly workspaceId: WorkspaceId;
  readonly accountId: AccountId;
}

export interface ListRevaluationsCommandFactory {
  parse(raw: unknown): Result<ListRevaluationsCommand>;
}

// In port: what this feature offers.
/**
 * List a fixed account's revaluation history, oldest effective date first
 * @exposedVia trpc mcp
 */
export interface ListRevaluations {
  execute(command: ListRevaluationsCommand): Promise<Revaluation[]>;
}

// Out port: exactly what this feature needs.
export interface ListRevaluationsStore {
  revaluationsOf(workspaceId: WorkspaceId, accountId: AccountId): Promise<Revaluation[]>;
}
