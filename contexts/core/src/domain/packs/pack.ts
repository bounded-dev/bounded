import type { Result } from "../shared/result.ts";
import type * as Contract from "./pack.contract.ts";
import { PackId, packIdText } from "./pack-id.ts";

// Packs, points, declarations and contributions are frozen plain objects.
// Only the ones made here are genuine: composition accepts no others, so a
// copy, a forgery or an object from another copy of this module is refused.
const genuine = new WeakSet<object>();
/** Each declaration, and each point made from one, to the declaration (its check and own values). */
const declarations = new WeakMap<object, Contract.PointDeclaration<unknown>>();

function made<T extends object>(value: T): T {
  genuine.add(Object.freeze(value));
  return value;
}

/** A copy of a list, frozen; anything that is not a list is kept for composition to refuse. */
function list<T>(value: readonly T[] | undefined): readonly T[] {
  return Array.isArray(value) ? Object.freeze([...value]) : (value ?? Object.freeze([]));
}

function declarePoint<Value>(spec: {
  readonly description: string;
  readonly check: (raw: unknown) => Result<Value>;
  readonly values?: readonly Contract.Contributed<Value>[];
}): Contract.PointDeclaration<Value> {
  const declaration = made({ __brand: "PointDeclaration" as const, description: spec.description, check: spec.check, values: list(spec.values) });
  declarations.set(declaration, declaration);
  return declaration;
}

function contribute<Value, Owner extends Contract.BasePack["id"]>(
  point: Contract.ExtensionPoint<Value, Owner>,
  values: readonly NoInfer<Contract.Contributed<Value>>[],
): Contract.Contribution<Owner> {
  return made({ __brand: "Contribution" as const, point, values: list(values) });
}

interface UntypedSpec {
  readonly id: unknown;
  readonly dependsOn?: readonly Contract.BasePack[];
  readonly points?: Readonly<Record<string, unknown>>;
  readonly contributes?: readonly Contract.Contribution<Contract.BasePack["id"]>[];
}

function define(spec: UntypedSpec): never {
  // No prototype, so a key such as "__proto__" is an ordinary key.
  const points: Record<string, unknown> = Object.create(null);
  // An id given as text (untyped data) becomes a PackId when it is one; any
  // other is kept as given, and composition refuses it.
  const parsed = PackId.parse(spec.id);
  const id = parsed.ok ? parsed.value : spec.id;
  const pack = { __brand: "Pack" as const, id, dependsOn: list(spec.dependsOn), points, contributes: list(spec.contributes) };
  const given = spec.points ?? {};
  for (const [key, raw] of typeof given === "object" && given !== null ? Object.entries(given) : []) {
    // A point is made from a genuine declaration only; anything else is kept
    // as given, and composition refuses it.
    const declaration = isGenuine(raw, "PointDeclaration") ? declarations.get(raw) : undefined;
    if (declaration === undefined) {
      points[key] = raw;
      continue;
    }
    const point = made({ __brand: "ExtensionPoint" as const, owner: pack, id: `${packIdText(id)}.${key}`, description: String(declaration.description) });
    declarations.set(point, declaration);
    points[key] = point;
  }
  Object.freeze(points);
  // The object just built is the typed Pack<Id, Points> the signature
  // promises: its points mirror the declarations key by key.
  return made(pack) as never;
}

const factory: Contract.PackFactory = { definePack: define, point: declarePoint, contribution: contribute };
export const { definePack, point, contribution } = factory;

/** Whether `x` was made by this module with the given brand. */
export function isGenuine<Brand extends string>(x: unknown, brand: Brand): x is { readonly __brand: Brand } & Record<string, unknown> {
  return typeof x === "object" && x !== null && genuine.has(x) && "__brand" in x && x.__brand === brand;
}

/** The declaration a point was made from: its check and the owner's own values. */
export function declarationOf(point: Contract.BasePoint): Contract.PointDeclaration<unknown> | undefined {
  return declarations.get(point);
}

/** Run a point's own check on a value; a check that throws, or returns no value, refuses it. */
export function checkValue(point: Contract.BasePoint, raw: unknown): Result<unknown> {
  try {
    const result: unknown = declarationOf(point)?.check(raw);
    if (typeof result === "object" && result !== null && "ok" in result) {
      if (result.ok === true && "value" in result) return { ok: true, value: result.value };
      if (result.ok === false && "error" in result && typeof result.error === "string") return { ok: false, error: result.error };
    }
    return { ok: false, error: "its check returned no result" };
  } catch (error) {
    return { ok: false, error: `its check failed (${error instanceof Error ? error.message : String(error)})` };
  }
}

export type { BasePack, BasePoint, Contributed, Contribution, ExtensionPoint, Pack, PointDeclaration, WireOf } from "./pack.contract.ts";
