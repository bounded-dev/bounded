// The files of a package the package catalogue build reads and writes, on disk, by package-relative path (ADR 2026-029).
import { readdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { PackageCatalogFiles } from "bounded/application";
import type { Result } from "bounded/domain";

const EXAMPLE = /^[^/]+\.config\.ts$/;
const message = (thrown: unknown): string => (thrown instanceof Error ? thrown.message : String(thrown));
const isMissing = (thrown: unknown): boolean => typeof thrown === "object" && thrown !== null && "code" in thrown && (thrown.code === "ENOENT" || thrown.code === "ENOTDIR");

/** The absolute path of a package-relative `path`, or undefined when it is absolute or leaves the package. */
function inside(packageDir: string, path: string): string | undefined {
  if (isAbsolute(path)) return undefined;
  const absolute = resolve(packageDir, path);
  const within = relative(resolve(packageDir), absolute);
  return within === "" || within.split(sep)[0] === ".." || isAbsolute(within) ? undefined : absolute;
}

export class FileSystemPackageCatalogFiles implements PackageCatalogFiles {
  async readManifest(packageDir: string): Promise<Result<unknown>> {
    const path = join(packageDir, "package.json");
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (thrown) {
      return { ok: false, error: `${path} cannot be read (${message(thrown)}): run the build in the package's directory, beside its package.json` };
    }
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (thrown) {
      return { ok: false, error: `${path} is not JSON (${message(thrown)}): fix package.json` };
    }
  }

  async readText(packageDir: string, path: string): Promise<Result<string | null>> {
    const file = inside(packageDir, path);
    if (file === undefined) return { ok: false, error: `${path} is not a file in the package at ${packageDir}` };
    try {
      return { ok: true, value: await readFile(file, "utf8") };
    } catch (thrown) {
      return isMissing(thrown) ? { ok: true, value: null } : { ok: false, error: `${path} cannot be read: ${message(thrown)}` };
    }
  }

  async listExamples(packageDir: string, packDir: string): Promise<Result<readonly string[]>> {
    const dir = inside(packageDir, join(packDir, "examples"));
    if (dir === undefined) return { ok: false, error: `${packDir} is not a directory in the package at ${packageDir}` };
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return { ok: true, value: entries.filter((entry) => entry.isFile() && EXAMPLE.test(entry.name)).map((entry) => `${packDir}/examples/${entry.name}`).sort() };
    } catch (thrown) {
      return isMissing(thrown) ? { ok: true, value: [] } : { ok: false, error: `${packDir}/examples cannot be read: ${message(thrown)}` };
    }
  }

  async write(packageDir: string, path: string, text: string): Promise<Result<string>> {
    const file = inside(packageDir, path);
    if (file === undefined) return { ok: false, error: `${path} is outside the package at ${packageDir}: the catalogue is written inside the package` };
    try {
      await writeFile(file, text);
      return { ok: true, value: relative(resolve(packageDir), file).split("\\").join("/") };
    } catch (thrown) {
      return { ok: false, error: `${path} could not be written: ${message(thrown)}` };
    }
  }
}
