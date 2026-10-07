import { ExtensionPoint } from "../extension-points/extension-point.ts";
import type { ExtensionPointHandle } from "../extension-points/extension-point.contract.ts";
import { ExtensionPointId } from "../extension-points/extension-point-id.ts";
import { Contribution } from "../packs/contribution.ts";
import { Pack } from "../packs/pack.ts";
import type { PackName } from "../packs/pack-name.contract.ts";
import type { Result } from "../shared/result.ts";
import type * as Contract from "./composition.contract.ts";

/** One declared point and the values placed on it, in pack order. */
interface Slot {
  readonly point: ExtensionPointHandle<string>;
  readonly values: unknown[];
}

class CompositionImpl implements Contract.Composition {
  declare readonly __brand: "Composition";
  private constructor(
    readonly packs: readonly string[],
    private readonly slots: ReadonlyMap<string, Slot>,
  ) {
    Object.freeze(this);
  }

  static compose(available: readonly Pack[], selected: readonly PackName[]): Result<Composition> {
    // Every available entry must be a genuine pack, selected or not: a name
    // must identify one pack, so duplicates count among all available packs.
    const entries: readonly unknown[] = available;
    for (const entry of entries) {
      if (!Pack.isPack(entry)) {
        const name = typeof entry === "object" && entry !== null && "name" in entry ? String(entry.name) : String(entry);
        return refuse(`Available pack '${name}' was not built with new Pack(...). Build every pack with new Pack({ name, ... })`);
      }
    }
    // Checks run over sorted names, so which refusal comes first never
    // depends on the order packs were listed in.
    const availableNames = available.map((pack) => pack.name).sort();
    const duplicate = availableNames.find((name, i) => availableNames[i + 1] === name);
    if (duplicate !== undefined) return refuse(`Two available packs are named '${duplicate}'. Pack names identify packs: rename one of them`);
    const byName = new Map(available.map((pack) => [pack.name, pack]));

    const names = selected.map((name) => name.value);
    const sorted = [...names].sort();
    for (const [i, name] of sorted.entries()) {
      if (sorted[i + 1] === name) return refuse(`Pack '${name}' is selected twice. Select each pack once`);
      if (!byName.has(name)) return refuse(`Pack '${name}' is selected but not available. Make it available, or remove it from the selection`);
    }
    for (const name of sorted) {
      const malformed = shapeProblem(packOf(byName, name));
      if (malformed !== undefined) return refuse(`Pack '${name}' is malformed: ${malformed}. Fix its definition`);
    }
    for (const name of sorted) {
      for (const dependency of [...packOf(byName, name).dependsOn].sort()) {
        if (!names.includes(dependency)) {
          return refuse(`Pack '${name}' depends on pack '${dependency}', which is not selected. Select '${dependency}' as well, or remove the dependency`);
        }
      }
    }

    const ordered = dependencyOrder(sorted, byName);
    if (!ordered.ok) return ordered;
    const packs = ordered.value.map((name) => packOf(byName, name));

    // Every point is declared before any value is placed, so a pack may
    // contribute to a point declared by a pack that comes later in order.
    const slots = new Map<string, Slot>();
    for (const pack of packs) {
      for (const point of pack.declares) {
        const id = ExtensionPointId.parse(point.id);
        if (!id.ok) return refuse(`Pack '${pack.name}' declares extension point '${point.id}': ${id.error}. Rename it`);
        if (point.owner !== pack.name) {
          return refuse(
            `Pack '${pack.name}' declares extension point '${point.id}', which is owned by pack '${point.owner}'. A pack declares only its own extension points: declare it in '${point.owner}'`,
          );
        }
        const existing = slots.get(point.id);
        if (existing !== undefined) {
          return refuse(`Extension point '${point.id}' is declared twice, by packs '${existing.point.owner}' and '${pack.name}'. Give one of them a different id`);
        }
        slots.set(point.id, { point, values: [] });
      }
    }

    for (const pack of packs) {
      for (const contribution of pack.contributes) {
        const { id, owner } = contribution.point;
        if (owner !== pack.name && !pack.dependsOn.includes(owner)) {
          return refuse(
            `Pack '${pack.name}' contributes to extension point '${id}', owned by pack '${owner}', but does not depend on '${owner}'. Add '${owner}' to the dependencies of '${pack.name}', or remove the contribution`,
          );
        }
        const slot = slots.get(id);
        if (slot === undefined || slot.point !== contribution.point) {
          return refuse(
            `Pack '${pack.name}' contributes to extension point '${id}', which its owner '${owner}' does not declare. Declare '${id}' in '${owner}', or contribute to a point '${owner}' declares`,
          );
        }
        for (const value of contribution.values) {
          const problem = ExtensionPoint.checkValue(slot.point, value);
          if (problem !== undefined) {
            return refuse(`Pack '${pack.name}' contributes an invalid value to extension point '${id}': ${problem}. Fix the value, or remove the contribution`);
          }
        }
        slot.values.push(...contribution.values);
      }
    }
    return { ok: true, value: new CompositionImpl(Object.freeze(ordered.value), slots) };
  }

