import type { Result } from "../shared/result.ts";
import type { BasePortKey, PortKey } from "./port-key.contract.ts";

/** The brand only PortProvision itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const portProvisionBrand: unique symbol;
/** The brand only Ports itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const portsBrand: unique symbol;

/** An adapter for one port, opened for a project's root, lazily, at most once. */
export interface PortProvision {
  readonly __brand: "PortProvision";
  readonly [portProvisionBrand]: true;
  readonly key: BasePortKey;
}

/** The adapters a host provides for one project. */
export interface Ports {
  readonly __brand: "Ports";
  readonly [portsBrand]: true;
  /** The adapter for `key`, opened on first use, or why there is none (not provided, or opening it threw): callers fail closed. Never throws. */
  get<T>(key: PortKey<T>): Result<T>;
  /** Whether an adapter is provided for `key`. */
  provides(key: BasePortKey): boolean;
}

export interface PortsFactory {
  /** An adapter for `key`, opened by `open(projectRoot)`: exactly the port's type. */
  provide<T>(key: PortKey<T>, open: (projectRoot: string) => NoInfer<T>): PortProvision;
  /** The ports of the project at `projectRoot`, or why not: a provision not made by provide, or two for the same port. */
  forProject(projectRoot: string, provisions: readonly PortProvision[]): Result<Ports>;
}
