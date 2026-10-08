import type { Account, Member, MemberId, Result, WorkspaceId } from "@dogfood/net-worth/domain";

// Wire input: what callers send.
export interface DeleteMemberInput {
  readonly workspaceId: string;
  readonly memberId: string;
}

// Command: the input once validated into value objects.
export interface DeleteMemberCommand {
  readonly __brand: "DeleteMemberCommand";
  readonly workspaceId: WorkspaceId;
  readonly memberId: MemberId;
}

export interface DeleteMemberCommandFactory {
  parse(raw: unknown): Result<DeleteMemberCommand>;
}

// In port: what this feature offers.
/**
 * Delete a member of a workspace; refused while the member owns any account; returns the deleted member
 * @exposedVia trpc mcp
 */
export interface DeleteMember {
  execute(command: DeleteMemberCommand): Promise<Result<Member>>;
}

// Out port: exactly what this feature needs.
export interface DeleteMemberStore {
  findMember(workspaceId: WorkspaceId, id: MemberId): Promise<Member | undefined>;
  accountsOf(workspaceId: WorkspaceId): Promise<Account[]>;
  delete(member: Member): Promise<void>;
}
