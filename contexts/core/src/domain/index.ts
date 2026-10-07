export type { Result } from "./shared/result.ts";

export type { CompositionFactory } from "./composition/composition.contract.ts";
export { Composition } from "./composition/composition.ts";
export type {
  AnyPack,
  AnyPoint,
  Contribution,
  Declarations,
  ExtensionPoint,
  Pack,
  PackFactory,
  PackSpec,
  PointDeclaration,
  StrictSpec,
} from "./packs/pack.contract.ts";
export { contribution, definePack, point } from "./packs/pack.ts";
export type { PackNameFactory } from "./packs/pack-name.contract.ts";
export { PackName } from "./packs/pack-name.ts";
