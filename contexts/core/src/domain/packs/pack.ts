import type * as Contract from "./pack.contract.ts";

// Entity: a pack is identified by its name. The constructor copies and freezes
// the lists it is given and never throws: a pack built from untyped data keeps
// whatever it was given, and composition refuses it with a message.
class PackImpl implements Contract.Pack {
  declare readonly __brand: "Pack";
  readonly name: string;
  readonly dependsOn: Contract.Pack["dependsOn"];
  readonly declares: Contract.Pack["declares"];
  readonly contributes: Contract.Pack["contributes"];

  constructor(spec: Contract.PackSpec<string, readonly string[]>) {
    this.name = spec.name;
    this.dependsOn = copy(spec.dependsOn);
    this.declares = copy(spec.declares);
    this.contributes = copy(spec.contributes);
    Object.freeze(this);
  }

  static isPack(x: unknown): x is Contract.Pack {
    return x instanceof PackImpl;
  }
}

function copy<T>(list: readonly T[] | undefined): readonly T[] {
  return Array.isArray(list) ? Object.freeze([...list]) : (list ?? Object.freeze([]));
}

export type Pack = Contract.Pack;
export const Pack: Contract.PackFactory = PackImpl;
