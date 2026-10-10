import type { Result } from "../shared/result.ts";

/** The brand only PackageManifest itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const packageManifestBrand: unique symbol;

/** One pack a package lists: the export path that exports it (`./prereqs`) and its source directory, package-relative (`packs/prereqs`). */
export interface ListedPack {
  readonly exportPath: string;
  readonly packDir: string;
}

/** What a package catalogue build reads of a package.json: its name, its version and its `bounded` field. */
export interface PackageManifestJSON {
  readonly name: string;
  readonly version: string;
  readonly bounded: {
    /** Where the catalogue is written: `./bounded.catalog.json`. */
    readonly catalog: string;
    /** Each export path that exports a pack, and that pack's source directory. */
    readonly packs: Readonly<Record<string, string>>;
  };
}

/**
 * A package's manifest as the package catalogue build reads it (ADR
 * 2026-026): its name and version, the package-relative path its catalogue
 * is written to, and each pack it lists in `bounded.packs`, by export path
 * and source directory.
 */
export interface PackageManifest {
  readonly __brand: "PackageManifest";
  readonly [packageManifestBrand]: true;
  readonly name: string;
  readonly version: string;
  /** The catalogue's package-relative path, without a leading `./`. */
  readonly catalogPath: string;
  /** The packs it lists, in the order it lists them. */
  readonly packs: readonly ListedPack[];
  equals(other: PackageManifest): boolean;
  toJSON(): PackageManifestJSON;
}

export interface PackageManifestFactory {
  /**
   * The manifest, from a package.json's JSON, or why it cannot be built from:
   * not an object; no name or version; no `bounded.catalog` naming a
   * package-relative `.json` file; no `bounded.packs`, or one that lists no
   * pack; an export path that is not `./<path>`, or a pack directory that is
   * not package-relative. Never throws.
   */
  parse(raw: unknown): Result<PackageManifest>;
}
