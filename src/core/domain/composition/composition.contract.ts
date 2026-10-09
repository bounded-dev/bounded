import type { BasePack, ExtensionPoint, PointDeclaration } from "../packs/pack.contract.ts";
import type { PackId } from "../packs/pack-id.contract.ts";
import type { BasePortKey } from "../lifecycle/port-key.contract.ts";
import type { Result } from "../shared/result.ts";

/** The brand only Composition itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const compositionBrand: unique symbol;

/** A value stored on a point, and the pack it came from. */
export interface Entry<Value> {
  readonly fromPackId: PackId;
  readonly value: Value;
}

/** The selected packs, composed: what every extension point holds. */
export interface Composition {
  readonly __brand: "Composition";
  readonly [compositionBrand]: true;
  /**
   * Every selected pack, listed or brought in by a dependency (ADR 2026-018),
   * in composition order: depth-first over the packs in
   * id order, each after its dependencies (also visited in id order). The
   * order depends only on ids and edges, never on listing order.
   */
  readonly packs: readonly BasePack[];
  /**
   * Every value stored on `point`, typed, in pack order: the owner's own
   * values first, then each contribution's, as the point's check returned
   * them. A point whose pack is not selected is an error, never an empty list.
   */
  read<Value>(point: ExtensionPoint<Value, PackId>): Result<readonly Value[]>;
  /** As `read`, with the id of the pack that contributed each value. */
  entries<Value>(point: ExtensionPoint<Value, PackId>): Result<readonly Entry<Value>[]>;
  /**
   * The point a selected pack made from `declaration`, or undefined: how a
   * pack's own code finds its points without importing the pack itself.
   * Composition refuses a declaration used for two points, so there is at
   * most one.
   */
  pointDeclaredBy<Value>(declaration: PointDeclaration<Value>): ExtensionPoint<Value, PackId> | undefined;
  /** The ports the selected packs need a host to provide, in composition order. */
  requiredPorts(): readonly BasePortKey[];
}

export interface CompositionFactory {
  /**
   * Compose the listed packs and every pack they depend on, transitively,
   * from the available ones (all pack objects; each selected pack must be
   * available), or refuse with a message naming the pack, the extension
   * point and the fix. Never throws, whatever it is given.
   */
  compose(availablePacks: readonly BasePack[], listedPacks: readonly BasePack[]): Result<Composition>;
  /** The composition itself when `raw` was made by compose in this copy of bounded, or why not: a look-alike is refused. Never throws. */
  parse(raw: unknown): Result<Composition>;
}
