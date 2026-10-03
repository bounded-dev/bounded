import type {
  Account,
  AccountKind,
  AccountName,
  AccountTags,
  Amount,
  BalanceSource,
  CalendarDate,
  CurrencyCode,
  EndDate,
  Member,
  Ownership,
  Provider,
  Result,
  Tag,
  TaggingScheme,
  Workspace,
  WorkspaceId,
} from "@dogfood/net-worth/domain";

// Wire input: what callers send.
export interface CreateAccountInput {
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
}

// Command: the input once validated into value objects.
export interface CreateAccountCommand {
  readonly __brand: "CreateAccountCommand";
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
}

export interface CreateAccountCommandFactory {
  parse(raw: unknown): Result<CreateAccountCommand>;
}

// In port: what this feature offers.
/**
 * Create an account (asset or liability) in a workspace. kind: "asset" or "liability". provider: free text, "" for none. nativeCurrency: one of the workspace's supported currencies. Dates are "YYYY-MM-DD"; endDate "" while open. openingBalance: a non-negative amount with at most two decimals. balanceSource: "readings" or "fixed". tags: one "<taggingSchemeId>:<tagId>" per tagging scheme of the workspace, joined by ",". owners: "<memberId>:<percent>" joined by "," summing to 100, or member ids only for an even split
 * @exposedVia trpc mcp
 */
export interface CreateAccount {
  execute(command: CreateAccountCommand): Promise<Result<Account>>;
}

// Out port: exactly what this feature needs.
export interface CreateAccountStore {
  findWorkspace(id: WorkspaceId): Promise<Workspace | undefined>;
  schemesOf(workspaceId: WorkspaceId): Promise<TaggingScheme[]>;
  /** Every tag of every scheme of the workspace. */
  tagsOf(workspaceId: WorkspaceId): Promise<Tag[]>;
  membersOf(workspaceId: WorkspaceId): Promise<Member[]>;
  save(account: Account): Promise<void>;
}
