import type { ExtensionPoint } from "../extension-points/extension-point.contract.ts";
import type { Pack } from "../packs/pack.contract.ts";
import type { PackName } from "../packs/pack-name.contract.ts";
import type { Result } from "../shared/result.ts";

/** The selected packs, composed: what every extension point holds. */
export interface Composition {
  readonly __brand: "Composition";
  /**
   * The selected packs in composition order: depth-first over the names in
   * sorted order, each pack after its dependencies (also visited in sorted
   * order). Every dependency comes before its dependents, and the order
   * depends only on names and edges, never on listing order.
   */
  readonly packs: readonly string[];
  /**
   * Every value contributed to `point`, typed, in pack order. A point that
   * does not exist in this composition is an error, never an empty list.
   */
  read<Value>(point: ExtensionPoint<Value, string>): Result<readonly Value[]>;
}

export interface CompositionFactory {
  /** Compose the selected packs from the available ones, or refuse with a message naming the pack, the point and the fix. */
  compose(available: readonly Pack[], selected: readonly PackName[]): Result<Composition>;
}
