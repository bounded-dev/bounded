import type * as Contract from "./extension-point.contract.ts";

// Entity: equal by identity. Composition places a contribution only on the
// very point object its owner declared, which is what makes reads typed.
class ExtensionPointImpl<Value, Owner extends string> implements Contract.ExtensionPoint<Value, Owner> {
  declare readonly __brand: "ExtensionPoint";
  private constructor(
    readonly id: string,
    readonly owner: Owner,
    readonly description: string,
    private readonly checker: ((value: Value) => string | undefined) | undefined,
  ) {
    Object.freeze(this);
  }

  static ownedBy<const Owner extends string>(owner: Owner & Contract.Literal<Owner>): Contract.ExtensionPointDeclarer<Owner> {
    return {
      declare: <Value>(spec: Contract.ExtensionPointSpec<Value>): ExtensionPoint<Value, Owner> =>
        new ExtensionPointImpl<Value, Owner>(spec.id, owner, spec.description, spec.check),
    };
  }

  check(value: Value): string | undefined {
    return this.checker === undefined ? undefined : this.checker(value);
  }
}

export type ExtensionPoint<Value, Owner extends string> = Contract.ExtensionPoint<Value, Owner>;
export const ExtensionPoint: Contract.ExtensionPointFactory = ExtensionPointImpl;
