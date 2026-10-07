import { checkValue, hasCheck, isGenuine, ownValuesOf } from "../packs/pack.ts";
import type { AnyPack, AnyPoint, ExtensionPoint } from "../packs/pack.contract.ts";
import { PackName } from "../packs/pack-name.ts";
import type { Result } from "../shared/result.ts";
import type * as Contract from "./composition.contract.ts";

const COPY = "by this copy of @bounded/core";

class CompositionImpl implements Contract.Composition {
  declare readonly __brand: "Composition";
  private constructor(
    readonly packs: readonly string[],
    private readonly selected: ReadonlyMap<string, AnyPack>,
    private readonly slots: ReadonlyMap<AnyPoint, readonly unknown[]>,
  ) {
    Object.freeze(this);
  }

  static compose(available: readonly AnyPack[], selected: readonly string[]): Result<Composition> {
    if (!Array.isArray(available) || !Array.isArray(selected)) return refuse("Compose takes a list of available packs and a list of selected pack names");
    const entries: readonly unknown[] = available;
    for (const entry of entries) {
      if (!isGenuine(entry, "Pack")) {
        const label = typeof entry === "object" && entry !== null && "id" in entry ? String(entry.id) : String(entry);
        return refuse(
          `Available pack '${label}' was not built with definePack(...), or was built by a different copy of @bounded/core. Build every pack with definePack from one copy`,
        );
      }
    }
    for (const pack of available) {
      const label = PackName.parse(pack.id);
      if (!label.ok) return refuse(`Available pack '${String(pack.id)}' has an invalid label: ${label.error}. Give it a valid id, such as 'path-gate'`);
    }
    // Every check runs over sorted labels, so which refusal comes first never
    // depends on the order packs were listed in.
    const labels = available.map((pack) => pack.id).sort();
    const duplicate = labels.find((label, i) => labels[i + 1] === label);
    if (duplicate !== undefined) return refuse(`Two available packs are labelled '${duplicate}'. A label names a pack in selections and messages: rename one of them`);
    const byLabel = new Map(available.map((pack) => [pack.id, pack]));

    for (const raw of selected) {
      const name = PackName.parse(raw);
      if (!name.ok) return name;
    }
    const sorted = [...selected].sort();
    const chosen = new Map<string, AnyPack>();
    for (const [i, label] of sorted.entries()) {
      if (sorted[i + 1] === label) return refuse(`Pack '${label}' is selected twice. Select each pack once`);
      const pack = byLabel.get(label);
      if (pack === undefined) return refuse(`Pack '${label}' is selected but not available. Make it available, or remove it from the selection`);
      chosen.set(label, pack);
    }
    for (const pack of chosen.values()) {
      const problem = shapeProblem(pack);
      if (problem !== undefined) return refuse(`Pack '${pack.id}' is malformed: ${problem}. Fix its definition`);
    }
    for (const pack of chosen.values()) {
      for (const dependency of [...pack.dependsOn].sort(byId)) {
        if (chosen.get(dependency.id) === dependency) continue;
        return refuse(
          chosen.has(dependency.id)
            ? `Pack '${pack.id}' depends on a pack labelled '${dependency.id}' that is not the available '${dependency.id}' (another pack with that label, or another copy of it). Make the pack it depends on available instead`
            : `Pack '${pack.id}' depends on pack '${dependency.id}', which is not selected. Select '${dependency.id}' as well, or remove the dependency`,
        );
      }
    }

    const order = dependencyOrder([...chosen.values()]);
    const slots = new Map<AnyPoint, unknown[]>();
    for (const pack of order) {
      for (const point of Object.values(pack.points)) {
        slots.set(point, []);
        const own = ownValuesOf(point);
        const placed = place(pack, point, Array.isArray(own) ? own : [], slots);
        if (placed !== undefined) return refuse(placed);
      }
      for (const { point, values } of pack.contributes) {
        if (!pack.dependsOn.includes(point.owner)) {
          const owner = point.owner.id;
          return refuse(
            `Pack '${pack.id}' contributes to extension point '${point.id}', owned by pack '${owner}', but does not depend on '${owner}'. Add '${owner}' to the dependencies of '${pack.id}', or remove the contribution`,
          );
        }
        const placed = place(pack, point, values, slots);
        if (placed !== undefined) return refuse(placed);
      }
    }
    return { ok: true, value: new CompositionImpl(Object.freeze(order.map((pack) => pack.id)), chosen, slots) };
  }

  read<Value>(point: ExtensionPoint<Value, AnyPack>): Result<readonly Value[]> {
    const values = this.slots.get(point);
    if (values === undefined) {
      const owner = point.owner.id;
      return refuse(
        this.selected.has(owner)
          ? `Extension point '${point.id}' belongs to a pack labelled '${owner}' that is not the selected '${owner}' (another pack with that label, or another copy of it). Read the point of the selected pack`
          : `Extension point '${point.id}' does not exist in this composition: its owner '${owner}' is not selected. Select '${owner}' to use it`,
      );
    }
    // The one cast in composition: every value on this point's slot was
    // returned by this point's own check, whose type is (raw) => Result<Value>.
    return { ok: true, value: Object.freeze([...values]) as readonly Value[] };
  }
}

function refuse(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

const byId = (a: AnyPack, b: AnyPack): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Check each value with the point's own check and store what the check returns; a refusal message, or undefined. */
function place(pack: AnyPack, point: AnyPoint, values: readonly unknown[], slots: Map<AnyPoint, unknown[]>): string | undefined {
  const slot = slots.get(point);
  for (const raw of values) {
    const checked = checkValue(point, raw);
    if (!checked.ok) return `Pack '${pack.id}' contributes an invalid value to extension point '${point.id}': ${checked.error}. Fix the value, or remove the contribution`;
    slot?.push(checked.value);
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
    if (!hasCheck(point)) return `its point '${key}' has no check: every point parses the values it accepts`;
    if (!Array.isArray(ownValuesOf(point))) return `the own values of its point '${key}' must be a list`;
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
  for (const pack of [...packs].sort(byId)) visit(pack);
  return order;
}

export type Composition = Contract.Composition;
export const Composition: Contract.CompositionFactory = CompositionImpl;
