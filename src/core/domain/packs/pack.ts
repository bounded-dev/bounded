import type { contributionBrand, extensionPointBrand, packBrand, pointDeclarationBrand, pointGroupDeclarationBrand } from "./pack.contract.ts";
import type { Result } from "../shared/result.ts";
import type * as Contract from "./pack.contract.ts";
import { isPortKey } from "../lifecycle/port-key.ts";
import { PackId, packIdText } from "./pack-id.ts";

// Packs, points, declarations and contributions are frozen instances of the
// classes below, whose constructors are private: only definePack, point,
// pointGroup and contribution make them. A copy, a forgery or an object from
// another copy of this module is not an instance, so its owner refuses it.

const COPY = "by this copy of bounded";
const CAMEL_CASE = /^[a-z][a-zA-Z0-9]*$/;
const keyProblem = (key: string): string => `its point key '${key}' must be a camelCase word, such as 'protectedPaths'`;

/** A copy of a list, frozen; anything that is not a list is kept, for the owner's problem to name. */
function list<T>(value: readonly T[] | undefined): readonly T[] {
  return Array.isArray(value) ? Object.freeze([...value]) : (value ?? Object.freeze([]));
}

/** The entries of an object given as untyped data; none for anything else. */
function entriesOf(raw: unknown): [string, unknown][] {
  return typeof raw === "object" && raw !== null ? Object.entries(raw) : [];
}

class PointDeclarationImpl<Value> implements Contract.PointDeclaration<Value> {
  declare readonly __brand: "PointDeclaration";
  declare readonly [pointDeclarationBrand]: true;

  private constructor(
    readonly description: string,
    readonly check: (raw: unknown) => Result<Value>,
    readonly values: readonly Contract.Contributed<Value>[],
  ) {
    Object.freeze(this);
  }

  static declare<Value>(spec: { readonly description: string; readonly check: (raw: unknown) => Result<Value>; readonly values?: readonly Contract.Contributed<Value>[] }): Contract.PointDeclaration<Value> {
    return new PointDeclarationImpl(spec.description, spec.check, list(spec.values));
  }

  /** What is wrong with the declaration of the point keyed `key`, if it was made from untyped data. */
  problem(key: string): string | undefined {
    if (typeof this.check !== "function") return `its point '${key}' has no check: every point parses the values it accepts`;
    if (!Array.isArray(this.values)) return `the own values of its point '${key}' must be a list`;
    return undefined;
  }

  parseValue(raw: unknown): Result<unknown> {
    try {
      const result: unknown = this.check(raw);
      if (typeof result === "object" && result !== null && "ok" in result) {
        if (result.ok === true && "value" in result) return { ok: true, value: result.value };
        if (result.ok === false && "error" in result && typeof result.error === "string") return { ok: false, error: result.error };
      }
      return { ok: false, error: "its check returned no result" };
    } catch (error) {
      return { ok: false, error: `its check failed (${error instanceof Error ? error.message : String(error)})` };
    }
  }
}

class PointGroupDeclarationImpl<Members extends Readonly<Record<string, unknown>>> implements Contract.PointGroupDeclaration<Members> {
  declare readonly __brand: "PointGroupDeclaration";
  declare readonly [pointGroupDeclarationBrand]: true;

  private constructor(readonly members: Members) {
    Object.freeze(this);
  }

  static declare<const Members extends Readonly<Record<string, Contract.BaseDeclaration | Contract.PointGroupDeclaration<Readonly<Record<string, unknown>>>>>>(
    members: Members & Contract.StrictMembers<Members>,
  ): Contract.PointGroupDeclaration<Members> {
    return new PointGroupDeclarationImpl(typeof members === "object" && members !== null ? Object.freeze({ ...members }) : members);
  }
}

class ExtensionPointImpl implements Contract.BasePoint {
  declare readonly __brand: "ExtensionPoint";
  declare readonly [extensionPointBrand]: true;
  readonly description: string;
  readonly ownValues: readonly unknown[];

  constructor(
    readonly owner: Contract.BasePack,
    readonly id: string,
    private readonly declaration: PointDeclarationImpl<unknown>,
  ) {
    this.description = String(declaration.description);
    this.ownValues = declaration.values;
    Object.freeze(this);
  }

