// A temporary copy of the demonstration package (src/core/test/fixtures/catalog/demo-package/),
// as a pack author's checkout holds it: bounded installed as a link to src/, the libraries the
// catalogue build resolves from the package linked to the repository's copies, and its pack
// built to JavaScript, as its export path's `default` target names it.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** The repository's root: this file is src/core/application/catalog/build-package-catalog/. */
export const REPOSITORY_ROOT = resolve(import.meta.dir, "../../../../..");
/** bounded's directory, src/: what the package's node_modules/bounded links to. */
export const BOUNDED_DIR = join(REPOSITORY_ROOT, "src");
/** The fixture the copies are made from. */
export const DEMO_PACKAGE = join(BOUNDED_DIR, "core", "test", "fixtures", "catalog", "demo-package");
/** The libraries a pack author installs to build a catalogue (ADR 2026-026). */
export const CATALOGUE_LIBRARIES = ["typescript", "ts-json-schema-generator", "marked"] as const;

export interface DemoPackageOptions {
  /** Files to write over the copy, by package-relative path. */
  readonly files?: Readonly<Record<string, string>>;
  /** Package-relative paths to remove from the copy. */
  readonly remove?: readonly string[];
  /** A change to the copy's package.json. */
  readonly manifest?: (manifest: Record<string, unknown>) => Record<string, unknown>;
  /** The libraries linked into its node_modules; all three by default. */
  readonly libraries?: readonly string[];
  /** Whether its pack is built to dist/demo/index.js; true by default. */
  readonly build?: boolean;
}

/** A fresh copy of the demonstration package: its directory, a real path. */
export async function demoPackage(options: DemoPackageOptions = {}): Promise<string> {
  const packageDir = realpathSync(mkdtempSync(join(tmpdir(), "bounded-demo-package-")));
  cpSync(DEMO_PACKAGE, packageDir, { recursive: true });
  for (const path of options.remove ?? []) rmSync(join(packageDir, path), { recursive: true, force: true });
  for (const [path, text] of Object.entries(options.files ?? {})) {
    mkdirSync(dirname(join(packageDir, path)), { recursive: true });
    writeFileSync(join(packageDir, path), text);
  }
  if (options.manifest !== undefined) {
    const manifestPath = join(packageDir, "package.json");
    writeFileSync(manifestPath, `${JSON.stringify(options.manifest(JSON.parse(readFileSync(manifestPath, "utf8"))), null, 2)}\n`);
  }
  mkdirSync(join(packageDir, "node_modules"));
  symlinkSync(BOUNDED_DIR, join(packageDir, "node_modules", "bounded"), "dir");
  for (const library of options.libraries ?? CATALOGUE_LIBRARIES) symlinkSync(join(REPOSITORY_ROOT, "node_modules", library), join(packageDir, "node_modules", library), "dir");
  if (options.build !== false) {
    const built = await Bun.build({ entrypoints: [join(packageDir, "packs", "demo", "index.ts")], outdir: join(packageDir, "dist", "demo"), target: "node", format: "esm", packages: "external" });
    if (!built.success) throw new AggregateError(built.logs, "the demonstration pack could not be built");
  }
  return packageDir;
}
