import type {
  Account,
  AccountId,
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
export interface UpdateAccountInput {
  readonly workspaceId: string;
  readonly accountId: string;
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
export interface UpdateAccountCommand {
  readonly __brand: "UpdateAccountCommand";
  readonly workspaceId: WorkspaceId;
  readonly accountId: AccountId;
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

export interface UpdateAccountCommandFactory {
  parse(raw: unknown): Result<UpdateAccountCommand>;
}

// In port: what this feature offers.
/**
 * Replace every field of an account (read it with get_account first and send it back changed). Close an account by setting endDate ("YYYY-MM-DD", on or after startDate); reopen it with endDate "". Same field formats as create_account: tags one "<taggingSchemeId>:<tagId>" per scheme; owners "<memberId>:<percent>" summing to 100, or member ids only for an even split
 * @exposedVia trpc mcp
 */
export interface UpdateAccount {
  execute(command: UpdateAccountCommand): Promise<Result<Account>>;
}

// Out port: exactly what this feature needs.
export interface UpdateAccountStore {
  findWorkspace(id: WorkspaceId): Promise<Workspace | undefined>;
  findAccount(workspaceId: WorkspaceId, id: AccountId): Promise<Account | undefined>;
  schemesOf(workspaceId: WorkspaceId): Promise<TaggingScheme[]>;
  /** Every tag of every scheme of the workspace. */
  tagsOf(workspaceId: WorkspaceId): Promise<Tag[]>;
  membersOf(workspaceId: WorkspaceId): Promise<Member[]>;
  save(account: Account): Promise<void>;
}
