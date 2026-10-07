import type { Result } from "../shared/result.ts";

// The strict-typing rule (ADR 2026-003): anything not explicitly wired fails
// to compile, and composition repeats each rule at run time.

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

/** Any pack, its label and points forgotten: what composition takes. */
export interface AnyPack {
  readonly __brand: "Pack";
  /** The pack's label: names it in selections and messages. */
  readonly id: string;
  readonly dependsOn: readonly AnyPack[];
  readonly points: Readonly<Record<string, AnyPoint>>;
  readonly contributes: readonly Contribution<AnyPack>[];
}

/** Any extension point, its value type forgotten. */
export interface AnyPoint {
  readonly __brand: "ExtensionPoint";
  readonly owner: AnyPack;
  /** `<pack id>.<key>`, for messages. */
  readonly id: string;
  readonly description: string;
}

/** An extension point owned by `Owner`, accepting values of type `Value`. */
export interface ExtensionPoint<Value, Owner extends AnyPack> extends AnyPoint {
  readonly owner: Owner;
  /** Never present: makes the point invariant in its value type. */
  readonly __value?: (value: Value) => Value;
}

/** A pack, typed by its label and its points' declarations. */
export interface Pack<Label extends string, Points extends Declarations> extends AnyPack {
  readonly id: Label;
  readonly points: { readonly [K in keyof Points]: ExtensionPoint<ValueOf<Points[K]>, Pack<Label, Points>> };
  /** Never present: makes the pack invariant in its label and points, so one pack never passes for another. */
  readonly __self?: (pack: Pack<Label, Points>) => Pack<Label, Points>;
}

/** Values one pack contributes to a point owned by `Owner`. */
export interface Contribution<Owner extends AnyPack> {
  readonly __brand: "Contribution";
  readonly point: AnyPoint & { readonly owner: Owner };
  readonly values: readonly unknown[];
}

export interface PackSpec<Label extends string, Points extends Declarations, Dependencies extends readonly AnyPack[]> {
  readonly id: Label;
  readonly dependsOn?: Dependencies;
  readonly points?: Points;
  /** Contributions to points of the packs in dependsOn, and no others. */
  readonly contributes?: readonly Contribution<NoInfer<Dependencies[number]>>[];
}

type Refused<Message extends string> = { readonly [K in `Error: ${Message}`]: never };
type IsUnion<T, All = T> = T extends unknown ? ([All] extends [T] ? false : true) : never;
type Repeats<List extends readonly unknown[]> = List extends readonly [infer Head, ...infer Tail]
  ? [Head] extends [Tail[number]]
    ? true
    : Repeats<Tail>
  : false;

/** What the compiler refuses beyond plain assignability. */
export type StrictSpec<Label extends string, Points extends Declarations, Dependencies extends readonly AnyPack[]> = (Record<never, never> extends Record<Label, 1>
  ? { readonly id: Refused<"write the pack id as a string literal"> }
  : unknown) & {
  readonly points?: { readonly [K in keyof Points]: K extends `${string}.${string}` ? Refused<"point keys are camelCase words without dots"> : unknown };
} & (Dependencies extends readonly []
    ? unknown
    : number extends Dependencies["length"]
      ? { readonly dependsOn: Refused<"list dependsOn as a tuple of packs, such as [core, pathGate]"> }
      : true extends Repeats<Dependencies>
        ? { readonly dependsOn: Refused<"list each dependency once"> }
        : { readonly dependsOn: { readonly [K in keyof Dependencies]: [IsUnion<Dependencies[K]>] extends [false] ? unknown : Refused<"each dependency is one pack"> } });

export interface PackFactory {
  /** Define a pack: its label, the packs it depends on, the points it declares and what it contributes. */
  definePack<const Label extends string, const Points extends Declarations = Record<never, never>, const Dependencies extends readonly AnyPack[] = []>(
    spec: PackSpec<Label, Points, Dependencies> & StrictSpec<Label, Points, Dependencies>,
  ): Pack<Label, Points>;
  /** Declare an extension point inside a pack definition; its value type is what `check` returns. */
  point<Value>(spec: {
    readonly description: string;
    readonly check: (raw: unknown) => Result<Value>;
    readonly values?: readonly NoInfer<Value>[];
  }): PointDeclaration<Value>;
  /** Contribute values of exactly the point's type to a point of a pack you depend on. */
  contribution<Value, Owner extends AnyPack>(point: ExtensionPoint<Value, Owner>, values: readonly NoInfer<Value>[]): Contribution<Owner>;
}
