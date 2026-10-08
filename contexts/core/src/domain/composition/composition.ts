import { checkValue, declarationOf, isGenuine, isPointGroup, pointsOf } from "../packs/pack.ts";
import type { BasePack, BasePoint, ExtensionPoint } from "../packs/pack.contract.ts";
import type { PackId as PackIdType } from "../packs/pack-id.contract.ts";
import { PackId, packIdText } from "../packs/pack-id.ts";
import type { Result } from "../shared/result.ts";
import type * as Contract from "./composition.contract.ts";

const COPY = "by this copy of bounded";

class CompositionImpl implements Contract.Composition {
  declare readonly __brand: "Composition";

  private constructor(
    readonly packs: readonly BasePack[],
    private readonly slots: ReadonlyMap<BasePoint, readonly Contract.Entry<unknown>[]>,
  ) {
    Object.freeze(this);
  }

  static compose(availablePacks: readonly BasePack[], selectedPacks: readonly BasePack[]): Result<Composition> {
    if (!Array.isArray(availablePacks) || !Array.isArray(selectedPacks)) return refuse("Compose takes a list of available packs and a list of selected packs");
    const notGenuine = (which: string, list: readonly unknown[]) => {
      const entry = list.find((x) => !isGenuine(x, "Pack"));
      const id = typeof entry === "object" && entry !== null && "id" in entry ? packIdText(entry.id) : String(entry);
      return `${which} pack '${id}' was not built with definePack(...), or was built by a different copy of bounded. Build every pack with definePack from one copy`;
    };
    if (availablePacks.some((x) => !isGenuine(x, "Pack"))) return refuse(notGenuine("Available", availablePacks));
    for (const pack of availablePacks) {
      const id = PackId.parse(pack.id);
      if (!id.ok) return refuse(`Available pack '${packIdText(pack.id)}' has an invalid id: ${id.error}. Give it an id from packIdsFor(...)`);
    }
    // Every check runs in id order, so which refusal comes first never
    // depends on the order packs were listed in.
    const ids = availablePacks.map((pack) => pack.id.value).sort();
    const duplicate = ids.find((id, i) => ids[i + 1] === id);
    if (duplicate !== undefined) return refuse(`Two available packs have the id '${duplicate}'. An id names one pack in selections and messages: give each pack its own`);

    if (selectedPacks.some((x) => !isGenuine(x, "Pack"))) return refuse(notGenuine("Selected", selectedPacks));
    const chosen = [...selectedPacks].sort(byId);
    for (const [i, pack] of chosen.entries()) {
      if (chosen[i + 1] === pack) return refuse(`Pack '${packIdText(pack.id)}' is selected twice. Select each pack once`);
      if (!availablePacks.includes(pack)) return refuse(`Pack '${packIdText(pack.id)}' is selected but not available. Make it available, or remove it from the selection`);
    }
    for (const pack of chosen) {
      const problem = shapeProblem(pack);
      if (problem !== undefined) return refuse(`Pack '${pack.id.value}' is malformed: ${problem}. Fix its definition`);
    }
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
        const placed = place(pack, point, declarationOf(point)?.values ?? [], slots);
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

const byId = (a: BasePack, b: BasePack): number => {
  const [x, y] = [packIdText(a.id), packIdText(b.id)];
  return x < y ? -1 : x > y ? 1 : 0;
};

/** Check each value with the point's own check and store what it returns; a refusal message, or undefined. */
function place(pack: BasePack, point: BasePoint, values: readonly unknown[], slots: Map<BasePoint, Contract.Entry<unknown>[]>): string | undefined {
  const slot = slots.get(point);
  if (slot === undefined) return `Pack '${pack.id.value}' contributes to extension point '${point.id}', which has no place in this composition. Report this as a defect`;
  for (const raw of values) {
    const checked = checkValue(point, raw);
    if (!checked.ok) return `Pack '${pack.id.value}' contributes an invalid value to extension point '${point.id}': ${checked.error}. Fix the value, or remove the contribution`;
    slot.push(Object.freeze({ fromPackId: pack.id, value: checked.value }));
  }
  return undefined;
}

/** What is wrong with a pack built from untyped data, if anything. */
function shapeProblem(pack: BasePack): string | undefined {
  const { dependsOn, points, contributes } = pack;
  if (!Array.isArray(dependsOn) || !dependsOn.every((dependency) => isGenuine(dependency, "Pack"))) return `its dependsOn must be a list of packs made with definePack(...) ${COPY}`;
  const twice = dependsOn.find((dependency, i) => dependsOn.indexOf(dependency) !== i);
  if (twice !== undefined) return `it lists '${packIdText(twice.id)}' twice in dependsOn`;
  for (const [key, entry] of Object.entries(points)) {
    if (!CAMEL_CASE.test(key)) return keyProblem(key);
    const problem = isPointGroup(entry) ? groupProblem(pack, key, entry) : pointProblem(pack, key, entry);
    if (problem !== undefined) return problem;
  }
  const genuineContribution = (c: unknown) => isGenuine(c, "Contribution") && isGenuine(c.point, "ExtensionPoint") && Array.isArray(c.values);
  if (!Array.isArray(contributes) || !contributes.every(genuineContribution)) return `its contributes must be a list of contributions made with contribution(...) ${COPY}`;
  return undefined;
}

const CAMEL_CASE = /^[a-z][a-zA-Z0-9]*$/;
const keyProblem = (key: string): string => `its point key '${key}' must be a camelCase word, such as 'protectedPaths'`;

/** What is wrong with one point of a pack, keyed `key`, if anything. */
function pointProblem(pack: BasePack, key: string, point: unknown): string | undefined {
  if (!isGenuine(point, "ExtensionPoint") || point.owner !== pack) return `its points must each be declared with point(...) ${COPY}`;
  const declaration = declarationOf(point);
  if (typeof declaration?.check !== "function") return `its point '${key}' has no check: every point parses the values it accepts`;
  if (!Array.isArray(declaration.values)) return `the own values of its point '${key}' must be a list`;
  return undefined;
}

/** What is wrong with a group of points, one level deep, if anything. */
function groupProblem(pack: BasePack, key: string, group: Readonly<Record<string, unknown>>): string | undefined {
  for (const [member, entry] of Object.entries(group)) {
    const path = `${key}.${member}`;
    if (!CAMEL_CASE.test(member)) return keyProblem(path);
    if (isGenuine(entry, "PointGroupDeclaration")) return `its point '${path}' is a group inside a group: groups of points are one level deep`;
    const problem = pointProblem(pack, path, entry);
    if (problem !== undefined) return problem;
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

/** Whether `x` was made by Composition.compose in this copy of bounded: look-alikes are not. */
export function isComposition(x: unknown): x is Contract.Composition {
  return x instanceof CompositionImpl;
}

export type Composition = Contract.Composition;
export const Composition: Contract.CompositionFactory = CompositionImpl;
