import type { PackId as PackIdType } from "../packs/pack-id.contract.ts";
import { PackId } from "../packs/pack-id.ts";
import type { Result } from "../shared/result.ts";
import { wireFormOf } from "../shared/wire.ts";
import type * as Contract from "./port-key.contract.ts";
import type { portKeyBrand } from "./port-key.contract.ts";

const FORM = "A port key is '<pack id>#<name>', its name a camelCase word, such as 'acme/rules#sourceFiles'";
/** A port's name: a camelCase word, as point keys. */
export const PORT_NAME = /^[a-z][a-zA-Z0-9]*$/;

class PortKeyImpl<T, Owner extends PackIdType> implements Contract.PortKey<T, Owner> {
  declare readonly __brand: "PortKey";
  declare readonly [portKeyBrand]: true;
  readonly #made = true;

  private constructor(
    readonly owner: Owner,
    readonly name: string,
  ) {
    Object.freeze(this);
  }

  /** Whether `raw` was made by this class (not merely an object that inherits from one): parse checks its wire form again, since a constructor can be called at run time. */
  static made(raw: unknown): raw is PortKeyImpl<unknown, PackIdType> {
    return typeof raw === "object" && raw !== null && #made in raw;
  }

  static portKeysFor<const Owner extends PackIdType>(owner: Owner): <T>(name: string) => Contract.PortKey<T, Owner> {
    // A name that is not camelCase is kept, and the pack that declares the key names the problem.
    return <T>(name: string): Contract.PortKey<T, Owner> => new PortKeyImpl<T, Owner>(owner, name);
  }

  static parse(raw: unknown): Result<Contract.BasePortKey> {
    if (PortKeyImpl.made(raw)) return PortKeyImpl.parse(wireFormOf(raw));
    if (typeof raw !== "string") return { ok: false, error: FORM };
    const at = raw.lastIndexOf("#");
    const owner = PackId.parse(raw.slice(0, at));
    const name = raw.slice(at + 1);
    if (at < 0 || !owner.ok || !PORT_NAME.test(name)) return { ok: false, error: FORM };
    return { ok: true, value: new PortKeyImpl(owner.value, name) };
  }

  /** Whether `raw` is a port key this copy of bounded made. */
  static genuine(raw: unknown): raw is Contract.BasePortKey {
    return raw instanceof PortKeyImpl;
  }

  equals(other: Contract.BasePortKey): boolean {
    return this.toJSON() === other.toJSON();
  }

  toJSON(): string {
    return `${this.owner.value}#${this.name}`;
  }
}

export type PortKey<T, Owner extends PackIdType = PackIdType> = Contract.PortKey<T, Owner>;
export const PortKey: Contract.PortKeyFactory = PortKeyImpl;
export const { portKeysFor } = PortKey;
/** Whether `raw` is a port key this copy of bounded made. */
export const isPortKey = PortKeyImpl.genuine;
