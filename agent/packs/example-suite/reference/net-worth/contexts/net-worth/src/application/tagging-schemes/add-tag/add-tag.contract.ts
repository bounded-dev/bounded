import type {
  Result,
  Tag,
  TagName,
  TaggingSchemeId,
  WorkspaceId,
} from "@dogfood/net-worth/domain";

// Wire input: what callers send.
export interface AddTagInput {
  readonly workspaceId: string;
  readonly taggingSchemeId: string;
  readonly name: string;
}

// Command: the input once validated into value objects.
export interface AddTagCommand {
  readonly __brand: "AddTagCommand";
  readonly workspaceId: WorkspaceId;
  readonly taggingSchemeId: TaggingSchemeId;
  readonly name: TagName;
}

export interface AddTagCommandFactory {
  parse(raw: unknown): Result<AddTagCommand>;
}

// In port: what this feature offers.
/**
 * Add a tag, last in order, to a tagging scheme; tag names are unique within a scheme, ignoring case
 * @exposedVia trpc mcp
 */
export interface AddTag {
  execute(command: AddTagCommand): Promise<Result<Tag>>;
}

// Out port: exactly what this feature needs.
export interface AddTagStore {
  schemeExists(workspaceId: WorkspaceId, id: TaggingSchemeId): Promise<boolean>;
  tagsOf(workspaceId: WorkspaceId, taggingSchemeId: TaggingSchemeId): Promise<Tag[]>;
  save(tag: Tag): Promise<void>;
}
