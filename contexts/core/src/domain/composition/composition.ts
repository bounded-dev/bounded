import { checkValue, declarationOf, isGenuine } from "../packs/pack.ts";
import type { AnyPack, AnyPoint, ExtensionPoint } from "../packs/pack.contract.ts";
import type { PackId as PackIdType } from "../packs/pack-id.contract.ts";
import { PackId } from "../packs/pack-id.ts";
import type { Result } from "../shared/result.ts";
import type * as Contract from "./composition.contract.ts";

const COPY = "by this copy of bounded";

class CompositionImpl implements Contract.Composition {
  declare readonly __brand: "Composition";
  private constructor(
    readonly packs: readonly AnyPack[],
    private readonly slots: ReadonlyMap<AnyPoint, readonly Contract.Entry<unknown>[]>,
  ) {
    Object.freeze(this);
  }

  static compose(available: readonly AnyPack[], selected: readonly AnyPack[]): Result<Composition> {
    if (!Array.isArray(available) || !Array.isArray(selected)) return refuse("Compose takes a list of available packs and a list of selected packs");
    const notGenuine = (which: string, list: readonly unknown[]) => {
      const entry = list.find((x) => !isGenuine(x, "Pack"));
      const id = typeof entry === "object" && entry !== null && "id" in entry ? String(entry.id) : String(entry);
      return `${which} pack '${id}' was not built with definePack(...), or was built by a different copy of bounded. Build every pack with definePack from one copy`;
    };
    if (available.some((x) => !isGenuine(x, "Pack"))) return refuse(notGenuine("Available", available));
    for (const pack of available) {
      const id = PackId.parse(pack.id);
      if (!id.ok) return refuse(`Available pack '${String(pack.id)}' has an invalid id: ${id.error}. Give it an id from packIdsFor(...)`);
    }
    // Every check runs in id order, so which refusal comes first never
    // depends on the order packs were listed in.
    const ids = available.map((pack) => pack.id).sort();
    const duplicate = ids.find((id, i) => ids[i + 1] === id);
    if (duplicate !== undefined) return refuse(`Two available packs have the id '${duplicate}'. An id names one pack in selections and messages: give each pack its own`);

    if (selected.some((x) => !isGenuine(x, "Pack"))) return refuse(notGenuine("Selected", selected));
    const chosen = [...selected].sort(byId);
    for (const [i, pack] of chosen.entries()) {
      if (chosen[i + 1] === pack) return refuse(`Pack '${pack.id}' is selected twice. Select each pack once`);
      if (!available.includes(pack)) return refuse(`Pack '${pack.id}' is selected but not available. Make it available, or remove it from the selection`);
    }
    for (const pack of chosen) {
      const problem = shapeProblem(pack);
      if (problem !== undefined) return refuse(`Pack '${pack.id}' is malformed: ${problem}. Fix its definition`);
    }
    for (const pack of chosen) {
      for (const dependency of [...pack.dependsOn].sort(byId)) {
        if (chosen.includes(dependency)) continue;
        return refuse(
          chosen.some((other) => other.id === dependency.id)
            ? `Pack '${pack.id}' depends on a pack with the id '${dependency.id}' that is not the available one (another pack with that id, or another copy of it). Make the pack it depends on available instead`
            : `Pack '${pack.id}' depends on pack '${dependency.id}', which is not selected. Select it as well, or remove the dependency`,
        );
      }
    }

    const order = dependencyOrder(chosen);
    const slots = new Map<AnyPoint, Contract.Entry<unknown>[]>();
    for (const pack of order) {
      for (const point of Object.values(pack.points)) {
        slots.set(point, []);
        const placed = place(pack, point, declarationOf(point)?.values ?? [], slots);
        if (placed !== undefined) return refuse(placed);
      }
      for (const { point, values } of pack.contributes) {
        const owner = point.owner;
        if (!pack.dependsOn.includes(owner)) {
          return refuse(
            `Pack '${pack.id}' contributes to extension point '${point.id}', owned by pack '${owner.id}', but does not depend on it. Add '${owner.id}' to its dependencies, or remove the contribution`,
          );
        }
        const placed = place(pack, point, values, slots);
        if (placed !== undefined) return refuse(placed);
      }
    }
    return { ok: true, value: new CompositionImpl(Object.freeze(order), slots) };
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
        this.packs.some((pack) => pack.id === owner)
          ? `Extension point '${point.id}' belongs to a pack with the id '${owner}' that is not the selected one (another pack with that id, or another copy of it). Read the point of the selected pack`
          : `Extension point '${point.id}' does not exist in this composition: its owner '${owner}' is not selected. Select it to use the point`,
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

const byId = (a: AnyPack, b: AnyPack): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Check each value with the point's own check and store what it returns; a refusal message, or undefined. */
function place(pack: AnyPack, point: AnyPoint, values: readonly unknown[], slots: Map<AnyPoint, Contract.Entry<unknown>[]>): string | undefined {
  const slot = slots.get(point);
  if (slot === undefined) return `Pack '${pack.id}' contributes to extension point '${point.id}', which has no place in this composition. Report this as a defect`;
  for (const raw of values) {
    const checked = checkValue(point, raw);
    if (!checked.ok) return `Pack '${pack.id}' contributes an invalid value to extension point '${point.id}': ${checked.error}. Fix the value, or remove the contribution`;
    slot.push(Object.freeze({ from: pack.id, value: checked.value }));
  }
  return undefined;
}

/** What is wrong with a pack built from untyped data, if anything. */
function shapeProblem(pack: AnyPack): string | undefined {
  const { dependsOn, points, contributes } = pack;
  if (!Array.isArray(dependsOn) || !dependsOn.every((dependency) => isGenuine(dependency, "Pack"))) return `its dependsOn must be a list of packs made with definePack(...) ${COPY}`;
  const twice = dependsOn.find((dependency, i) => dependsOn.indexOf(dependency) !== i);
  if (twice !== undefined) return `it lists '${twice.id}' twice in dependsOn`;
  for (const [key, point] of Object.entries(points)) {
    if (!/^[a-z][a-zA-Z0-9]*$/.test(key)) return `its point key '${key}' must be a camelCase word, such as 'protectedPaths'`;
    if (!isGenuine(point, "ExtensionPoint") || point.owner !== pack) return `its points must each be declared with point(...) ${COPY}`;
    const declaration = declarationOf(point);
    if (typeof declaration?.check !== "function") return `its point '${key}' has no check: every point parses the values it accepts`;
    if (!Array.isArray(declaration.values)) return `the own values of its point '${key}' must be a list`;
  }
  const genuineContribution = (c: unknown) => isGenuine(c, "Contribution") && isGenuine(c.point, "ExtensionPoint") && Array.isArray(c.values);
  if (!Array.isArray(contributes) || !contributes.every(genuineContribution)) return `its contributes must be a list of contributions made with contribution(...) ${COPY}`;
  return undefined;
}

/** The packs in composition order (see Composition.packs). Packs are frozen and depend only on packs that already existed, so there is no cycle. */
function dependencyOrder(packs: readonly AnyPack[]): AnyPack[] {
  const order: AnyPack[] = [];
  const visit = (pack: AnyPack): void => {
    if (order.includes(pack)) return;
    for (const dependency of [...pack.dependsOn].sort(byId)) visit(dependency);
    order.push(pack);
  };
  for (const pack of packs) visit(pack);
  return order;
}

export type Composition = Contract.Composition;
export const Composition: Contract.CompositionFactory = CompositionImpl;
