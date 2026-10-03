import type { Member, Result, WorkspaceId } from "@dogfood/net-worth/domain";

// Wire input: what callers send.
export interface ListMembersInput {
  readonly workspaceId: string;
}

// Command: the input once validated into value objects.
export interface ListMembersCommand {
  readonly __brand: "ListMembersCommand";
  readonly workspaceId: WorkspaceId;
}

export interface ListMembersCommandFactory {
  parse(raw: unknown): Result<ListMembersCommand>;
}

// In port: what this feature offers.
/**
 * List the members of a workspace, sorted by name
 * @exposedVia trpc mcp
 */
export interface ListMembers {
  execute(command: ListMembersCommand): Promise<Member[]>;
}

// Out port: exactly what this feature needs.
export interface ListMembersStore {
  membersOf(workspaceId: WorkspaceId): Promise<Member[]>;
}
