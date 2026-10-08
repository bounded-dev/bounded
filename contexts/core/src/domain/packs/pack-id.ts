import type { Result } from "../shared/result.ts";
import type * as Contract from "./pack-id.contract.ts";

const PACKAGE = "(@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*";
const LOCAL = "[a-z][a-z0-9]*(-[a-z0-9]+)*";
const ID = new RegExp(`^${PACKAGE}/${LOCAL}$`);

class PackIdImpl<Text extends string = string> implements Contract.PackId<Text> {
  declare readonly __brand: "PackId";
  readonly #made = true;

  private constructor(readonly value: Text) {
    Object.freeze(this);
  }

  /** Whether `raw` was made by this class (not merely an object that inherits from one): parse trusts it as it is. */
  static made(raw: unknown): raw is PackIdImpl<string> {
    return typeof raw === "object" && raw !== null && #made in raw;
  }

  /** A pack id from its text, or the id itself once its text is checked (packIdsFor checks literals only at compile time). */
  static parse(raw: unknown): Result<PackId> {
    const text: unknown = PackIdImpl.made(raw) ? raw.value : raw;
    if (typeof text !== "string") return { ok: false, error: "A pack id must be a string" };
    if (!ID.test(text)) {
      return { ok: false, error: `Pack id '${text}' must be an npm package name, '/', and lowercase words joined by hyphens, such as 'bounded/path-gate'` };
    }
    return { ok: true, value: PackIdImpl.made(raw) ? raw : new PackIdImpl(text) };
  }

  static forPackage(pkg: string): (local: string) => never {
    // Never throws: the parts are checked as literals at compile time, and an
    // id built from untyped parts keeps its text for composition to refuse
    // with PackId.parse's reason. The exact text type is the factory's
    // signature (PackIdFactory.forPackage).
    return (local) => new PackIdImpl(`${pkg}/${local}`) as never;
  }

  equals(other: PackId): boolean {
    return this.value === other.value;
  }

  toJSON(): Text {
    return this.value;
  }
}

/** An id's text for messages, whatever it is. */
export function packIdText(id: unknown): string {
  return PackIdImpl.made(id) ? id.value : String(id);
}

export type PackId<Text extends string = string> = Contract.PackId<Text>;
export const PackId: Contract.PackIdFactory = PackIdImpl;
export const packIdsFor = PackId.forPackage;