  /** The point for `raw` when it is a declaration made by point(...), or `raw` as given. */
  static from(owner: Contract.BasePack, id: string, raw: unknown): unknown {
    return raw instanceof PointDeclarationImpl ? new ExtensionPointImpl(owner, id, raw) : raw;
  }

  /** What is wrong with the point keyed `key` of `pack`, if anything. */
  static problem(pack: Contract.BasePack, key: string, point: unknown): string | undefined {
    if (!(point instanceof ExtensionPointImpl) || point.owner !== pack) return `its points must each be declared with point(...) ${COPY}`;
    return point.declaration.problem(key);
  }

  parseValue(raw: unknown): Result<unknown> {
    return this.declaration.parseValue(raw);
  }

  declaredBy(declaration: Contract.BaseDeclaration): boolean {
    return this.declaration === declaration;
  }

  sharesDeclarationWith(other: Contract.BasePoint): boolean {
    return other instanceof ExtensionPointImpl && other.declaration === this.declaration;
  }
}

/** A group's member points, keyed by member, as own properties only. */
class PointGroupImpl {
  readonly [member: string]: unknown;

  constructor(members: readonly (readonly [string, unknown])[]) {
    for (const [member, point] of members) Object.defineProperty(this, member, { value: point, enumerable: true });
    Object.freeze(this);
  }

  /** What is wrong with the group keyed `key` of `pack`, one level deep, if anything. */
  static problem(pack: Contract.BasePack, key: string, group: PointGroupImpl): string | undefined {
    for (const [member, entry] of Object.entries(group)) {
      const path = `${key}.${member}`;
      if (!CAMEL_CASE.test(member)) return keyProblem(path);
      if (entry instanceof PointGroupDeclarationImpl) return `its point '${path}' is a group inside a group: groups of points are one level deep`;
      const problem = ExtensionPointImpl.problem(pack, path, entry);
      if (problem !== undefined) return problem;
    }
    return undefined;
  }
}

class ContributionImpl<Owner extends Contract.BasePack["id"]> implements Contract.Contribution<Owner> {
  declare readonly __brand: "Contribution";
  declare readonly [contributionBrand]: true;

  private constructor(
    readonly point: Contract.BasePoint & { readonly owner: { readonly id: Owner } },
    readonly values: readonly unknown[],
  ) {
    Object.freeze(this);
  }

  static contribute<Value, Owner extends Contract.BasePack["id"]>(point: Contract.ExtensionPoint<Value, Owner>, values: readonly NoInfer<Contract.Contributed<Value>>[]): Contract.Contribution<Owner> {
    return new ContributionImpl(point, list(values));
  }

  /** Whether `raw` is a contribution made by contribution(...) to a point made by definePack. */
  static genuine(raw: unknown): boolean {
    return raw instanceof ContributionImpl && raw.point instanceof ExtensionPointImpl && Array.isArray(raw.values);
  }
}

interface UntypedSpec {
  readonly id: unknown;
  readonly ports?: unknown;
  readonly dependsOn?: unknown;
  readonly points?: unknown;
  readonly contributes?: unknown;
}

class PackImpl implements Contract.BasePack {
  declare readonly __brand: "Pack";
  declare readonly [packBrand]: true;
  readonly id: PackId;
  readonly dependsOn: readonly Contract.BasePack[];
  readonly points: Readonly<Record<string, Contract.BasePoint | Contract.PointGroup>>;
  readonly contributes: readonly Contract.Contribution<PackId>[];
  readonly ports: Contract.PortSection;
  readonly problem: string | undefined;

