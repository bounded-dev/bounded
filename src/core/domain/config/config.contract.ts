import type { Composition } from "../composition/composition.contract.ts";
import type { BasePack, Contribution, PackListRules } from "../packs/pack.contract.ts";
import type { Result } from "../shared/result.ts";
import type { PortProvision } from "../lifecycle/ports.contract.ts";

/** The brand only Config itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const configBrand: unique symbol;

/**
 * A project's configuration: the packs it lists, and the project's own pack,
 * `bounded/project`, which depends on every listed pack and carries the
 * project's contributions. The selection is the listed packs and every pack
 * they depend on, transitively (ADR 2026-018). Made only by `defineConfig`.
 */
export interface Config {
  readonly __brand: "Config";
  readonly [configBrand]: true;
  /** The packs the configuration lists, as given. */
  readonly listedPacks: readonly BasePack[];
  /** The project's explicit adapters for selected packs' declared ports. */
  readonly ports: readonly PortProvision[];
  /** Why the project's ports list could not be read, for the wiring validator. */
  readonly portProvisionsProblem: string | undefined;
  readonly projectPack: BasePack;
  /** Its packs composed: the listed packs, every pack they depend on and the project's own pack; or why they cannot be. Never throws. */
  compose(): Result<Composition>;
}

export interface ConfigSpec<Packs extends readonly BasePack[]> {
  /** The listed packs: pack objects. Every pack they depend on is selected with them. `corePack` must be selected, listed or brought in, for any event to be decided. */
  readonly packs: Packs;
  /** The project's own contributions, to points of listed packs only. */
  readonly contributes?: readonly Contribution<NoInfer<Packs[number]["id"]>>[];
  /** Adapters supplied by the project, opened only when a selected pack uses their port. */
  readonly ports?: readonly PortProvision[];
}

export interface ConfigFactory {
  /**
   * `export default defineConfig({ packs: [protectedPathsPack], contributes: [...] })`
   * in bounded.config.ts: the protected-paths pack brings in `corePack`, which is listed
   * only to contribute to its points.
   */
  defineConfig<const Packs extends readonly BasePack[]>(
    spec: ConfigSpec<Packs> & (Packs extends readonly [] ? unknown : { readonly packs: PackListRules<Packs, "list packs as a tuple of packs", "list each pack once", "each selected pack is a pack with an exact id"> }),
  ): Config;
  /** The configuration itself when `raw` was made by defineConfig in this copy of bounded, or why not. */
  parse(raw: unknown): Result<Config>;
}
