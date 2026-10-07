import type { Result } from "../shared/result.ts";
import type * as Contract from "./pack.contract.ts";

// Packs, points, declarations and contributions are frozen plain objects.
// Only the ones made here are genuine: composition accepts no others, so a
// copy, a forgery or an object from another copy of this module is refused.
const genuine = new WeakSet<object>();
const checks = new WeakMap<object, (raw: unknown) => Result<unknown>>();
const ownValues = new WeakMap<object, unknown>();

function made<T extends object>(value: T): T {
  genuine.add(Object.freeze(value));
  return value;
}

/** A copy of a list, frozen; anything that is not a list is kept for composition to refuse. */
function list<T>(value: readonly T[] | undefined): readonly T[] {
  return Array.isArray(value) ? Object.freeze([...value]) : (value ?? Object.freeze([]));
}

function pointImpl<Value>(spec: {
  readonly description: string;
  readonly check: (raw: unknown) => Result<Value>;
  readonly values?: readonly Value[];
}): Contract.PointDeclaration<Value> {
  const declaration = made({ __brand: "PointDeclaration" as const, description: spec.description, check: spec.check, values: list(spec.values) });
  if (typeof spec.check === "function") checks.set(declaration, spec.check);
  ownValues.set(declaration, declaration.values);
  return declaration;
}

function contributionImpl<Value, Owner extends Contract.AnyPack>(
  point: Contract.ExtensionPoint<Value, Owner>,
  values: readonly NoInfer<Value>[],
): Contract.Contribution<Owner> {
  return made({ __brand: "Contribution" as const, point, values: list(values) });
}

interface UntypedSpec {
  readonly id: string;
  readonly dependsOn?: readonly Contract.AnyPack[];
  readonly points?: Readonly<Record<string, unknown>>;
  readonly contributes?: readonly Contract.Contribution<Contract.AnyPack>[];
}

function definePackImpl(spec: UntypedSpec): never {
  const points: Record<string, unknown> = {};
  const pack = { __brand: "Pack" as const, id: spec.id, dependsOn: list(spec.dependsOn), points, contributes: list(spec.contributes) };
  const declared = spec.points ?? {};
  for (const [key, declaration] of typeof declared === "object" && declared !== null ? Object.entries(declared) : []) {
    // A point is made from a genuine declaration only; anything else is kept
    // as given, and composition refuses it.
    if (!isGenuine(declaration, "PointDeclaration")) {
      points[key] = declaration;
      continue;
    }
    const point = made({ __brand: "ExtensionPoint" as const, owner: pack, id: `${spec.id}.${key}`, description: String(declaration.description) });
    const check = checks.get(declaration);
    if (check !== undefined) checks.set(point, check);
    ownValues.set(point, ownValues.get(declaration));
    points[key] = point;
  }
  Object.freeze(points);
  // The one cast here: the object just built is the typed Pack<Label, Points>
  // the signature promises (its points mirror the declarations key by key).
  return made(pack) as never;
}

const factory: Contract.PackFactory = { definePack: definePackImpl, point: pointImpl, contribution: contributionImpl };
export const { definePack, point, contribution } = factory;

/** Whether `x` was made by this module with the given brand. */
export function isGenuine<Brand extends string>(x: unknown, brand: Brand): x is { readonly __brand: Brand } & Record<string, unknown> {
  return typeof x === "object" && x !== null && genuine.has(x) && "__brand" in x && x.__brand === brand;
}

/** Whether a point was declared with a check. */
export function hasCheck(point: Contract.AnyPoint): boolean {
  return checks.has(point);
}

/** Run a point's own check on a value; a check that throws, or returns no result, refuses it. */
export function checkValue(point: Contract.AnyPoint, raw: unknown): Result<unknown> {
  try {
    const result = checks.get(point)?.(raw);
    if (result?.ok === true) return result;
    if (result?.ok === false && typeof result.error === "string") return result;
    return { ok: false, error: "its check returned no result" };
  } catch (error) {
    return { ok: false, error: `its check failed (${error instanceof Error ? error.message : String(error)})` };
  }
}

/** The owner's own values for a point, as given (composition checks it is a list). */
export function ownValuesOf(point: Contract.AnyPoint): unknown {
  return ownValues.get(point);
}

export type { AnyPack, AnyPoint, Contribution, ExtensionPoint, Pack, PointDeclaration } from "./pack.contract.ts";
