import type { BasePack } from "../packs/pack.contract.ts";

/** The brand only PackDescription itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const packDescriptionBrand: unique symbol;

/** A point as its pack declares it: its key (`<group>.<member>` for a group's member), its id and its description. */
export interface DescribedPoint {
  readonly key: string;
  /** `<pack id>.<key>`. */
  readonly id: string;
  readonly description: string;
}

/** A port as its pack declares it: its key and its id, `<pack id>#<key>`. */
export interface DescribedPort {
  readonly key: string;
  readonly id: string;
}

/**
 * What a pack object says about itself, as text, for a package catalogue
 * (ADR 2026-026): its id, the ids of the packs it depends on, the points it
 * contributes to, the points it declares and the ports it needs.
 */
export interface PackDescription {
  readonly __brand: "PackDescription";
  readonly [packDescriptionBrand]: true;
  readonly id: string;
  /** Its dependencies' ids, in its dependsOn order. */
  readonly dependsOn: readonly string[];
  /** The ids of the points it contributes to, each once, in contribution order. */
  readonly contributesTo: readonly string[];
  /** Its points, in declaration order, a group's members in its place. */
  readonly points: readonly DescribedPoint[];
  /** Its ports, in its ports section's order. */
  readonly ports: readonly DescribedPort[];
}

export interface PackDescriptionFactory {
  /** The description of a pack made by definePack. */
  of(pack: BasePack): PackDescription;
}
