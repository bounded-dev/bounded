import type { CurrencyCode } from "../currencies/currency-code.contract.ts";
import type { SupportedCurrencies } from "../currencies/supported-currencies.contract.ts";
import type { WorkspaceId } from "./workspace-id.contract.ts";
import type { WorkspaceName } from "./workspace-name.contract.ts";

/** A tenant: everything else in Wrthy belongs to exactly one workspace. */
export interface Workspace {
  readonly __brand: "Workspace";
  readonly id: WorkspaceId;
  readonly name: WorkspaceName;
  readonly baseCurrency: CurrencyCode;
  readonly supportedCurrencies: SupportedCurrencies;
  equals(other: Workspace): boolean;
  toJSON(): {
    readonly id: string;
    readonly name: string;
    readonly baseCurrency: string;
    readonly supportedCurrencies: string;
  };
  /** Whether the base currency is one of the supported currencies. */
  hasSupportedBase(): boolean;
}

export interface WorkspaceFactory {
  new (
    id: WorkspaceId,
    name: WorkspaceName,
    baseCurrency: CurrencyCode,
    supportedCurrencies: SupportedCurrencies,
  ): Workspace;
}
