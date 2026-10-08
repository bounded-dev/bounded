import type { compositionBrand } from "./composition.contract.ts";
import { pointsOf } from "../packs/pack.ts";
import type { BasePack, BasePoint, ExtensionPoint } from "../packs/pack.contract.ts";
import type { PackId as PackIdType } from "../packs/pack-id.contract.ts";
import { packIdText } from "../packs/pack-id.ts";
import type { Result } from "../shared/result.ts";
import { AvailablePacks, NOT_LISTS } from "./available-packs.ts";
import type * as Contract from "./composition.contract.ts";
import { byId, SelectedPacks } from "./selected-packs.ts";

class CompositionImpl implements Contract.Composition {
  declare readonly __brand: "Composition";
  declare readonly [compositionBrand]: true;

  private constructor(
    readonly packs: readonly BasePack[],
    private readonly slots: ReadonlyMap<BasePoint, readonly Contract.Entry<unknown>[]>,
  ) {
    Object.freeze(this);
  }

  static compose(availablePacks: readonly BasePack[], selectedPacks: readonly BasePack[]): Result<Composition> {
    if (!Array.isArray(availablePacks) || !Array.isArray(selectedPacks)) return refuse(NOT_LISTS);
    const available = AvailablePacks.parse(availablePacks);
    if (!available.ok) return available;
    const selected = SelectedPacks.parse(selectedPacks);
    if (!selected.ok) return selected;
    // Every check runs in id order, so which refusal comes first never
    // depends on the order packs were listed in.
    const chosen = selected.value.packs;
    const missing = chosen.find((pack) => !available.value.includes(pack));
    if (missing !== undefined) return refuse(`Pack '${packIdText(missing.id)}' is selected but not available. Make it available, or remove it from the selection`);
    const malformed = chosen.find((pack) => pack.problem !== undefined);
    if (malformed !== undefined) return refuse(`Pack '${malformed.id.value}' is malformed: ${malformed.problem}. Fix its definition`);
    for (const pack of chosen) {
      for (const dependency of [...pack.dependsOn].sort(byId)) {
        if (chosen.includes(dependency)) continue;
        return refuse(
          chosen.some((other) => other.id.value === packIdText(dependency.id))
            ? `Pack '${pack.id.value}' depends on a pack with the id '${packIdText(dependency.id)}' that is not the available one (another pack with that id, or another copy of it). Make the pack it depends on available instead`
            : `Pack '${pack.id.value}' depends on pack '${packIdText(dependency.id)}', which is not selected. Select it as well, or remove the dependency`,
        );
      }
    }

    const order = dependencyOrder(chosen);
    const slots = new Map<BasePoint, Contract.Entry<unknown>[]>();
    for (const pack of order) {
      for (const point of pointsOf(pack)) {
        slots.set(point, []);
        const placed = place(pack, point, point.ownValues, slots);
        if (placed !== undefined) return refuse(placed);
      }
      for (const { point, values } of pack.contributes) {
        const owner = point.owner;
        if (!pack.dependsOn.includes(owner)) {
          return refuse(
            `Pack '${pack.id.value}' contributes to extension point '${point.id}', owned by pack '${packIdText(owner.id)}', but does not depend on it. Add '${packIdText(owner.id)}' to its dependencies, or remove the contribution`,
          );
        }
        const placed = place(pack, point, values, slots);
        if (placed !== undefined) return refuse(placed);
      }
    }
    return { ok: true, value: new CompositionImpl(Object.freeze(order), slots) };
  }

  static parse(raw: unknown): Result<Composition> {
    return raw instanceof CompositionImpl ? { ok: true, value: raw } : refuse("Dispatch was given something that is not a composition");
  }

  read<Value>(point: ExtensionPoint<Value, PackIdType>): Result<readonly Value[]> {
    const entries = this.entries(point);
    return entries.ok ? { ok: true, value: Object.freeze(entries.value.map((entry) => entry.value)) } : entries;
  }

  entries<Value>(point: ExtensionPoint<Value, PackIdType>): Result<readonly Contract.Entry<Value>[]> {
    const entries = this.slots.get(point);
    if (entries === undefined) {
      const owner = point.owner.id;
      return refuse(
        this.packs.some((pack) => pack.id.value === packIdText(owner))
          ? `Extension point '${point.id}' belongs to a pack with the id '${packIdText(owner)}' that is not the selected one (another pack with that id, or another copy of it). Read the point of the selected pack`
          : `Extension point '${point.id}' does not exist in this composition: its owner '${packIdText(owner)}' is not selected. Select it to use the point`,
      );
    }
    // The one cast in composition: every value on this point's slot was
    // returned by this point's own check, whose type is (raw) => Result<Value>.
    return { ok: true, value: Object.freeze([...entries]) as readonly Contract.Entry<Value>[] };
  }
}

function refuse(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

/** Check each value with the point's own check and store what it returns; a refusal message, or undefined. */
function place(pack: BasePack, point: BasePoint, values: readonly unknown[], slots: Map<BasePoint, Contract.Entry<unknown>[]>): string | undefined {
  const slot = slots.get(point);
  if (slot === undefined) return `Pack '${pack.id.value}' contributes to extension point '${point.id}', which has no place in this composition. Report this as a defect`;
  for (const raw of values) {
    const checked = point.parseValue(raw);
    if (!checked.ok) return `Pack '${pack.id.value}' contributes an invalid value to extension point '${point.id}': ${checked.error}. Fix the value, or remove the contribution`;
    slot.push(Object.freeze({ fromPackId: pack.id, value: checked.value }));
  }
  return undefined;
}

/** The packs in composition order (see Composition.packs). Packs are frozen and depend only on packs that already existed, so there is no cycle. */
function dependencyOrder(packs: readonly BasePack[]): BasePack[] {
  const order: BasePack[] = [];
  const visit = (pack: BasePack): void => {
    if (order.includes(pack)) return;
    for (const dependency of [...pack.dependsOn].sort(byId)) visit(dependency);
    order.push(pack);
  };
  for (const pack of packs) visit(pack);
  return order;
}

export type Composition = Contract.Composition;
export const Composition: Contract.CompositionFactory = CompositionImpl;
