import type { Result, Workspace, WorkspaceId } from "@dogfood/net-worth/domain";

// Wire input: what callers send.
export interface GetWorkspaceInput {
  readonly workspaceId: string;
}

// Command: the input once validated into value objects.
export interface GetWorkspaceCommand {
  readonly __brand: "GetWorkspaceCommand";
  readonly workspaceId: WorkspaceId;
}

export interface GetWorkspaceCommandFactory {
  parse(raw: unknown): Result<GetWorkspaceCommand>;
}

// In port: what this feature offers.
/**
 * Get a workspace's settings: its name, base currency and supported currencies
 * @exposedVia trpc mcp
 */
export interface GetWorkspace {
  execute(command: GetWorkspaceCommand): Promise<Result<Workspace>>;
}

// Out port: exactly what this feature needs.
export interface GetWorkspaceStore {
  findWorkspace(id: WorkspaceId): Promise<Workspace | undefined>;
}
