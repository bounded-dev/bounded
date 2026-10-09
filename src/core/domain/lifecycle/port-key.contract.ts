import type { PackId } from "../packs/pack-id.contract.ts";
import type { Result } from "../shared/result.ts";

/** The brand only PortKey itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const portKeyBrand: unique symbol;

/**
 * A slot for an adapter a pack's lifecycle checks need: declared by the pack
 * (its `ports` section), filled by a host's composition root through
 * `openProject({ ports })`. Keys are equal by owner and name, so two copies
 * of a pack's key meet. This base forgets the adapter's type.
 */
export interface BasePortKey {
  readonly __brand: "PortKey";
  readonly [portKeyBrand]: true;
  readonly owner: PackId;
  /** A camelCase word, as point keys. */
  readonly name: string;
  equals(other: BasePortKey): boolean;
  /** `<owner>#<name>`. */
  toJSON(): string;
}

/** A port of the pack with id `Owner` whose adapter is exactly a `T`. */
export interface PortKey<T, Owner extends PackId = PackId> extends BasePortKey {
  readonly owner: Owner;
  /** Never present: makes the key invariant in its adapter's type. */
  readonly __adapter?: (adapter: T) => T;
}

export interface PortKeyFactory {
  /** The ports of the pack with id `owner`: `portKeysFor(owner)<Adapter>("name")`. */
  portKeysFor<const Owner extends PackId>(owner: Owner): <T>(name: string) => PortKey<T, Owner>;
  /** A port key from its wire form `<owner>#<name>`, or why the value is not one. Never throws. */
  parse(raw: unknown): Result<BasePortKey>;
}
