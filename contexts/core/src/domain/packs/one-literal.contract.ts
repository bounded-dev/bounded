type IsUnion<T, All = T> = T extends unknown ? ([All] extends [T] ? false : true) : never;

/**
 * Ownership is checked on pack names as literal types, so a name the compiler
 * cannot pin to one literal (`string`, a union, a template pattern such as
 * `b${string}`) would switch the check off. `OneLiteral<S>` is `unknown` for
 * one string literal and, for anything else, an object type whose only key is
 * the error the compiler then shows.
 */
export type OneLiteral<S extends string> = Record<never, never> extends Record<S, 1>
  ? { readonly "Error: write pack names as single string literals": never }
  : [IsUnion<S>] extends [false]
    ? unknown
    : { readonly "Error: write pack names as single string literals": never };
