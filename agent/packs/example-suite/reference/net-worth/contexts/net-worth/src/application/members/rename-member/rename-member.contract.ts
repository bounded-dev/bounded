import type { Member, MemberId, MemberName, Result, WorkspaceId } from "@dogfood/net-worth/domain";

// Wire input: what callers send.
export interface RenameMemberInput {
  readonly workspaceId: string;
  readonly memberId: string;
  readonly name: string;
}

// Command: the input once validated into value objects.
export interface RenameMemberCommand {
  readonly __brand: "RenameMemberCommand";
  readonly workspaceId: WorkspaceId;
  readonly memberId: MemberId;
  readonly name: MemberName;
}

export interface RenameMemberCommandFactory {
  parse(raw: unknown): Result<RenameMemberCommand>;
}

// In port: what this feature offers.
/**
 * Rename a member of a workspace; member names are unique within a workspace, ignoring case
 * @exposedVia trpc mcp
 */
export interface RenameMember {
  execute(command: RenameMemberCommand): Promise<Result<Member>>;
}

// Out port: exactly what this feature needs.
export interface RenameMemberStore {
  findMember(workspaceId: WorkspaceId, id: MemberId): Promise<Member | undefined>;
  membersOf(workspaceId: WorkspaceId): Promise<Member[]>;
  save(member: Member): Promise<void>;
}
