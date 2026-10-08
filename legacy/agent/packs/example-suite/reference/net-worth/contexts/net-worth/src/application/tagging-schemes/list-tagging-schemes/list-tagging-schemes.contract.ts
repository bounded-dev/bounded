import type { Result, TaggingScheme, WorkspaceId } from "@dogfood/net-worth/domain";

// Wire input: what callers send.
export interface ListTaggingSchemesInput {
  readonly workspaceId: string;
}

// Command: the input once validated into value objects.
export interface ListTaggingSchemesCommand {
  readonly __brand: "ListTaggingSchemesCommand";
  readonly workspaceId: WorkspaceId;
}

export interface ListTaggingSchemesCommandFactory {
  parse(raw: unknown): Result<ListTaggingSchemesCommand>;
}

// In port: what this feature offers.
/**
 * List the tagging schemes of a workspace in their order
 * @exposedVia trpc mcp
 */
export interface ListTaggingSchemes {
  execute(command: ListTaggingSchemesCommand): Promise<TaggingScheme[]>;
}

// Out port: exactly what this feature needs.
export interface ListTaggingSchemesStore {
  schemesOf(workspaceId: WorkspaceId): Promise<TaggingScheme[]>;
}
