import type { AnyPack, ExtensionPoint } from "../packs/pack.contract.ts";
import type { Result } from "../shared/result.ts";

/** The selected packs, composed: what every extension point holds. */
export interface Composition {
  readonly __brand: "Composition";
  /**
   * The selected packs' labels in composition order: depth-first over the
   * labels in sorted order, each pack after its dependencies (also visited in
   * sorted order). The order depends only on labels and edges, never on
   * listing order.
   */
  readonly packs: readonly string[];
  /**
   * Every value stored on `point`, typed, in pack order: the owner's own
   * values first, then each contribution's, as the point's check returned
   * them. A point whose pack is not selected is an error, never an empty list.
   */
  read<Value>(point: ExtensionPoint<Value, AnyPack>): Result<readonly Value[]>;
}

export interface CompositionFactory {
  /**
   * Compose the selected packs (by label) from the available ones, or refuse
   * with a message naming the pack, the extension point and the fix. Never
   * throws, whatever it is given.
   */
  compose(available: readonly AnyPack[], selected: readonly string[]): Result<Composition>;
}
