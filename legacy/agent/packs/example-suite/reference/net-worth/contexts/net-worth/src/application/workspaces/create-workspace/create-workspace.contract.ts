import type {
  CurrencyCode,
  Result,
  SupportedCurrencies,
  Workspace,
  WorkspaceName,
} from "@dogfood/net-worth/domain";

// Wire input: what callers send.
export interface CreateWorkspaceInput {
  readonly name: string;
  readonly baseCurrency: string;
  readonly supportedCurrencies: string;
}

// Command: the input once validated into value objects.
export interface CreateWorkspaceCommand {
  readonly __brand: "CreateWorkspaceCommand";
  readonly name: WorkspaceName;
  readonly baseCurrency: CurrencyCode;
  readonly supportedCurrencies: SupportedCurrencies;
}

export interface CreateWorkspaceCommandFactory {
  parse(raw: unknown): Result<CreateWorkspaceCommand>;
}

// In port: what this feature offers.
/**
 * Create a workspace with a name, a base currency and its supported currencies (comma-separated ISO 4217 codes; the base must be one of them)
 * @exposedVia trpc mcp
 */
export interface CreateWorkspace {
  execute(command: CreateWorkspaceCommand): Promise<Result<Workspace>>;
}

// Out port: exactly what this feature needs.
export interface CreateWorkspaceStore {
  save(workspace: Workspace): Promise<void>;
}
