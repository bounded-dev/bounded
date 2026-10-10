// A library the package catalogue build uses, loaded from the package being
// catalogued (ADR 2026-029): its author installs typescript,
// ts-json-schema-generator and marked as devDependencies, so a project that
// only installs bounded never downloads them. Resolved as Node's require
// resolves it from the package's own package.json, then imported. Not in the
// adapters' barrel: it serves the catalogue build's adapters only.
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Result } from "bounded/domain";

const message = (thrown: unknown): string => (thrown instanceof Error ? thrown.message : String(thrown));

/** The library `name` as the package at `packageDir` resolves it, imported, with the file it was resolved to; or a refusal naming it and the fix. */
export async function loadPackageLibrary(packageDir: string, name: string): Promise<Result<{ readonly module: unknown; readonly path: string }>> {
  let resolved: string;
  try {
    resolved = createRequire(join(packageDir, "package.json")).resolve(name);
  } catch {
    return { ok: false, error: `${name} cannot be found from ${packageDir}: install ${name} as a devDependency of the package to build its catalogue` };
  }
  try {
    return { ok: true, value: { module: await import(pathToFileURL(resolved).href), path: resolved } };
  } catch (thrown) {
    return { ok: false, error: `${name}, found at ${resolved}, cannot be loaded (${message(thrown)}): reinstall it as a devDependency of the package to build its catalogue` };
  }
}
