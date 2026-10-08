import type { BasePack } from "../packs/pack.contract.ts";
import type { Result } from "../shared/result.ts";

/** The brand only AvailablePacks itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const availablePacksBrand: unique symbol;

/** The packs a selection may choose from: each made by definePack in this copy of bounded, each with a valid id of its own. */
export interface AvailablePacks {
  readonly __brand: "AvailablePacks";
  readonly [availablePacksBrand]: true;
  /** The packs, in the order given. */
  readonly packs: readonly BasePack[];
  includes(pack: BasePack): boolean;
}

export interface AvailablePacksFactory {
  /**
   * The available packs from a list given as untyped data, or why it is not
   * one: not a list, a pack not built by definePack, an invalid id, or two
   * packs sharing an id (reported in id order). Never throws.
   */
  parse(raw: unknown): Result<AvailablePacks>;
}
