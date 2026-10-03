import type { Result, Workspace, WorkspaceId, WorkspaceName } from "@dogfood/net-worth/domain";

// Wire input: what callers send.
export interface RenameWorkspaceInput {
  readonly workspaceId: string;
  readonly name: string;
}

// Command: the input once validated into value objects.
export interface RenameWorkspaceCommand {
  readonly __brand: "RenameWorkspaceCommand";
  readonly workspaceId: WorkspaceId;
  readonly name: WorkspaceName;
}

export interface RenameWorkspaceCommandFactory {
  parse(raw: unknown): Result<RenameWorkspaceCommand>;
}

// In port: what this feature offers.
/**
 * Rename a workspace; its currencies are unchanged
 * @exposedVia trpc mcp
 */
export interface RenameWorkspace {
  execute(command: RenameWorkspaceCommand): Promise<Result<Workspace>>;
}

// Out port: exactly what this feature needs.
export interface RenameWorkspaceStore {
  findWorkspace(id: WorkspaceId): Promise<Workspace | undefined>;
  save(workspace: Workspace): Promise<void>;
}
