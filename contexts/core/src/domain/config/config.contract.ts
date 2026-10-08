import type { BasePack, Contribution, PackListRules } from "../packs/pack.contract.ts";

/**
 * A project's configuration: the packs it selects, and the project's own
 * pack, `bounded/project`, which depends on every selected pack and carries
 * the project's contributions. Made only by `defineConfig`.
 */
export interface Config {
  readonly __brand: "Config";
  readonly selectedPacks: readonly BasePack[];
  readonly projectPack: BasePack;
}

export interface ConfigSpec<Packs extends readonly BasePack[]> {
  /** The selection: pack objects. `corePack` must be among them for any event to be decided. */
  readonly packs: Packs;
  /** The project's own contributions, to points of selected packs only. */
  readonly contributes?: readonly Contribution<NoInfer<Packs[number]["id"]>>[];
}

export interface ConfigFactory {
  /** `export default defineConfig({ packs: [corePack, …], contributes: [...] })` in bounded.config.ts. */
  defineConfig<const Packs extends readonly BasePack[]>(
    spec: ConfigSpec<Packs> & (Packs extends readonly [] ? unknown : { readonly packs: PackListRules<Packs, "list packs as a tuple of packs", "list each pack once", "each selected pack is a pack with an exact id"> }),
  ): Config;
}
