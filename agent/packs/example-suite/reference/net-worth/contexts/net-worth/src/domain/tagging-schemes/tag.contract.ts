import type { WorkspaceId } from "../workspaces/workspace-id.contract.ts";
import type { Position } from "./position.contract.ts";
import type { TaggingSchemeId } from "./tagging-scheme-id.contract.ts";
import type { TagId } from "./tag-id.contract.ts";
import type { TagName } from "./tag-name.contract.ts";

/** One value of a tagging scheme, at a place in the scheme's order. */
export interface Tag {
  readonly __brand: "Tag";
  readonly id: TagId;
  readonly workspaceId: WorkspaceId;
  readonly taggingSchemeId: TaggingSchemeId;
  readonly name: TagName;
  readonly position: Position;
  equals(other: Tag): boolean;
  toJSON(): {
    readonly id: string;
    readonly workspaceId: string;
    readonly taggingSchemeId: string;
    readonly name: string;
    readonly position: number;
  };
  /** Whether this is the scheme's built-in Unspecified tag: its name, lower-cased, is "unspecified". */
  isUnspecified(): boolean;
}

export interface TagFactory {
  new (
    id: TagId,
    workspaceId: WorkspaceId,
    taggingSchemeId: TaggingSchemeId,
    name: TagName,
    position: Position,
  ): Tag;
}
