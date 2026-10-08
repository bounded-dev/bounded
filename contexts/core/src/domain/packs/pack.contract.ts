import type { BasePortKey } from "../lifecycle/port-key.contract.ts";
import type { Result } from "../shared/result.ts";
import type { IsExact, PackId, Refused } from "./pack-id.contract.ts";

/** The brand only PointDeclaration itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const pointDeclarationBrand: unique symbol;
/** The brand only PointGroupDeclaration itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const pointGroupDeclarationBrand: unique symbol;
/** The brand only Pack itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const packBrand: unique symbol;
/** The brand only ExtensionPoint itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const extensionPointBrand: unique symbol;
/** The brand only Contribution itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const contributionBrand: unique symbol;

// The strict-typing rule (ADR 2026-003, ADR 2026-004): anything not
// explicitly wired fails to compile, and composition repeats each rule at
// run time.

/**
 * A value object's wire form: what its `toJSON` gives and its `parse` takes.
 * Never for any other type.
 */
export type WireOf<Value> = Value extends { readonly __brand: string; toJSON(): infer Wire } ? Wire : never;

/**
 * What may be given for a point whose values are `Value`: a `Value`, or, when
 * it is a value object, its wire form (a rule written as an object literal).
 * The point's check parses every value at composition, so readers always get
 * what the check returned.
 */
export type Contributed<Value> = Value | WireOf<Value>;

/** An extension point as declared inside its pack's definition, before it has an owner. */
export interface PointDeclaration<Value> {
  readonly __brand: "PointDeclaration";
  readonly [pointDeclarationBrand]: true;
  readonly description: string;
  /** Parses a contributed value, possibly normalising it, or refuses it with a message. */
  readonly check: (raw: unknown) => Result<Value>;
  /** The owning pack's own values for this point, before its check parses them. */
  readonly values: readonly Contributed<Value>[];
}

/** A point declaration with its value type forgotten: the common base shape composition works with; the precise generic types (`PointDeclaration<Value>`) are for writing packs, and this base exists because points are invariant in their value type, so a precise pack is not assignable to the wide generic. */
export interface BaseDeclaration {
  readonly __brand: "PointDeclaration";
  readonly [pointDeclarationBrand]: true;
}
/** Points declared together under one key, such as one per effect kind; one level deep. */
export interface PointGroupDeclaration<Members extends Readonly<Record<string, unknown>>> {
  readonly __brand: "PointGroupDeclaration";
  readonly [pointGroupDeclarationBrand]: true;
  readonly members: Members;
}
export type Declarations = Readonly<Record<string, BaseDeclaration | PointGroupDeclaration<Readonly<Record<string, BaseDeclaration>>>>>;
type ValueOf<D> = D extends PointDeclaration<infer Value> ? Value : never;
/** A declaration's point, or a group's record of member points. */
type PointsOf<D, Id extends PackId> = D extends PointGroupDeclaration<infer Members> ? { readonly [J in keyof Members]: ExtensionPoint<ValueOf<Members[J]>, Id> } : ExtensionPoint<ValueOf<D>, Id>;

/** A pack's ports section: the port keys it needs, by camelCase name. */
export type PortSection = Readonly<Record<string, BasePortKey>>;

/** A group's member points, keyed by member: a frozen record without a prototype. */
export type PointGroup = Readonly<Record<string, BasePoint>>;

/** A pack with its id and points forgotten: the common base shape composition works with; the precise generic types (`Pack<Id, Points>`) are for writing packs, and this base exists because points are invariant in their value type, so a precise pack is not assignable to the wide generic. */
export interface BasePack {
  readonly __brand: "Pack";
  readonly [packBrand]: true;
  readonly id: PackId;
  readonly dependsOn: readonly BasePack[];
  readonly points: Readonly<Record<string, BasePoint | PointGroup>>;
  readonly contributes: readonly Contribution<PackId>[];
  /** The adapters a host must provide through openProject({ ports }) when the pack is selected. */
  readonly ports: PortSection;
  /**
   * What is wrong with the pack's shape, when it was built from untyped data
   * (a dependency that is not a pack, a point key that is not camelCase, a
   * point not declared with point(...), a contribution not made with
   * contribution(...)), or undefined. Composition refuses a selected pack
   * that has one.
   */
  readonly problem: string | undefined;
}

/** An extension point with its value type forgotten: the common base shape composition works with; the precise generic types (`ExtensionPoint<Value, Owner>`) are for writing packs, and this base exists because points are invariant in their value type, so a precise pack is not assignable to the wide generic. */
export interface BasePoint {
  readonly __brand: "ExtensionPoint";
  readonly [extensionPointBrand]: true;
  readonly owner: BasePack;
  /** `<pack id>.<key>`, or `<pack id>.<group key>.<member key>`, for messages. */
  readonly id: string;
  readonly description: string;
  /** The owner's own values for this point, before the point's check parses them. */
  readonly ownValues: readonly unknown[];
  /** Parses a value with the point's own check; a check that throws, or returns no result, refuses it. Never throws. */
  parseValue(raw: unknown): Result<unknown>;
  /** Whether this point was made from `declaration` (by definePack, from the pack's points section). */
  declaredBy(declaration: BaseDeclaration): boolean;
}

/** An extension point of the pack with id `Owner`, accepting values of type `Value`. */
export interface ExtensionPoint<Value, Owner extends PackId> extends BasePoint {
  readonly owner: BasePack & { readonly id: Owner };
  /** Never present: makes the point invariant in its value type. */
  readonly __value?: (value: Value) => Value;
}

