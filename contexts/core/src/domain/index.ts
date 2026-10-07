export type { Result } from "./shared/result.ts";

// Each export is both the contract type and its implementation value.
export type { CompositionFactory } from "./composition/composition.contract.ts";
export { Composition } from "./composition/composition.ts";
export type {
  ExtensionPointDeclarer,
  ExtensionPointFactory,
  ExtensionPointHandle,
  ExtensionPointSpec,
  Literal,
} from "./extension-points/extension-point.contract.ts";
export { ExtensionPoint } from "./extension-points/extension-point.ts";
export type { ExtensionPointIdFactory } from "./extension-points/extension-point-id.contract.ts";
export { ExtensionPointId } from "./extension-points/extension-point-id.ts";
export type { ContributionFactory } from "./packs/contribution.contract.ts";
export { Contribution } from "./packs/contribution.ts";
export type { LiteralNames, PackFactory, PackSpec } from "./packs/pack.contract.ts";
export { Pack } from "./packs/pack.ts";
export type { PackNameFactory } from "./packs/pack-name.contract.ts";
export { PackName } from "./packs/pack-name.ts";
