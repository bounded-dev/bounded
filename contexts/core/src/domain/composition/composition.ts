import type { ExtensionPoint, ExtensionPointHandle } from "../extension-points/extension-point.contract.ts";
import { ExtensionPointId } from "../extension-points/extension-point-id.ts";
import type { Pack } from "../packs/pack.contract.ts";
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
    const byName = new Map<string, Pack>();
    for (const pack of available) {
      if (byName.has(pack.name)) return refuse(`Two available packs are named '${pack.name}'. Pack names identify packs: rename one of them`);
      byName.set(pack.name, pack);
    }

    // Checks run over sorted names, so even which refusal comes first never
    // depends on the order packs were listed in.
    const names = selected.map((name) => name.value);
    const sorted = [...names].sort();
    for (const [i, name] of sorted.entries()) {
      if (sorted[i + 1] === name) return refuse(`Pack '${name}' is selected twice. Select each pack once`);
      if (!byName.has(name)) return refuse(`Pack '${name}' is selected but not available. Make it available, or remove it from the selection`);
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
        const [problem] = contribution.problems();
        if (problem !== undefined) {
          return refuse(`Pack '${pack.name}' contributes an invalid value to extension point '${id}': ${problem}. Fix the value, or remove the contribution`);
        }
        slot.values.push(...contribution.values);
      }
    }
    return { ok: true, value: new CompositionImpl(Object.freeze(ordered.value), slots) };
  }

  read<Value>(point: ExtensionPoint<Value, string>): Result<readonly Value[]> {
    const slot = this.slots.get(point.id);
    if (slot === undefined) {
      return refuse(`Extension point '${point.id}' does not exist in this composition: its owner '${point.owner}' is not selected. Select '${point.owner}' to use it`);
    }
    if (slot.point !== point) {
      return refuse(
        `Extension point '${point.id}' in this composition is a different object from the one read: use the extension point that pack '${slot.point.owner}' exports`,
      );
    }
    // The one unchecked step. A slot holds the values of one point object,
    // and a value reaches it only through a Contribution typed against that
    // same object (checked above by identity), so every value is a `Value`.
    return { ok: true, value: Object.freeze([...slot.values]) as readonly Value[] };
  }
}

function refuse(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function packOf(byName: ReadonlyMap<string, Pack>, name: string): Pack {
  const pack = byName.get(name);
  if (pack === undefined) throw new Error(`unreachable: pack '${name}' was checked to be available`);
  return pack;
}

/**
 * The selected packs, dependencies first: depth-first over sorted names and
 * sorted dependencies, so the order depends only on names and edges. A cycle
 * is refused with the cycle written out.
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
