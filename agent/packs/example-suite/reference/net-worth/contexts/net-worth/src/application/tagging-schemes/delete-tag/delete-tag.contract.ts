import type {
  Account,
  Result,
  Tag,
  TagId,
  TaggingSchemeId,
  WorkspaceId,
} from "@dogfood/net-worth/domain";

// Wire input: what callers send.
export interface DeleteTagInput {
  readonly workspaceId: string;
  readonly tagId: string;
}

// Command: the input once validated into value objects.
export interface DeleteTagCommand {
  readonly __brand: "DeleteTagCommand";
  readonly workspaceId: WorkspaceId;
  readonly tagId: TagId;
}

export interface DeleteTagCommandFactory {
  parse(raw: unknown): Result<DeleteTagCommand>;
}

// In port: what this feature offers.
/**
 * Delete a tag; refused for the built-in Unspecified tag and while any account carries the tag; returns the deleted tag
 * @exposedVia trpc mcp
 */
export interface DeleteTag {
  execute(command: DeleteTagCommand): Promise<Result<Tag>>;
}

// Out port: exactly what this feature needs.
export interface DeleteTagStore {
  findTag(workspaceId: WorkspaceId, id: TagId): Promise<Tag | undefined>;
  tagsOf(workspaceId: WorkspaceId, taggingSchemeId: TaggingSchemeId): Promise<Tag[]>;
  accountsOf(workspaceId: WorkspaceId): Promise<Account[]>;
  /** Removes the tag and writes the remaining tags' positions, in one transaction. */
  delete(tag: Tag, remaining: Tag[]): Promise<void>;
}
