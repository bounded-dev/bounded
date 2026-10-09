import type { BasePack } from "../packs/pack.contract.ts";
import type { Result } from "../shared/result.ts";

/** The brand only SelectedPacks itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const selectedPacksBrand: unique symbol;

/**
 * The packs a configuration selects: the listed packs and every pack they
 * depend on, transitively, through dependsOn (ADR 2026-018). Each made by
 * definePack in this copy of bounded, each once, and no two with one id.
 */
export interface SelectedPacks {
  readonly __brand: "SelectedPacks";
  readonly [selectedPacksBrand]: true;
  /** Every selected pack, listed or brought in by a dependency, in id order, so every check over them runs in an order the listing never changes. */
  readonly packs: readonly BasePack[];
  /** The listed packs only, in id order. */
  readonly listedPacks: readonly BasePack[];
}

export interface SelectedPacksFactory {
  /**
   * The selection from a list of packs given as untyped data: the listed
   * packs and every pack they depend on, transitively. A malformed pack's
   * dependencies are not followed; composition refuses the pack itself. Or
   * why it is not one: not a list, a pack not built by definePack, a pack
   * listed twice, or two different packs with one id. Never throws.
   */
  parse(raw: unknown): Result<SelectedPacks>;
}
