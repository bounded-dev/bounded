import type {
  Account,
  AccountFilter,
  Result,
  Tag,
  WorkspaceId,
} from "@dogfood/net-worth/domain";

// Wire input: what callers send.
export interface ListAccountsInput {
  readonly workspaceId: string;
  readonly filter: string;
}

// Command: the input once validated into value objects.
export interface ListAccountsCommand {
  readonly __brand: "ListAccountsCommand";
  readonly workspaceId: WorkspaceId;
  readonly filter: AccountFilter;
}

export interface ListAccountsCommandFactory {
  parse(raw: unknown): Result<ListAccountsCommand>;
}

// In port: what this feature offers.
/**
 * List the accounts of a workspace, sorted by name. filter: "" for all, or criteria joined by "," that must all hold: "kind:asset" or "kind:liability", "tag:<tagId>" (an account with no tag in that scheme counts as Unspecified), "member:<memberId>" (owned in part by that member)
 * @exposedVia trpc mcp
 */
export interface ListAccounts {
  execute(command: ListAccountsCommand): Promise<Account[]>;
}

// Out port: exactly what this feature needs.
export interface ListAccountsStore {
  accountsOf(workspaceId: WorkspaceId): Promise<Account[]>;
  /** Every tag of every scheme of the workspace. */
  tagsOf(workspaceId: WorkspaceId): Promise<Tag[]>;
}
