import type { packageManifestBrand } from "./package-manifest.contract.ts";
import { z } from "zod";
import { readSafely } from "../shared/read.ts";
import type { Result } from "../shared/result.ts";
import { sameWire, wireFormOf } from "../shared/wire.ts";
import type * as Contract from "./package-manifest.contract.ts";

const BOUNDED_FIELD = '"bounded": { "catalog": "./bounded.catalog.json", "packs": { "./<export path>": "<pack directory>" } }';
const NO_PACKS = `package.json has no bounded.packs: add ${BOUNDED_FIELD} to it, listing each export path that exports a pack with the pack's source directory`;

// What the build reads of package.json: kept inside the module, since a zod schema cannot be frozen. Every other field is the package's own.
const manifestSchema = z.object({ name: z.string(), version: z.string() });
const boundedSchema = z.object({ catalog: z.string().optional(), packs: z.record(z.string(), z.string()) });

/** A package-relative path without its leading `./` and trailing `/`, or undefined when it leaves the package or is not relative. */
function packageRelative(given: string): string | undefined {
  const path = given.replace(/^\.\//, "").replace(/\/+$/, "");
  if (path === "" || path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path) || path.split("/").some((segment) => segment === ".." || segment === "." || segment === "")) return undefined;
  return path;
}

class PackageManifestImpl implements Contract.PackageManifest {
  declare readonly __brand: "PackageManifest";
  declare readonly [packageManifestBrand]: true;
  readonly #made = true;

  private constructor(
    readonly name: string,
    readonly version: string,
    readonly catalogPath: string,
    readonly packs: readonly Contract.ListedPack[],
  ) {
    Object.freeze(this);
  }

  /** Whether `raw` was made by this class (not merely an object that inherits from one): parse checks its wire form again, since a constructor can be called at run time. */
  static made(raw: unknown): raw is PackageManifestImpl {
    return typeof raw === "object" && raw !== null && #made in raw;
  }

  static parse(raw: unknown): Result<Contract.PackageManifest> {
    return readSafely<Contract.PackageManifest>("package.json", () => {
      const given = PackageManifestImpl.made(raw) ? wireFormOf(raw) : raw;
      if (typeof given !== "object" || given === null || Array.isArray(given)) return { ok: false, error: "package.json is not a JSON object" };
      const manifest = manifestSchema.safeParse(given);
      if (!manifest.success || manifest.data.name.trim() === "" || manifest.data.version.trim() === "") return { ok: false, error: "package.json has no name and version: a package catalogue names its package and version" };
      const bounded = boundedSchema.safeParse("bounded" in given ? given.bounded : undefined);
      if (!bounded.success || Object.keys(bounded.data.packs).length === 0) return { ok: false, error: NO_PACKS };
      const catalogPath = bounded.data.catalog === undefined ? undefined : packageRelative(bounded.data.catalog);
      if (catalogPath === undefined || !catalogPath.endsWith(".json")) return { ok: false, error: `package.json's bounded.catalog does not name a .json file in the package: give "catalog": "./bounded.catalog.json"` };
      const packs: Contract.ListedPack[] = [];
      for (const [exportPath, dir] of Object.entries(bounded.data.packs)) {
        if (exportPath !== "." && (!exportPath.startsWith("./") || packageRelative(exportPath) === undefined)) return { ok: false, error: `package.json's bounded.packs lists '${exportPath}', which is not an export path: name it as package.json's exports does, such as "./${exportPath.replace(/^[./]+/, "")}"` };
        const packDir = packageRelative(dir);
        if (packDir === undefined) return { ok: false, error: `package.json's bounded.packs gives ${exportPath} the directory '${dir}', which is not in the package: give the pack's source directory, package-relative, such as "packs/<name>"` };
        packs.push(Object.freeze({ exportPath, packDir }));
      }
      return { ok: true, value: new PackageManifestImpl(manifest.data.name, manifest.data.version, catalogPath, Object.freeze(packs)) };
    });
  }

  equals(other: Contract.PackageManifest): boolean {
    try {
      return sameWire(this, other);
    } catch {
      return false;
    }
  }

  toJSON(): Contract.PackageManifestJSON {
    // A value forged with the constructor may hold anything: its wire form is still read without throwing, and parse refuses it.
    const packs: readonly Contract.ListedPack[] = Array.isArray(this.packs) ? this.packs : [];
    return { name: this.name, version: this.version, bounded: { catalog: `./${this.catalogPath}`, packs: Object.fromEntries(packs.map(({ exportPath, packDir }) => [exportPath, packDir])) } };
  }
}

export type PackageManifest = Contract.PackageManifest;
export const PackageManifest: Contract.PackageManifestFactory = PackageManifestImpl;
