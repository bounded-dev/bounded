import type { Result, Tag, TaggingScheme, WorkspaceId } from "@dogfood/net-worth/domain";

// Wire input: what callers send.
export interface ListTagsInput {
  readonly workspaceId: string;
}

// Command: the input once validated into value objects.
export interface ListTagsCommand {
  readonly __brand: "ListTagsCommand";
  readonly workspaceId: WorkspaceId;
}

export interface ListTagsCommandFactory {
  parse(raw: unknown): Result<ListTagsCommand>;
}

// In port: what this feature offers.
/**
 * List every tag of a workspace, ordered by scheme order then tag order
 * @exposedVia trpc mcp
 */
export interface ListTags {
  execute(command: ListTagsCommand): Promise<Tag[]>;
}

// Out port: exactly what this feature needs.
export interface ListTagsStore {
  schemesOf(workspaceId: WorkspaceId): Promise<TaggingScheme[]>;
  tagsOf(workspaceId: WorkspaceId): Promise<Tag[]>;
}
