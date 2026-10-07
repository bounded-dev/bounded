import type { OneLiteral } from "../packs/one-literal.contract.ts";

/**
 * What a pack declares: an extension point with its value type forgotten,
 * but never its owner. `Owner` is the owning pack's name as a literal type.
 */
export interface ExtensionPointHandle<Owner extends string> {
  readonly __brand: "ExtensionPoint";
  readonly id: string;
  readonly owner: Owner;
  readonly description: string;
}

/**
 * An extension point: declared by exactly one pack (its owner), accepting
 * values of type `Value` from the owner and from packs that depend on it.
 */
export interface ExtensionPoint<Value, Owner extends string> extends ExtensionPointHandle<Owner> {
  /**
   * Never present at run time. Using `Value` as both parameter and result
   * makes the point invariant in its value type, so a point for strings
   * cannot pass for a point for `string | number`.
   */
  readonly __value?: (value: Value) => Value;
}

export interface ExtensionPointSpec<Value> {
  readonly id: string;
  readonly description: string;
  /** Refuses a contributed value with a message, or accepts it with undefined. */
  readonly check?: (value: Value) => string | undefined;
}

/** Declares the extension points one pack owns, writing the owner once. */
export interface ExtensionPointDeclarer<Owner extends string> {
  declare<Value>(spec: ExtensionPointSpec<Value>): ExtensionPoint<Value, Owner>;
}

export interface ExtensionPointFactory {
  /** `ExtensionPoint.ownedBy("path-gate").declare<Rule>({ id, description, check })`. */
  ownedBy<const Owner extends string>(owner: Owner & OneLiteral<Owner>): ExtensionPointDeclarer<Owner>;
  /** Whether `x` was made by `ownedBy(...).declare(...)`: composition accepts no other. */
  isExtensionPoint(x: unknown): x is ExtensionPointHandle<string>;
  /** Run a point's own check on a contributed value; a check that throws refuses the value. */
  checkValue(point: ExtensionPointHandle<string>, value: unknown): string | undefined;
}
