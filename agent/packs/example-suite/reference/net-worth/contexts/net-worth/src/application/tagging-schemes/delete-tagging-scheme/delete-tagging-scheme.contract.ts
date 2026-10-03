import type {
  Account,
  Result,
  Tag,
  TaggingScheme,
  TaggingSchemeId,
  WorkspaceId,
} from "@dogfood/net-worth/domain";

// Wire input: what callers send.
export interface DeleteTaggingSchemeInput {
  readonly workspaceId: string;
  readonly taggingSchemeId: string;
}

// Command: the input once validated into value objects.
export interface DeleteTaggingSchemeCommand {
  readonly __brand: "DeleteTaggingSchemeCommand";
  readonly workspaceId: WorkspaceId;
  readonly taggingSchemeId: TaggingSchemeId;
}

export interface DeleteTaggingSchemeCommandFactory {
  parse(raw: unknown): Result<DeleteTaggingSchemeCommand>;
}

// In port: what this feature offers.
/**
 * Delete a tagging scheme and its tags; refused while any account carries one of its tags other than Unspecified; returns the deleted scheme
 * @exposedVia trpc mcp
 */
export interface DeleteTaggingScheme {
  execute(command: DeleteTaggingSchemeCommand): Promise<Result<TaggingScheme>>;
}

// Out port: exactly what this feature needs.
export interface DeleteTaggingSchemeStore {
  schemesOf(workspaceId: WorkspaceId): Promise<TaggingScheme[]>;
  tagsOf(workspaceId: WorkspaceId, taggingSchemeId: TaggingSchemeId): Promise<Tag[]>;
  accountsOf(workspaceId: WorkspaceId): Promise<Account[]>;
  /**
   * Removes the scheme, its tags and every account's entry for it, and writes
   * the remaining schemes' positions, in one transaction.
   */
  delete(scheme: TaggingScheme, remaining: TaggingScheme[]): Promise<void>;
}