  read<Value>(point: ExtensionPoint<Value, string>): Result<readonly Value[]> {
    const slot = this.slots.get(point.id);
    if (slot === undefined) {
      const why = this.packs.includes(point.owner)
        ? `its owner '${point.owner}' is selected but does not declare it. Declare it in '${point.owner}', or read a point '${point.owner}' declares`
        : `its owner '${point.owner}' is not selected. Select '${point.owner}' to use it`;
      return refuse(`Extension point '${point.id}' does not exist in this composition: ${why}`);
    }
    if (slot.point !== point) {
      return refuse(
        `Extension point '${point.id}' in this composition is a different object from the one read: use the extension point that pack '${slot.point.owner}' exports`,
      );
    }
    // The one cast. A slot holds the values of one point object; a value
    // reaches it only from a genuine Contribution (checked by instanceof)
    // built against that same object (checked by identity), whose
    // constructor typed it as that point's `Value`.
    return { ok: true, value: Object.freeze([...slot.values]) as readonly Value[] };
  }
}

function refuse(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

/** What is wrong with a pack built from untyped data, if anything. */
function shapeProblem(pack: Pack): string | undefined {
  if (!Array.isArray(pack.dependsOn) || !pack.dependsOn.every((name) => typeof name === "string")) return "its dependsOn must be a list of pack names";
  if (!Array.isArray(pack.declares) || !pack.declares.every(ExtensionPoint.isExtensionPoint)) {
    return "its declares must be a list of extension points made with ExtensionPoint.ownedBy(...).declare(...)";
  }
  if (!Array.isArray(pack.contributes) || !pack.contributes.every(Contribution.isContribution)) {
    return "its contributes must be a list of contributions made with new Contribution(...)";
  }
  return undefined;
}

function packOf(byName: ReadonlyMap<string, Pack>, name: string): Pack {
  const pack = byName.get(name);
  if (pack === undefined) throw new Error(`unreachable: pack '${name}' was checked to be available`);
  return pack;
}

/**
 * The selected packs in composition order (see Composition.packs). A cycle is
 * refused with the cycle written out.
 */
function dependencyOrder(sorted: readonly string[], byName: ReadonlyMap<string, Pack>): Result<string[]> {
  const order: string[] = [];
  const done = new Set<string>();
  const visit = (name: string, path: readonly string[]): string | undefined => {
    if (done.has(name)) return undefined;
    if (path.includes(name)) {
      const cycle = [...path.slice(path.indexOf(name)), name].join(" -> ");
      return `Packs depend on each other in a cycle: ${cycle}. Break the cycle by moving what they share into a pack they all depend on`;
    }
    for (const dependency of [...packOf(byName, name).dependsOn].sort()) {
      const cycle = visit(dependency, [...path, name]);
      if (cycle !== undefined) return cycle;
    }
    done.add(name);
    order.push(name);
    return undefined;
  };
  for (const name of sorted) {
    const cycle = visit(name, []);
    if (cycle !== undefined) return refuse(cycle);
  }
  return { ok: true, value: order };
}

export type Composition = Contract.Composition;
export const Composition: Contract.CompositionFactory = CompositionImpl;
