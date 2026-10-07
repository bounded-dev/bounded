import type { ExtensionPoint } from "../extension-points/extension-point.contract.ts";
import type * as Contract from "./contribution.contract.ts";

// Entity: built from a point and values already typed against it. The values
// keep their real type inside the closure, so the point's check needs no cast.
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

  problems(): readonly string[] {
    return this.values.flatMap((value) => {
      try {
        const problem = this.point.check(value);
        return problem === undefined ? [] : [problem];
      } catch (error) {
        return [`its check failed (${error instanceof Error ? error.message : String(error)})`];
      }
    });
  }
}

export type Contribution<Owner extends string> = Contract.Contribution<Owner>;
export const Contribution: Contract.ContributionFactory = ContributionImpl;
