import type { Result } from "../shared/result.ts";
import type { IsExact, PackId, Refused } from "./pack-id.contract.ts";

// The strict-typing rule (ADR 2026-003, ADR 2026-004): anything not
// explicitly wired fails to compile, and composition repeats each rule at
// run time.

/** An extension point as declared inside its pack's definition, before it has an owner. */
export interface PointDeclaration<Value> {
  readonly __brand: "PointDeclaration";
  readonly description: string;
  /** Parses a contributed value, possibly normalising it, or refuses it with a message. */
  readonly check: (raw: unknown) => Result<Value>;
  /** The owning pack's own values for this point. */
  readonly values: readonly Value[];
}

/** Any declaration, its value type forgotten. */
export interface AnyDeclaration {
  readonly __brand: "PointDeclaration";
}
export type Declarations = Readonly<Record<string, AnyDeclaration>>;
type ValueOf<D> = D extends PointDeclaration<infer Value> ? Value : never;

/** Any pack, its id and points forgotten: what composition takes. */
export interface AnyPack {
  readonly __brand: "Pack";
  readonly id: PackId;
  readonly dependsOn: readonly AnyPack[];
  readonly points: Readonly<Record<string, AnyPoint>>;
  readonly contributes: readonly Contribution<PackId>[];
}

/** Any extension point, its value type forgotten. */
export interface AnyPoint {
  readonly __brand: "ExtensionPoint";
  readonly owner: AnyPack;
  /** `<pack id>.<key>`, for messages. */
  readonly id: string;
  readonly description: string;
}

/** An extension point of the pack with id `Owner`, accepting values of type `Value`. */
export interface ExtensionPoint<Value, Owner extends PackId> extends AnyPoint {
  readonly owner: AnyPack & { readonly id: Owner };
  /** Never present: makes the point invariant in its value type. */
  readonly __value?: (value: Value) => Value;
}

/** A pack, typed by its exact id and its points' declarations. */
export interface Pack<Id extends PackId, Points extends Declarations> extends AnyPack {
  readonly id: Id;
  readonly points: { readonly [K in keyof Points]: ExtensionPoint<ValueOf<Points[K]>, Id> };
}

/** Values one pack contributes to a point of the pack with id `Owner`. */
export interface Contribution<Owner extends PackId> {
  readonly __brand: "Contribution";
  readonly point: AnyPoint & { readonly owner: { readonly id: Owner } };
  readonly values: readonly unknown[];
}

export interface PackSpec<Id extends PackId, Points extends Declarations, Dependencies extends readonly AnyPack[]> {
  readonly id: Id;
  readonly dependsOn?: Dependencies;
  readonly points?: Points;
  /** Contributions to points of the packs in dependsOn, and no others. */
  readonly contributes?: readonly Contribution<NoInfer<Dependencies[number]["id"]>>[];
}

type ExactId<Id> = [Id] extends [{ readonly __packId: infer Text extends string }] ? IsExact<Text> : false;
type CamelCase<K> = K extends string ? (K extends "" | `${string}${"." | "-" | "_" | "/" | " " | "$"}${string}` ? false : K extends Uncapitalize<K> ? true : false) : false;
type Repeats<List extends readonly unknown[]> = List extends readonly [infer Head, ...infer Tail] ? ([Head] extends [Tail[number]] ? true : Repeats<Tail>) : false;

/** What the compiler refuses beyond plain assignability. */
export type StrictSpec<Id extends PackId, Points extends Declarations, Dependencies extends readonly AnyPack[]> = ([ExactId<Id>] extends [true]
  ? unknown
  : { readonly id: Refused<"give the pack an exact id from packIdsFor(...)(...)"> }) & {
  readonly points?: { readonly [K in keyof Points]: CamelCase<K> extends true ? unknown : Refused<"point keys are camelCase words, such as protectedPaths"> };
} & (Dependencies extends readonly []
    ? unknown
    : number extends Dependencies["length"]
      ? { readonly dependsOn: Refused<"list dependsOn as a tuple of packs, such as [core, pathGate]"> }
      : true extends Repeats<Dependencies>
        ? { readonly dependsOn: Refused<"list each dependency once"> }
        : { readonly dependsOn: { readonly [K in keyof Dependencies]: [ExactId<Dependencies[K]["id"]>] extends [true] ? unknown : Refused<"each dependency is a pack with an exact id"> } });

type IsAny<T> = 0 extends 1 & T ? true : false;
/** Values whose type is a library class with no type arguments: inspected no further. */
type Leaf = Date | RegExp | URL | Error | ArrayBuffer | ArrayBufferView;

/**
 * Whether `any` appears in T, to a depth of eight. Inspected: T itself; the
 * type arguments of Promise (any PromiseLike), ReadonlyMap/Map,
 * ReadonlySet/Set and arrays and tuples; a function's own parameters and
 * result; a constructor's own parameters and instance type; and the own
 * properties of any other object. Leaves (never descended into): Date,
 * RegExp, URL, Error, ArrayBuffer and typed arrays. Library method
 * signatures are never inspected, so precise built-in types pass.
 */
type ContainsAny<T, Depth extends readonly unknown[] = []> = IsAny<T> extends true
  ? true
  : Depth["length"] extends 8
    ? false
    : T extends Leaf
      ? false
      : T extends PromiseLike<infer Settled>
        ? ContainsAny<Settled, [...Depth, 1]>
        : T extends ReadonlyMap<infer Key, infer Item>
          ? true extends ContainsAny<Key, [...Depth, 1]> | ContainsAny<Item, [...Depth, 1]>
            ? true
            : false
          : T extends ReadonlySet<infer Item>
            ? ContainsAny<Item, [...Depth, 1]>
            : T extends readonly (infer Element)[]
              ? ContainsAny<Element, [...Depth, 1]>
              : T extends (...args: infer Parameters) => infer Returned
                ? true extends ContainsAny<Returned, [...Depth, 1]> | ContainsAny<Parameters, [...Depth, 1]>
                  ? true
                  : false
                : T extends abstract new (...args: infer Parameters) => infer Instance
                  ? true extends ContainsAny<Instance, [...Depth, 1]> | ContainsAny<Parameters, [...Depth, 1]>
                    ? true
                    : false
                  : T extends object
                    ? true extends { [K in keyof T]-?: ContainsAny<T[K], [...Depth, 1]> }[keyof T]
                      ? true
                      : false
                    : false;

export interface PackFactory {
  /** Define a pack: its id, the packs it depends on, the points it declares and what it contributes. */
  definePack<const Id extends PackId, const Points extends Declarations = Record<never, never>, const Dependencies extends readonly AnyPack[] = []>(
    spec: PackSpec<Id, Points, Dependencies> & StrictSpec<Id, Points, Dependencies>,
  ): Pack<Id, Points>;
  /**
   * Declare an extension point inside a pack definition; its value type is
   * what `check` returns. `unknown` is allowed (readers must narrow); `any`, anywhere
   * in the type, is not.
   */
  point<Value>(
    spec: { readonly description: string; readonly check: (raw: unknown) => Result<Value>; readonly values?: readonly NoInfer<Value>[] } & (true extends ContainsAny<Value>
      ? { readonly check: Refused<"a point's check must return a precise type, not any"> }
      : unknown),
  ): PointDeclaration<Value>;
  /** Contribute values of exactly the point's type to a point of a pack you depend on. */
  contribution<Value, Owner extends PackId>(point: ExtensionPoint<Value, Owner>, values: readonly NoInfer<Value>[]): Contribution<Owner>;
}