/** A pack, typed by its exact id and its points' declarations. */
export interface Pack<Id extends PackId, Points extends Declarations, Ports extends PortSection = Record<never, never>> extends BasePack {
  readonly id: Id;
  readonly points: { readonly [K in keyof Points]: PointsOf<Points[K], Id> };
  readonly ports: Ports;
}

/** Values one pack contributes to a point of the pack with id `Owner`. */
export interface Contribution<Owner extends PackId> {
  readonly __brand: "Contribution";
  readonly [contributionBrand]: true;
  readonly point: BasePoint & { readonly owner: { readonly id: Owner } };
  readonly values: readonly unknown[];
}

/** A pack's definition, its sections always in this order. */
export interface PackSpec<Id extends PackId, Points extends Declarations, Dependencies extends readonly BasePack[], Ports extends PortSection = Record<never, never>> {
  readonly id: Id;
  readonly dependsOn?: Dependencies;
  /** What other packs contribute to. */
  readonly points?: Points;
  /** What this pack contributes to its dependencies' points, and no others: guards, and the core's lifecycle checks. */
  readonly contributes?: readonly Contribution<NoInfer<Dependencies[number]["id"]>>[];
  /** Adapters a host must supply through openProject({ ports }) when the pack is selected. */
  readonly ports?: Ports;
}

type ExactId<Id> = [Id] extends [{ readonly value: infer Text extends string }] ? IsExact<Text> : false;
type CamelCase<K> = K extends string ? (K extends "" | `${string}${"." | "-" | "_" | "/" | " " | "$"}${string}` ? false : K extends Uncapitalize<K> ? true : false) : false;
/** A group's members: camelCase keys, each a point declaration, never a group. */
export type StrictMembers<Members> = {
  readonly [K in keyof Members]: CamelCase<K> extends true
    ? Members[K] extends PointGroupDeclaration<Readonly<Record<string, unknown>>>
      ? Refused<"groups of points are one level deep">
      : unknown
    : Refused<"point keys are camelCase words, such as protectedPaths">;
};
type Repeats<List extends readonly unknown[]> = List extends readonly [infer Head, ...infer Tail] ? ([Head] extends [Tail[number]] ? true : Repeats<Tail>) : false;

/** What the compiler refuses beyond plain assignability. */
export type StrictSpec<Id extends PackId, Points extends Declarations, Dependencies extends readonly BasePack[], Ports extends PortSection = Record<never, never>> = ([ExactId<Id>] extends [true]
  ? unknown
  : { readonly id: Refused<"give the pack an exact id from packIdsFor(...)(...)"> }) & {
  readonly points?: { readonly [K in keyof Points]: CamelCase<K> extends true ? unknown : Refused<"point keys are camelCase words, such as protectedPaths"> };
  readonly ports?: {
    readonly [K in keyof Ports]: CamelCase<K> extends true
      ? [Ports[K]["owner"]] extends [Id]
        ? unknown
        : Refused<"a pack declares only its own ports">
      : Refused<"port keys are camelCase words, such as watchedFiles">;
  };
} & (Dependencies extends readonly []
    ? unknown
    : { readonly dependsOn: PackListRules<Dependencies, "list dependsOn as a tuple of packs, such as [core, pathGate]", "list each dependency once", "each dependency is a pack with an exact id"> });

/**
 * A list of packs the compiler can see pack by pack: a tuple (else `Tuple`),
 * each pack once (else `Once`), each with an exact id.
 */
export type PackListRules<List extends readonly BasePack[], Tuple extends string, Once extends string, Exact extends string> = number extends List["length"]
  ? Refused<Tuple>
  : false extends { [K in keyof List]: ExactId<List[K]["id"]> }[number]
    ? { readonly [K in keyof List]: [ExactId<List[K]["id"]>] extends [true] ? unknown : Refused<Exact> }
    : true extends Repeats<List>
      ? Refused<Once>
      : unknown;

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
  definePack<const Id extends PackId, const Points extends Declarations = Record<never, never>, const Dependencies extends readonly BasePack[] = [], const Ports extends PortSection = Record<never, never>>(
    spec: PackSpec<Id, Points, Dependencies, Ports> & StrictSpec<Id, Points, Dependencies, Ports>,
  ): Pack<Id, Points, Ports>;
  /**
   * Declare an extension point inside a pack definition; its value type is
   * what `check` returns. `unknown` is allowed (readers must narrow); `any`, anywhere
   * in the type, is not.
   */
  point<Value>(
    spec: { readonly description: string; readonly check: (raw: unknown) => Result<Value>; readonly values?: readonly NoInfer<Contributed<Value>>[] } & (true extends ContainsAny<Value>
      ? { readonly check: Refused<"a point's check must return a precise type, not any"> }
      : unknown),
  ): PointDeclaration<Value>;
  /**
   * Declare points together under one key, each member a point with the id
   * `<pack id>.<key>.<member>`; contribute to a member, never to the group.
   */
  pointGroup<const Members extends Readonly<Record<string, BaseDeclaration | PointGroupDeclaration<Readonly<Record<string, unknown>>>>>>(members: Members & StrictMembers<Members>): PointGroupDeclaration<Members>;
  /** The pack itself when `raw` was made by definePack in this copy of bounded, or why not. */
  parsePack(raw: unknown): Result<BasePack>;
  /** Contribute values of exactly the point's type (or a value object's wire form) to a point of a pack you depend on. */
  contribution<Value, Owner extends PackId>(point: ExtensionPoint<Value, Owner>, values: readonly NoInfer<Contributed<Value>>[]): Contribution<Owner>;
}
