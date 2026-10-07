import type { AnyPack, ExtensionPoint } from "../packs/pack.contract.ts";
import type { PackId } from "../packs/pack-id.contract.ts";
import type { Result } from "../shared/result.ts";

/** The selected packs, composed: what every extension point holds. */
export interface Composition {
  readonly __brand: "Composition";
  /**
   * The selected packs in composition order: depth-first over the packs in
   * id order, each after its dependencies (also visited in id order). The
   * order depends only on ids and edges, never on listing order.
   */
  readonly packs: readonly AnyPack[];
  /**
   * Every value stored on `point`, typed, in pack order: the owner's own
   * values first, then each contribution's, as the point's check returned
   * them. A point whose pack is not selected is an error, never an empty list.
   */
  read<Value>(point: ExtensionPoint<Value, PackId>): Result<readonly Value[]>;
}

export interface CompositionFactory {
  /**
   * Compose the selected packs from the available ones (both pack objects),
   * or refuse with a message naming the pack, the extension point and the
   * fix. Never throws, whatever it is given.
   */
  compose(available: readonly AnyPack[], selected: readonly AnyPack[]): Result<Composition>;
}
