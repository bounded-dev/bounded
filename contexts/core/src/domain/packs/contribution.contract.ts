import type { ExtensionPoint, ExtensionPointHandle } from "../extension-points/extension-point.contract.ts";

/**
 * Values one pack contributes to one extension point: plain data, checked by
 * composition against the point its owner declared. `Owner` is the owner of
 * the target point: a pack accepts only contributions whose owner is itself
 * or a declared dependency, so any other contribution does not compile.
 * The list is frozen; the values themselves are neither copied nor frozen.
 */
export interface Contribution<Owner extends string> {
  readonly __brand: "Contribution";
  readonly point: ExtensionPointHandle<Owner>;
  readonly values: readonly unknown[];
}

export interface ContributionFactory {
  /** `new Contribution(point, [value, …])`: each value must have the point's value type. */
  new <Value, Owner extends string>(point: ExtensionPoint<Value, Owner>, values: readonly NoInfer<Value>[]): Contribution<Owner>;
  /** Whether `x` was made by `new Contribution`: composition accepts no other. */
  isContribution(x: unknown): x is Contribution<string>;
}
