import type {
  Position,
  Result,
  Tag,
  TagId,
  TaggingSchemeId,
  WorkspaceId,
} from "@dogfood/net-worth/domain";

// Wire input: what callers send.
export interface MoveTagInput {
  readonly workspaceId: string;
  readonly tagId: string;
  readonly position: number;
}

// Command: the input once validated into value objects.
export interface MoveTagCommand {
  readonly __brand: "MoveTagCommand";
  readonly workspaceId: WorkspaceId;
  readonly tagId: TagId;
  readonly position: Position;
}

export interface MoveTagCommandFactory {
  parse(raw: unknown): Result<MoveTagCommand>;
}

// In port: what this feature offers.
/**
 * Move a tag to a new 0-based position in its scheme's order; position 0 belongs to the Unspecified tag, which cannot be moved
 * @exposedVia trpc mcp
 */
export interface MoveTag {
  execute(command: MoveTagCommand): Promise<Result<Tag>>;
}

// Out port: exactly what this feature needs.
export interface MoveTagStore {
  findTag(workspaceId: WorkspaceId, id: TagId): Promise<Tag | undefined>;
  tagsOf(workspaceId: WorkspaceId, taggingSchemeId: TaggingSchemeId): Promise<Tag[]>;
  /** Writes every tag's position in one transaction: all or none. */
  saveAll(tags: Tag[]): Promise<void>;
}
