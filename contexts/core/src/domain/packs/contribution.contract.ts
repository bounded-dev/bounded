import type { ExtensionPoint, ExtensionPointHandle } from "../extension-points/extension-point.contract.ts";

/**
 * Values one pack contributes to one extension point. `Owner` is the owner of
 * the target point: a pack accepts only contributions whose owner is itself
 * or a declared dependency, so any other contribution does not compile.
 */
export interface Contribution<Owner extends string> {
  readonly __brand: "Contribution";
  readonly point: ExtensionPointHandle<Owner>;
  readonly values: readonly unknown[];
  /** The point's refusals of these values, in order; a check that throws refuses. */
  problems(): readonly string[];
}

export interface ContributionFactory {
  /** `new Contribution(point, [value, …])`: each value must have the point's value type. */
  new <Value, Owner extends string>(point: ExtensionPoint<Value, Owner>, values: readonly NoInfer<Value>[]): Contribution<Owner>;
}
