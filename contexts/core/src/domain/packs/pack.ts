import type * as Contract from "./pack.contract.ts";

// Entity: a pack is identified by its name. The constructor copies and
// freezes what it is given, so a pack cannot change after composition.
class PackImpl implements Contract.Pack {
  declare readonly __brand: "Pack";
  readonly name: string;
  readonly dependsOn: Contract.Pack["dependsOn"];
  readonly declares: Contract.Pack["declares"];
  readonly contributes: Contract.Pack["contributes"];

  constructor(spec: Contract.PackSpec<string, string>) {
    this.name = spec.name;
    this.dependsOn = Object.freeze([...(spec.dependsOn ?? [])]);
    this.declares = Object.freeze([...(spec.declares ?? [])]);
    this.contributes = Object.freeze([...(spec.contributes ?? [])]);
    Object.freeze(this);
  }
}

export type Pack = Contract.Pack;
export const Pack: Contract.PackFactory = PackImpl;
