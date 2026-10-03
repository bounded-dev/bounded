import type { WorkspaceId } from "../workspaces/workspace-id.contract.ts";
import type { MemberId } from "./member-id.contract.ts";
import type { MemberName } from "./member-name.contract.ts";

/** A person in a workspace. Plain data: members do not log in. */
export interface Member {
  readonly __brand: "Member";
  readonly id: MemberId;
  readonly workspaceId: WorkspaceId;
  readonly name: MemberName;
  equals(other: Member): boolean;
  toJSON(): { readonly id: string; readonly workspaceId: string; readonly name: string };
}

export interface MemberFactory {
  new (id: MemberId, workspaceId: WorkspaceId, name: MemberName): Member;
}
