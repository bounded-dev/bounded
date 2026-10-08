import type {
  Position,
  Result,
  TaggingScheme,
  TaggingSchemeId,
  WorkspaceId,
} from "@dogfood/net-worth/domain";

// Wire input: what callers send.
export interface MoveTaggingSchemeInput {
  readonly workspaceId: string;
  readonly taggingSchemeId: string;
  readonly position: number;
}

// Command: the input once validated into value objects.
export interface MoveTaggingSchemeCommand {
  readonly __brand: "MoveTaggingSchemeCommand";
  readonly workspaceId: WorkspaceId;
  readonly taggingSchemeId: TaggingSchemeId;
  readonly position: Position;
}

export interface MoveTaggingSchemeCommandFactory {
  parse(raw: unknown): Result<MoveTaggingSchemeCommand>;
}

// In port: what this feature offers.
/**
 * Move a tagging scheme to a new 0-based position in its workspace's order
 * @exposedVia trpc mcp
 */
export interface MoveTaggingScheme {
  execute(command: MoveTaggingSchemeCommand): Promise<Result<TaggingScheme>>;
}

// Out port: exactly what this feature needs.
export interface MoveTaggingSchemeStore {
  schemesOf(workspaceId: WorkspaceId): Promise<TaggingScheme[]>;
  /** Writes every scheme's position in one transaction: all or none. */
  saveAll(schemes: TaggingScheme[]): Promise<void>;
}
