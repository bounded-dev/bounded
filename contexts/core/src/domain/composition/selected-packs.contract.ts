import type { BasePack } from "../packs/pack.contract.ts";
import type { Result } from "../shared/result.ts";

/** The packs a configuration selects: each made by definePack in this copy of bounded, each once. */
export interface SelectedPacks {
  readonly __brand: "SelectedPacks";
  /** The packs in id order, so every check over them runs in an order the listing never changes. */
  readonly packs: readonly BasePack[];
}

export interface SelectedPacksFactory {
  /** The selected packs from a list given as untyped data, or why it is not one: not a list, a pack not built by definePack, or a pack selected twice. Never throws. */
  parse(raw: unknown): Result<SelectedPacks>;
}
