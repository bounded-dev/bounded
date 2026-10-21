import type { configBrand } from "./config.contract.ts";
import type { Composition } from "../composition/composition.contract.ts";
import { Composition as CompositionFactory } from "../composition/composition.ts";
import { firstDependent, SelectedPacks } from "../composition/selected-packs.ts";
import type { BasePack } from "../packs/pack.contract.ts";
import { definePack } from "../packs/pack.ts";
import { packIdText, packIdsFor } from "../packs/pack-id.ts";
import type { Result } from "../shared/result.ts";
import type { PortProvision } from "../lifecycle/ports.contract.ts";
import type * as Contract from "./config.contract.ts";

const PROJECT = packIdsFor("bounded")("project");
const NOT_MADE = "This is not a configuration made by defineConfig: export default defineConfig({ packs: [...] })";

/** The project's pack, built from untyped data: composition checks it like any pack. */
const projectPack = definePack as unknown as (spec: object) => BasePack;

class ConfigImpl implements Contract.Config {
  declare readonly __brand: "Config";
  declare readonly [configBrand]: true;

  private constructor(
    readonly listedPacks: readonly BasePack[],
    readonly projectPack: BasePack,
    readonly ports: readonly PortProvision[],
    readonly portProvisionsProblem: string | undefined,
  ) {
    Object.freeze(this);
  }

  /** Total: whatever it is given, a configuration whose compose names what is wrong. */
  static defineConfig(spec: { readonly packs?: unknown; readonly contributes?: unknown; readonly ports?: unknown }): Contract.Config {
    const given: { readonly packs?: unknown; readonly contributes?: unknown; readonly ports?: unknown } = typeof spec === "object" && spec !== null ? spec : {};
    const packs = Array.isArray(given.packs) ? Object.freeze([...given.packs]) : given.packs;
    const ports = Array.isArray(given.ports) ? Object.freeze([...given.ports]) : [];
    const portProvisionsProblem = given.ports === undefined || Array.isArray(given.ports)
      ? undefined : "bounded.config.ts ports must be a list of Ports.provide(key, open) values: correct or remove ports";
    // The project acts as a final pack that depends on every listed pack, so
    // its contributions follow the same rule as any pack's.
    return new ConfigImpl(packs as readonly BasePack[], projectPack({ id: PROJECT, dependsOn: packs, contributes: given.contributes }), ports as readonly PortProvision[], portProvisionsProblem);
  }

  static parse(raw: unknown): Result<Contract.Config> {
    return raw instanceof ConfigImpl ? { ok: true, value: raw } : { ok: false, error: NOT_MADE };
  }

  compose(): Result<Composition> {
    if (!Array.isArray(this.listedPacks)) return { ok: false, error: "A configuration's packs must be a list of packs made with definePack" };
    const listed = [...this.listedPacks, this.projectPack];
    // The selection: the listed packs and every pack they depend on (ADR 2026-018).
    // In a configuration every pack object present is available.
    const selection = SelectedPacks.parse(listed);
    if (!selection.ok) return selection;
    const refused = this.contributionToUnlistedPack(selection.value.packs);
    if (refused !== undefined) return { ok: false, error: refused };
    return CompositionFactory.compose(selection.value.packs, listed);
  }

  /**
   * The project contributes only to points of packs it lists, even when a
   * listed pack brings the owner in (ADR 2026-003 rule 1, ADR 2026-018): a
   * refusal, or undefined. Its fix: for another copy of a listed pack, to
   * contribute to the listed pack's point; for another copy of a brought-in
   * pack, to list the selected copy and contribute to its point; otherwise to
   * add the owner to packs. A project pack with a problem is left to
   * composition's malformed refusal.
   */
  private contributionToUnlistedPack(selectedPacks: readonly BasePack[]): string | undefined {
    if (this.projectPack.problem !== undefined) return undefined;
    for (const { point } of this.projectPack.contributes) {
      const owner = point.owner;
      if (this.listedPacks.includes(owner)) continue;
      const ownerId = packIdText(owner.id);
      const prefix = `The project contributes to extension point '${point.id}', owned by`;
      if (this.listedPacks.some((pack) => packIdText(pack.id) === ownerId)) {
        return `${prefix} a pack with the id '${ownerId}' that is not the one bounded.config.ts lists in packs (another pack with that id, or another copy of it). Contribute to the point of the listed pack, or remove the contribution`;
      }
      const { note, fix } = broughtIn(owner, ownerId, selectedPacks);
      return `${prefix} pack '${ownerId}', which bounded.config.ts does not list in packs${note}. ${fix}, or remove the contribution`;
    }
    return undefined;
  }
}

/**
 * What brings an unlisted owner, or another copy of it, into the selection,
 * for a refusal, and the fix: the owner itself, brought in by a dependent
 * (add it to packs); a selected pack with its id that is another copy (list
 * that selected copy and contribute to its point: contributing to it unlisted
 * is refused too, and listing the owner makes two copies); or nothing when
 * neither is selected (add it to packs).
 */
function broughtIn(owner: BasePack, ownerId: string, selectedPacks: readonly BasePack[]): { note: string; fix: string } {
  const addOwner = `Add '${ownerId}' to packs`;
  const selectedWithId = selectedPacks.find((pack) => packIdText(pack.id) === ownerId);
  const dependent = selectedWithId === undefined ? undefined : firstDependent(selectedPacks, selectedWithId);
  if (selectedWithId === undefined || dependent === undefined) return { note: "", fix: addOwner };
  return selectedWithId === owner
    ? { note: ` (it is selected only because '${packIdText(dependent.id)}' depends on it)`, fix: addOwner }
    : {
        note: ` (the selected '${ownerId}' is another copy, brought in by '${packIdText(dependent.id)}')`,
        fix: `List the selected '${ownerId}' in packs and contribute to its point`,
      };
}

export type Config = Contract.Config;
export const Config: Contract.ConfigFactory = ConfigImpl;
export const { defineConfig } = Config;
