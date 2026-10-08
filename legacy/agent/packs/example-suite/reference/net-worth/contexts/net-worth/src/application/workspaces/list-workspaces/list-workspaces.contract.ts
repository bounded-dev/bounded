import type { Workspace } from "@dogfood/net-worth/domain";

// In port: what this feature offers.
/**
 * List every workspace, sorted by name
 * @exposedVia trpc mcp
 */
export interface ListWorkspaces {
  execute(): Promise<Workspace[]>;
}

// Out port: exactly what this feature needs.
export interface ListWorkspacesStore {
  findAll(): Promise<Workspace[]>;
}
