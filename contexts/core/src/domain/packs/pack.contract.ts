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
} & (Dependencies extends readonly [] ? unknown : { readonly dependsOn: PackListRules<Dependencies, "list dependsOn as a tuple of packs, such as [core, pathGate]", "list each dependency once"> });

/**
 * A list of packs the compiler can see pack by pack: a tuple (else `Tuple`),
 * each pack once (else `Once`), each with an exact id.
 */
export type PackListRules<List extends readonly AnyPack[], Tuple extends string, Once extends string> = number extends List["length"]
  ? Refused<Tuple>
  : true extends Repeats<List>
    ? Refused<Once>
    : { readonly [K in keyof List]: [ExactId<List[K]["id"]>] extends [true] ? unknown : Refused<"each dependency is a pack with an exact id"> };

type IsAny<T> = 0 extends 1 & T ? true : false;
/** Library classes with no type arguments: their own members are not inspected. */
type Leaf =
  | Date
  | RegExp
  | URL
  | Error
  | ArrayBuffer
  | SharedArrayBuffer
  | DataView
  | Int8Array
  | Uint8Array
  | Uint8ClampedArray
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array
  | BigInt64Array
  | BigUint64Array;
/** The leaves T is assignable to (never when none). */
type LeafOf<T> = Leaf extends infer L ? (L extends unknown ? (T extends L ? L : never) : never) : never;

/**
 * Whether `any` appears in T, to a depth of eight. Inspected: T itself; the
 * type arguments of Promise (any PromiseLike), ReadonlyMap/Map,
 * ReadonlySet/Set and arrays and tuples; a function's own parameters and
 * result; a constructor's own parameters and instance type; and the own
 * properties of any other object. Primitives, branded or not, are leaves,
 * as are Date, RegExp, URL, Error,
 * ArrayBuffer, SharedArrayBuffer, DataView and the typed arrays) are matched
 * by assignability, and only the members a type adds to its leaf are
 * inspected. Library method signatures are never inspected, so precise
 * built-in types pass.
 */
type ContainsAny<T, Depth extends readonly unknown[] = []> = IsAny<T> extends true
  ? true
  : Depth["length"] extends 8
    ? false
    : T extends string | number | boolean | bigint | symbol | null | undefined
      ? false
      : [LeafOf<T>] extends [never]
      ? StructureContainsAny<T, [...Depth, 1]>
      : AnyIn<{ [K in Exclude<keyof T, keyof LeafOf<T>>]-?: ContainsAny<T[K], [...Depth, 1]> }[Exclude<keyof T, keyof LeafOf<T>>]>;

/** `true` when any of the results is true. */
type AnyIn<Results> = true extends Results ? true : false;

type StructureContainsAny<T, Depth extends readonly unknown[]> = T extends PromiseLike<infer Settled>
  ? ContainsAny<Settled, Depth>
  : T extends ReadonlyMap<infer Key, infer Item>
    ? AnyIn<ContainsAny<Key, Depth> | ContainsAny<Item, Depth>>
    : T extends ReadonlySet<infer Item>
      ? ContainsAny<Item, Depth>
      : T extends readonly (infer Element)[]
        ? ContainsAny<Element, Depth>
        : T extends (...args: infer Parameters) => infer Returned
          ? AnyIn<ContainsAny<Returned, Depth> | ContainsAny<Parameters, Depth>>
          : T extends abstract new (...args: infer Parameters) => infer Instance
            ? AnyIn<ContainsAny<Instance, Depth> | ContainsAny<Parameters, Depth>>
            : T extends object
              ? AnyIn<{ [K in keyof T]-?: ContainsAny<T[K], Depth> }[keyof T]>
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
