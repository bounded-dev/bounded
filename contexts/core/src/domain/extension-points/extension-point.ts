import type { OneLiteral } from "../packs/one-literal.contract.ts";
import type * as Contract from "./extension-point.contract.ts";

// Entity: equal by identity. Composition places a contribution only on the
// very point object its owner declared, which is what makes reads typed.
class ExtensionPointImpl<Value, Owner extends string> implements Contract.ExtensionPoint<Value, Owner> {
  declare readonly __brand: "ExtensionPoint";
  private constructor(
    readonly id: string,
    readonly owner: Owner,
    readonly description: string,
    private readonly check: ((value: Value) => string | undefined) | undefined,
  ) {
    Object.freeze(this);
  }

  static ownedBy<const Owner extends string>(owner: Owner & OneLiteral<Owner>): Contract.ExtensionPointDeclarer<Owner> {
    return {
      declare: <Value>(spec: Contract.ExtensionPointSpec<Value>): ExtensionPoint<Value, Owner> =>
        new ExtensionPointImpl<Value, Owner>(spec.id, owner, spec.description, spec.check),
    };
  }

  static isExtensionPoint(x: unknown): x is Contract.ExtensionPointHandle<string> {
    return x instanceof ExtensionPointImpl;
  }

  static checkValue(point: Contract.ExtensionPointHandle<string>, value: unknown): string | undefined {
    if (!(point instanceof ExtensionPointImpl)) return "it targets something that is not an extension point";
    try {
      // `point` narrows to ExtensionPointImpl<any, any>: the check takes the
      // value unchecked. Values reach here only from a genuine Contribution,
      // whose constructor typed them against this same point.
      return point.check === undefined ? undefined : point.check(value);
    } catch (error) {
      return `its check failed (${error instanceof Error ? error.message : String(error)})`;
    }
  }
}

export type ExtensionPoint<Value, Owner extends string> = Contract.ExtensionPoint<Value, Owner>;
export const ExtensionPoint: Contract.ExtensionPointFactory = ExtensionPointImpl;
