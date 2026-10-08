import type { Member, MemberName, Result, WorkspaceId } from "@dogfood/net-worth/domain";

// Wire input: what callers send.
export interface AddMemberInput {
  readonly workspaceId: string;
  readonly name: string;
}

// Command: the input once validated into value objects.
export interface AddMemberCommand {
  readonly __brand: "AddMemberCommand";
  readonly workspaceId: WorkspaceId;
  readonly name: MemberName;
}

export interface AddMemberCommandFactory {
  parse(raw: unknown): Result<AddMemberCommand>;
}

// In port: what this feature offers.
/**
 * Add a member (a person who can later own accounts) to a workspace; member names are unique within a workspace, ignoring case
 * @exposedVia trpc mcp
 */
export interface AddMember {
  execute(command: AddMemberCommand): Promise<Result<Member>>;
}

// Out port: exactly what this feature needs.
export interface AddMemberStore {
  workspaceExists(id: WorkspaceId): Promise<boolean>;
  membersOf(workspaceId: WorkspaceId): Promise<Member[]>;
  save(member: Member): Promise<void>;
}