  // Built from untyped data as well as typed: whatever does not fit is kept
  // as given, and `problem` names the first fault.
  private constructor(spec: UntypedSpec) {
    // An id given as text becomes a PackId when it is one; any other is kept
    // as given, and composition refuses it.
    const parsed = PackId.parse(spec.id);
    this.id = parsed.ok ? parsed.value : (spec.id as PackId);
    this.dependsOn = list(spec.dependsOn as readonly Contract.BasePack[] | undefined);
    this.contributes = list(spec.contributes as readonly Contract.Contribution<PackId>[] | undefined);
    // Kept as given, in a frozen record without a prototype; `problem` names what is not a port of this pack.
    this.ports = Object.freeze(Object.assign(Object.create(null), Object.fromEntries(entriesOf(spec.ports))));
    // No prototype, so a key such as "__proto__" is an ordinary key.
    const points: Record<string, unknown> = Object.create(null);
    for (const [key, raw] of entriesOf(spec.points)) {
      points[key] =
        raw instanceof PointGroupDeclarationImpl
          ? new PointGroupImpl(entriesOf(raw.members).map(([member, declaration]) => [member, ExtensionPointImpl.from(this, `${packIdText(this.id)}.${key}.${member}`, declaration)] as const))
          : ExtensionPointImpl.from(this, `${packIdText(this.id)}.${key}`, raw);
    }
    this.points = Object.freeze(points) as Contract.BasePack["points"];
    this.problem = this.shapeProblem();
    Object.freeze(this);
  }

  /** The typed Pack<Id, Points> the signature promises: its points mirror the declarations key by key. */
  static define(spec: UntypedSpec): never {
    return new PackImpl(spec) as never;
  }

  static parse(raw: unknown): Result<Contract.BasePack> {
    if (raw instanceof PackImpl) return { ok: true, value: raw };
    const id = typeof raw === "object" && raw !== null && "id" in raw ? packIdText(raw.id) : String(raw);
    return { ok: false, error: `'${id}' was not built with definePack(...), or was built by a different copy of bounded. Build every pack with definePack from one copy` };
  }

  private shapeProblem(): string | undefined {
    const { dependsOn, points, contributes } = this;
    if (!Array.isArray(dependsOn) || !dependsOn.every((dependency) => dependency instanceof PackImpl)) return `its dependsOn must be a list of packs made with definePack(...) ${COPY}`;
    const twice = dependsOn.find((dependency, i) => dependsOn.indexOf(dependency) !== i);
    if (twice !== undefined) return `it lists '${packIdText(twice.id)}' twice in dependsOn`;
    for (const [key, entry] of Object.entries(points)) {
      if (!CAMEL_CASE.test(key)) return keyProblem(key);
      const problem = entry instanceof PointGroupImpl ? PointGroupImpl.problem(this, key, entry) : ExtensionPointImpl.problem(this, key, entry);
      if (problem !== undefined) return problem;
    }
    if (!Array.isArray(contributes) || !contributes.every(ContributionImpl.genuine)) return `its contributes must be a list of contributions made with contribution(...) ${COPY}`;
    for (const [key, port] of Object.entries(this.ports)) {
      if (!CAMEL_CASE.test(key)) return `its port key '${key}' must be a camelCase word, such as 'sourceFiles'`;
      if (!isPortKey(port)) return `its port '${key}' must be declared with portKeysFor(...) ${COPY}`;
      if (port.owner.value !== packIdText(this.id)) return `its port '${key}' belongs to ${port.owner.value}: a pack declares only its own ports`;
    }
    return undefined;
  }
}

const factory: Contract.PackFactory = {
  definePack: PackImpl.define,
  point: PointDeclarationImpl.declare,
  pointGroup: PointGroupDeclarationImpl.declare,
  contribution: ContributionImpl.contribute,
  parsePack: PackImpl.parse,
};
// Each typed exactly as the contract declares it, so declaration emit names the
// contract's types rather than serialising their expansion (TS7056).
export const definePack: Contract.PackFactory["definePack"] = factory.definePack;
export const point: Contract.PackFactory["point"] = factory.point;
export const pointGroup: Contract.PackFactory["pointGroup"] = factory.pointGroup;
export const contribution: Contract.PackFactory["contribution"] = factory.contribution;
export const parsePack: Contract.PackFactory["parsePack"] = factory.parsePack;

/** A pack's points, each group's members in its place. */
export function pointsOf(pack: Contract.BasePack): Contract.BasePoint[] {
  const points: Contract.BasePoint[] = [];
  for (const entry of Object.values(pack.points)) {
    if (entry instanceof ExtensionPointImpl) points.push(entry);
    else if (entry instanceof PointGroupImpl) for (const member of Object.values(entry)) if (member instanceof ExtensionPointImpl) points.push(member);
  }
  return points;
}

export type { BasePack, BasePoint, Contributed, Contribution, ExtensionPoint, Pack, PointDeclaration, PointGroup, PointGroupDeclaration, WireOf } from "./pack.contract.ts";
