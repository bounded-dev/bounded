import { Composition } from "../composition/composition.ts";
import { definePack } from "../packs/pack.ts";
import type { BasePack } from "../packs/pack.contract.ts";
import { packIdsFor } from "../packs/pack-id.ts";
import type * as Contract from "./config.contract.ts";

const PROJECT = packIdsFor("bounded")("project");
const made = new WeakSet<object>();

/** The project's pack, built from untyped data: composition checks it like any pack. */
const projectPack = definePack as unknown as (spec: object) => BasePack;

function defineConfigImpl(spec: { readonly packs?: unknown; readonly contributes?: unknown }): Contract.Config {
  const given = typeof spec === "object" && spec !== null ? spec : {};
  const packs = Array.isArray(given.packs) ? Object.freeze([...given.packs]) : given.packs;
  // The project acts as a final pack that depends on every selected pack, so
  // its contributions follow the same rule as any pack's.
  const config = Object.freeze({ __brand: "Config" as const, selectedPacks: packs, projectPack: projectPack({ id: PROJECT, dependsOn: packs, contributes: given.contributes }) });
  made.add(config);
  return config as Contract.Config;
}

const factory: Contract.ConfigFactory = { defineConfig: defineConfigImpl };
export const { defineConfig } = factory;

/** Whether `x` was made by defineConfig in this copy of bounded. */
export function isConfig(x: unknown): x is Contract.Config {
  return typeof x === "object" && x !== null && made.has(x);
}

/** The composition of a configuration: its packs and its project pack, all selected. */
export const composeConfig: Contract.ComposeConfig = (config) => {
  if (!isConfig(config)) return { ok: false, error: "This is not a configuration made by defineConfig: export default defineConfig({ packs: [...] })" };
  if (!Array.isArray(config.selectedPacks)) return { ok: false, error: "A configuration's packs must be a list of packs made with definePack" };
  const all = [...config.selectedPacks, config.projectPack];
  return Composition.compose(all, all);
};

export type Config = Contract.Config;
