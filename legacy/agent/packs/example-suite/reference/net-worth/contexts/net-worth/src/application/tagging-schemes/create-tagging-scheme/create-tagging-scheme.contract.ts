import type {
  Result,
  Tag,
  TaggingScheme,
  TaggingSchemeName,
  WorkspaceId,
} from "@dogfood/net-worth/domain";

// Wire input: what callers send.
export interface CreateTaggingSchemeInput {
  readonly workspaceId: string;
  readonly name: string;
}

// Command: the input once validated into value objects.
export interface CreateTaggingSchemeCommand {
  readonly __brand: "CreateTaggingSchemeCommand";
  readonly workspaceId: WorkspaceId;
  readonly name: TaggingSchemeName;
}

export interface CreateTaggingSchemeCommandFactory {
  parse(raw: unknown): Result<CreateTaggingSchemeCommand>;
}

// In port: what this feature offers.
/**
 * Create a tagging scheme in a workspace, last in order, with its built-in Unspecified tag
 * @exposedVia trpc mcp
 */
export interface CreateTaggingScheme {
  execute(command: CreateTaggingSchemeCommand): Promise<Result<TaggingScheme>>;
}

// Out port: exactly what this feature needs.
export interface CreateTaggingSchemeStore {
  workspaceExists(id: WorkspaceId): Promise<boolean>;
  schemesOf(workspaceId: WorkspaceId): Promise<TaggingScheme[]>;
  /** Stores the scheme and its Unspecified tag together: both or neither. */
  save(scheme: TaggingScheme, unspecifiedTag: Tag): Promise<void>;
}
