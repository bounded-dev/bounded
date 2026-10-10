import type { packDescriptionBrand } from "./pack-description.contract.ts";
import type { BasePack } from "../packs/pack.contract.ts";
import { keyedPointsOf } from "../packs/pack.ts";
import { packIdText } from "../packs/pack-id.ts";
import type * as Contract from "./pack-description.contract.ts";

class PackDescriptionImpl implements Contract.PackDescription {
  declare readonly __brand: "PackDescription";
  declare readonly [packDescriptionBrand]: true;

  private constructor(
    readonly id: string,
    readonly dependsOn: readonly string[],
    readonly contributesTo: readonly string[],
    readonly points: readonly Contract.DescribedPoint[],
    readonly ports: readonly Contract.DescribedPort[],
  ) {
    Object.freeze(this);
  }

  static of(pack: BasePack): Contract.PackDescription {
    const id = packIdText(pack.id);
    const contributesTo = [...new Set(pack.contributes.map((contribution) => contribution.point.id))];
    const points = keyedPointsOf(pack).map(({ key, point }) => Object.freeze({ key, id: point.id, description: point.description }));
    const ports = Object.entries(pack.ports).map(([key, port]) => Object.freeze({ key, id: String(port.toJSON()) }));
    return new PackDescriptionImpl(id, Object.freeze(pack.dependsOn.map((dependency) => packIdText(dependency.id))), Object.freeze(contributesTo), Object.freeze(points), Object.freeze(ports));
  }
}

export type PackDescription = Contract.PackDescription;
export const PackDescription: Contract.PackDescriptionFactory = PackDescriptionImpl;
