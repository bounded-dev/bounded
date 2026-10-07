import type { Result } from "../shared/result.ts";
import type * as Contract from "./pack-id.contract.ts";

// A value object that is a branded string rather than a class: the id must
// stay readable text in messages, logs and (later) data-only packs.
const PACKAGE = "(@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*";
const LOCAL = "[a-z][a-z0-9]*(-[a-z0-9]+)*";
const ID = new RegExp(`^${PACKAGE}/${LOCAL}$`);

function parse(raw: unknown): Result<PackId> {
  if (typeof raw !== "string") return { ok: false, error: "A pack id must be a string" };
  if (!ID.test(raw)) {
    return { ok: false, error: `Pack id '${raw}' must be an npm package name, '/', and lowercase words joined by hyphens, such as 'bounded/path-gate'` };
  }
  // The brand exists only in types; the checked text is the id.
  return { ok: true, value: raw as PackId };
}

function forPackage(pkg: string): (local: string) => never {
  // Never throws: an id built from untyped parts is refused by parse, at
  // composition. The brand exists only in types, as in parse.
  return (local) => `${pkg}/${local}` as never;
}

export type PackId<Text extends string = string> = Contract.PackId<Text>;
export const PackId: Contract.PackIdFactory = Object.freeze({ parse, forPackage });
export const packIdsFor = PackId.forPackage;
