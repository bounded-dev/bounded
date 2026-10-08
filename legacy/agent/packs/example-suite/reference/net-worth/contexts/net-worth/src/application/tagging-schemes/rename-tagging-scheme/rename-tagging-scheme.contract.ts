import type {
  Result,
  TaggingScheme,
  TaggingSchemeId,
  TaggingSchemeName,
  WorkspaceId,
} from "@dogfood/net-worth/domain";

// Wire input: what callers send.
export interface RenameTaggingSchemeInput {
  readonly workspaceId: string;
  readonly taggingSchemeId: string;
  readonly name: string;
}

// Command: the input once validated into value objects.
export interface RenameTaggingSchemeCommand {
  readonly __brand: "RenameTaggingSchemeCommand";
  readonly workspaceId: WorkspaceId;
  readonly taggingSchemeId: TaggingSchemeId;
  readonly name: TaggingSchemeName;
}

export interface RenameTaggingSchemeCommandFactory {
  parse(raw: unknown): Result<RenameTaggingSchemeCommand>;
}

// In port: what this feature offers.
/**
 * Rename a tagging scheme; scheme names are unique within a workspace, ignoring case
 * @exposedVia trpc mcp
 */
export interface RenameTaggingScheme {
  execute(command: RenameTaggingSchemeCommand): Promise<Result<TaggingScheme>>;
}

// Out port: exactly what this feature needs.
export interface RenameTaggingSchemeStore {
  schemesOf(workspaceId: WorkspaceId): Promise<TaggingScheme[]>;
  save(scheme: TaggingScheme): Promise<void>;
}
