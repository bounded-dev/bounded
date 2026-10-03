import type { WorkspaceId } from "../workspaces/workspace-id.contract.ts";
import type { Position } from "./position.contract.ts";
import type { TaggingSchemeId } from "./tagging-scheme-id.contract.ts";
import type { TaggingSchemeName } from "./tagging-scheme-name.contract.ts";

/** A user-defined way of classifying accounts, holding an ordered list of tags. */
export interface TaggingScheme {
  readonly __brand: "TaggingScheme";
  readonly id: TaggingSchemeId;
  readonly workspaceId: WorkspaceId;
  readonly name: TaggingSchemeName;
  readonly position: Position;
  equals(other: TaggingScheme): boolean;
  toJSON(): {
    readonly id: string;
    readonly workspaceId: string;
    readonly name: string;
    readonly position: number;
  };
}

export interface TaggingSchemeFactory {
  new (id: TaggingSchemeId, workspaceId: WorkspaceId, name: TaggingSchemeName, position: Position): TaggingScheme;
}
