import type {
  CurrencyCode,
  Result,
  SupportedCurrencies,
  Workspace,
  WorkspaceId,
} from "@dogfood/net-worth/domain";

// Wire input: what callers send.
export interface UpdateWorkspaceCurrenciesInput {
  readonly workspaceId: string;
  readonly baseCurrency: string;
  readonly supportedCurrencies: string;
}

// Command: the input once validated into value objects.
export interface UpdateWorkspaceCurrenciesCommand {
  readonly __brand: "UpdateWorkspaceCurrenciesCommand";
  readonly workspaceId: WorkspaceId;
  readonly baseCurrency: CurrencyCode;
  readonly supportedCurrencies: SupportedCurrencies;
}

export interface UpdateWorkspaceCurrenciesCommandFactory {
  parse(raw: unknown): Result<UpdateWorkspaceCurrenciesCommand>;
}

// In port: what this feature offers.
/**
 * Replace a workspace's base currency and supported currencies (comma-separated ISO 4217 codes; the base must be one of them)
 * @exposedVia trpc mcp
 */
export interface UpdateWorkspaceCurrencies {
  execute(command: UpdateWorkspaceCurrenciesCommand): Promise<Result<Workspace>>;
}

// Out port: exactly what this feature needs.
export interface UpdateWorkspaceCurrenciesStore {
  findWorkspace(id: WorkspaceId): Promise<Workspace | undefined>;
  save(workspace: Workspace): Promise<void>;
}
