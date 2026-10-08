import type {
  Result,
  Tag,
  TagId,
  TagName,
  TaggingSchemeId,
  WorkspaceId,
} from "@dogfood/net-worth/domain";

// Wire input: what callers send.
export interface RenameTagInput {
  readonly workspaceId: string;
  readonly tagId: string;
  readonly name: string;
}

// Command: the input once validated into value objects.
export interface RenameTagCommand {
  readonly __brand: "RenameTagCommand";
  readonly workspaceId: WorkspaceId;
  readonly tagId: TagId;
  readonly name: TagName;
}

export interface RenameTagCommandFactory {
  parse(raw: unknown): Result<RenameTagCommand>;
}

// In port: what this feature offers.
/**
 * Rename a tag; the built-in Unspecified tag cannot be renamed
 * @exposedVia trpc mcp
 */
export interface RenameTag {
  execute(command: RenameTagCommand): Promise<Result<Tag>>;
}

// Out port: exactly what this feature needs.
export interface RenameTagStore {
  findTag(workspaceId: WorkspaceId, id: TagId): Promise<Tag | undefined>;
  tagsOf(workspaceId: WorkspaceId, taggingSchemeId: TaggingSchemeId): Promise<Tag[]>;
  save(tag: Tag): Promise<void>;
}
