import type { Result } from "../shared/result.ts";

/** The brand only PackId itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const packIdBrand: unique symbol;

/**
 * A pack's id: `<npm package>/<local id>`, such as "bounded/core". Typed by
 * its exact text (`PackId<"bounded/core">` has the value "bounded/core"), so
 * the compiler can tell one pack's id from another's, and a plain string
 * cannot stand in for it. The id names the pack in selections, messages and
 * logs; packs are matched by object identity, never by id.
 */
export interface PackId<Text extends string = string> {
  readonly __brand: "PackId";
  readonly [packIdBrand]: true;
  readonly value: Text;
  equals(other: PackId): boolean;
  toJSON(): Text;
}

/** A type the compiler shows as an error naming what to fix. */
export type Refused<Message extends string> = { readonly [K in `Error: ${Message}`]: never };

type IsUnion<T, All = T> = T extends unknown ? ([All] extends [T] ? false : true) : never;

/** True for one exact string literal; false for `string`, a template pattern, a union or never. */
export type IsExact<S extends string> = [S] extends [never]
  ? false
  : Record<never, never> extends Record<S, 1>
    ? false
    : [IsUnion<S>] extends [false]
      ? true
      : false;

type PackageCheck<P extends string> = IsExact<P> extends false
  ? Refused<"write the npm package name as a string literal">
  : P extends Lowercase<P>
    ? P extends `${string}/${string}/${string}` | `${string}/` | `/${string}`
      ? Refused<"an npm package name is name or @scope/name">
      : P extends `${infer Scope}/${string}`
        ? Scope extends `@${string}`
          ? unknown
          : Refused<"an npm package name is name or @scope/name">
        : unknown
    : Refused<"npm package names are lowercase">;

type LocalCheck<L extends string> = IsExact<L> extends false
  ? Refused<"write the pack's local id as a string literal">
  : L extends "" | `${string}${"/" | "." | "_" | " " | "@" | "--"}${string}` | `-${string}` | `${string}-` | `${0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}${string}`
    ? Refused<"a pack's local id is lowercase words joined by hyphens, without '/'">
    : L extends Lowercase<L>
      ? unknown
      : Refused<"a pack's local id is lowercase words joined by hyphens, without '/'">;

export interface PackIdFactory {
  /** A valid id, or why the value is not one. Ids are checked here at run time, always. */
  parse(raw: unknown): Result<PackId>;
  /**
   * The id factory of one npm package: `forPackage("bounded")("core")` is
   * "bounded/core". Each package keeps its own pack ids unique.
   */
  forPackage<const Package extends string>(
    pkg: Package & PackageCheck<Package>,
  ): <const Local extends string>(local: Local & LocalCheck<Local>) => PackId<`${Package}/${Local}`>;
}
