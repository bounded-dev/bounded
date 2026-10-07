import type { ExtensionPoint } from "../extension-points/extension-point.contract.ts";
import type * as Contract from "./contribution.contract.ts";

// Entity: a point and values already typed against it, nothing more.
class ContributionImpl<Value, Owner extends string> implements Contract.Contribution<Owner> {
  declare readonly __brand: "Contribution";
  readonly values: readonly Value[];

  constructor(
    readonly point: ExtensionPoint<Value, Owner>,
    values: readonly Value[],
  ) {
    this.values = Object.freeze([...values]);
    Object.freeze(this);
  }

  static isContribution(x: unknown): x is Contract.Contribution<string> {
    return x instanceof ContributionImpl;
  }
}

export type Contribution<Owner extends string> = Contract.Contribution<Owner>;
export const Contribution: Contract.ContributionFactory = ContributionImpl;
