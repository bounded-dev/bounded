import type { configBrand } from "./config.contract.ts";
import type { Composition } from "../composition/composition.contract.ts";
import { Composition as CompositionFactory } from "../composition/composition.ts";
import type { BasePack } from "../packs/pack.contract.ts";
import { definePack } from "../packs/pack.ts";
import { packIdsFor } from "../packs/pack-id.ts";
import type { Result } from "../shared/result.ts";
import type * as Contract from "./config.contract.ts";

const PROJECT = packIdsFor("bounded")("project");
const NOT_MADE = "This is not a configuration made by defineConfig: export default defineConfig({ packs: [...] })";

/** The project's pack, built from untyped data: composition checks it like any pack. */
const projectPack = definePack as unknown as (spec: object) => BasePack;

class ConfigImpl implements Contract.Config {
  declare readonly __brand: "Config";
  declare readonly [configBrand]: true;

  private constructor(
    readonly selectedPacks: readonly BasePack[],
    readonly projectPack: BasePack,
  ) {
    Object.freeze(this);
  }

  /** Total: whatever it is given, a configuration whose compose names what is wrong. */
  static defineConfig(spec: { readonly packs?: unknown; readonly contributes?: unknown }): Contract.Config {
    const given: { readonly packs?: unknown; readonly contributes?: unknown } = typeof spec === "object" && spec !== null ? spec : {};
    const packs = Array.isArray(given.packs) ? Object.freeze([...given.packs]) : given.packs;
    // The project acts as a final pack that depends on every selected pack, so
    // its contributions follow the same rule as any pack's.
    return new ConfigImpl(packs as readonly BasePack[], projectPack({ id: PROJECT, dependsOn: packs, contributes: given.contributes }));
  }

  static parse(raw: unknown): Result<Contract.Config> {
    return raw instanceof ConfigImpl ? { ok: true, value: raw } : { ok: false, error: NOT_MADE };
  }

  compose(): Result<Composition> {
    if (!Array.isArray(this.selectedPacks)) return { ok: false, error: "A configuration's packs must be a list of packs made with definePack" };
    const all = [...this.selectedPacks, this.projectPack];
    return CompositionFactory.compose(all, all);
  }
}

export type Config = Contract.Config;
export const Config: Contract.ConfigFactory = ConfigImpl;
export const { defineConfig } = Config;
