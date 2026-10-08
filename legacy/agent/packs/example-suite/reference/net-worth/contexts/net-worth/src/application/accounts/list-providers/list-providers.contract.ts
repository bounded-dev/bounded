import type { Provider, Result, WorkspaceId } from "@dogfood/net-worth/domain";

// Wire input: what callers send.
export interface ListProvidersInput {
  readonly workspaceId: string;
}

// Command: the input once validated into value objects.
export interface ListProvidersCommand {
  readonly __brand: "ListProvidersCommand";
  readonly workspaceId: WorkspaceId;
}

export interface ListProvidersCommandFactory {
  parse(raw: unknown): Result<ListProvidersCommand>;
}

// In port: what this feature offers.
/**
 * List the providers (institutions) already used by the accounts of a workspace, once each ignoring case, sorted; for suggestions
 * @exposedVia trpc mcp
 */
export interface ListProviders {
  execute(command: ListProvidersCommand): Promise<Provider[]>;
}

// Out port: exactly what this feature needs.
export interface ListProvidersStore {
  /** One provider per account of the workspace, as stored: "" and duplicates included. */
  providersOf(workspaceId: WorkspaceId): Promise<Provider[]>;
}
