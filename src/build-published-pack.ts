// Builds a published pack's package's dist/ (ADR 2026-030): JavaScript for
// Node and declarations, as bounded's build does for bounded (ADR 2026-016).
// One build for every published package, run by each package's prepack in its
// own directory (`bun ../../build-published-pack.ts`) and before the
// workspace's tests (test-preload.ts), so no package carries a build of its
// own.
//
// - Every export path whose `default` condition is under dist/ and that has a
//   `bun` (TypeScript source) target is built from it, in one code-split
//   build mirroring the package in dist/ (packs/<pack>/index.ts is
//   dist/packs/<pack>/index.js). Every package import stays external.
// - Its declarations (each export's `types`, under dist/types, mirroring the
//   package) are emitted by tsc against bounded's built declarations: without
//   the `bun` condition, so `bounded/domain` resolves to src/dist/types, as a
//   consumer's tsc resolves it. bounded's dist/ must be built first
//   (src/build-dist.ts). Each relative `.ts` specifier is rewritten to `.js`.
// - Then it checks the build: every export target exists, and dist/ imports
//   nothing but node's modules, bounded's export paths, the package's own and
//   its dependencies.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { importsOf } from "./build-dist.ts";

/** bounded's directory, src/: this build, bounded's built declarations and the workspace's tsconfig.base.json above it. */
const HERE = import.meta.dir;

type Target = string | Record<string, string>;
interface Manifest {
  readonly name?: string;
  readonly exports?: Record<string, Target>;
  readonly dependencies?: Record<string, string>;
}

/** Why `file` in a published package's dist may not import `spec`, or undefined when it may: node's modules, bounded's export paths, the package's own export paths and its `dependencies` only. */
export function unknownPublishedPackImport(file: string, spec: string, packageName: string, dependencies: readonly string[]): string | undefined {
  const isPackage = (name: string): boolean => spec === name || spec.startsWith(`${name}/`);
  const known = spec.startsWith("node:") || isPackage("bounded") || isPackage(packageName) || dependencies.some(isPackage);
  return known ? undefined : `${file} imports ${spec}, which is neither node's, bounded's, ${packageName}'s nor one of ${packageName}'s dependencies: add it to ${packageName}'s dependencies`;
}

/** Why a published package's declarations cannot be emitted yet, or undefined when they can: bounded's declarations must be built first. */
export function missingBoundedDeclarations(boundedDir: string): string | undefined {
  return existsSync(join(boundedDir, "dist", "types")) ? undefined : "bounded's declarations are not built (src/dist/types is missing): build bounded first with bun src/build-dist.ts";
}

/** The package's declarations in dist/types, emitted by tsc from its export entries against bounded's built declarations. */
async function buildDeclarations(packageDir: string, entries: readonly string[]): Promise<void> {
  const missing = missingBoundedDeclarations(HERE);
  if (missing !== undefined) throw new Error(missing);
  // A package holds only package.json, README.md, LICENSE, packs/ and test/ at its root, so its tsconfig is written elsewhere.
  const configDir = mkdtempSync(join(tmpdir(), "bounded-published-pack-types-"));
  const config = join(configDir, "tsconfig.json");
  writeFileSync(
    config,
    JSON.stringify({
      extends: join(resolve(HERE, ".."), "tsconfig.base.json"),
      compilerOptions: { declaration: true, emitDeclarationOnly: true, noEmit: false, rootDir: packageDir, outDir: join(packageDir, "dist", "types"), customConditions: [], types: [] },
      files: entries,
    }),
  );
  try {
    const tsc = Bun.resolveSync("typescript/bin/tsc", HERE);
    const emitted = Bun.spawnSync([process.execPath, tsc, "-p", config], { cwd: packageDir, stdout: "pipe", stderr: "pipe" });
    if (emitted.exitCode !== 0) throw new Error(`${packageDir}'s declarations could not be emitted:\n${emitted.stdout.toString()}${emitted.stderr.toString()}`);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
  for await (const path of new Bun.Glob("dist/types/**/*.d.ts").scan({ cwd: packageDir })) {
    const file = join(packageDir, path);
    const text = await Bun.file(file).text();
    const rewritten = text.replace(/((?:\bfrom|\bimport)\s*\(?\s*")(\.{1,2}\/[^"]*)\.ts(")/g, "$1$2.js$3");
    if (rewritten !== text) await Bun.write(file, rewritten);
  }
}

/** Builds a published package's dist/ and checks it. */
export async function buildPublishedPack(packageDir: string): Promise<void> {
  const manifest = (await Bun.file(join(packageDir, "package.json")).json()) as Manifest;
  const packageName = manifest.name ?? "";
  if (packageName === "") throw new Error(`${join(packageDir, "package.json")} names no package: give it a name`);
  await rm(join(packageDir, "dist"), { recursive: true, force: true });

  const library = Object.values(manifest.exports ?? {}).flatMap((target) => (typeof target === "object" && target.default?.startsWith("./dist/") && target.bun !== undefined ? [target] : []));
  const entries = library.map((target) => join(packageDir, target.bun ?? ""));
  if (entries.length === 0) throw new Error(`${packageName} has no export to build: give each export a bun source and a default under ./dist/`);
  const built = await Bun.build({
    entrypoints: entries,
    root: packageDir,
    outdir: join(packageDir, "dist"),
    target: "node",
    format: "esm",
    splitting: true,
    packages: "external",
    naming: { entry: "[dir]/[name].[ext]", chunk: "chunks/[name]-[hash].[ext]" },
  });
  if (!built.success) throw new AggregateError(built.logs, `${packageName} could not be built`);
  await buildDeclarations(packageDir, entries);

  const targets = Object.values(manifest.exports ?? {}).flatMap((target) => (typeof target === "string" ? [target] : [target.default ?? "", target.types ?? ""])).filter((target) => target.startsWith("./dist/"));
  for (const target of targets) {
    if (!(await Bun.file(join(packageDir, target)).exists())) throw new Error(`${target} was not built: ${packageName}'s exports and build-published-pack.ts disagree`);
  }
  const dependencies = Object.keys(manifest.dependencies ?? {});
  for await (const path of new Bun.Glob("dist/**/*.js").scan({ cwd: packageDir })) {
    for (const spec of importsOf(await Bun.file(join(packageDir, path)).text())) {
      const problem = unknownPublishedPackImport(path, spec, packageName, dependencies);
      if (problem !== undefined) throw new Error(problem);
    }
  }
}

if (import.meta.main) await buildPublishedPack(process.cwd());
