// Builds bounded's dist/: JavaScript for Node, so nothing needs bun at run
// time (ADR 2026-016). Run by the package's prepack (so `bun pm pack` and
// `bun publish` always ship a fresh build) and before the workspace's tests.
//
// - The library: every export path whose `default` condition is under dist/
//   and that has a `bun` (TypeScript source) target is built from it, in one
//   code-split build mirroring src/ in dist/ (src/core/domain/index.ts is
//   dist/core/domain/index.js, ADR 2026-024), so code two entry points share
//   is one module, as in the source.
// - The code bounded carries from private workspace packages: the CLI (its
//   bin, src/cli) and the host adapters (src/hosts), private apps in source,
//   and bounded's shell command reader, the private context
//   bounded-shell-command-reader (src/lib/shell-command-reader), built as the
//   export bounded/shell-command-reader (ADR 2026-020). The list lives here
//   and in the package's export paths, never in the core's code.
// Every package import stays external: `bounded/*` resolves through the
// package's own export paths, and anything else must be one of bounded's
// dependencies, so the tree-sitter grammar and the rest load from node_modules.
// Two exceptions, both for the private reader package (ADR 2026-020): its
// own entry's imports of its own export paths (bounded-shell-command-reader/
// application, /adapters) resolve to their sources and are built in; and a
// carried app's import of its entry (bounded-shell-command-reader/
// shell-command-reading) becomes an import of bounded/shell-command-reader,
// so dist holds one copy of the reader and imports no private package.
import { mkdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import type { BunPlugin } from "bun";

/** bounded's directory, src/: its manifest, this build and the sources it ships (ADR 2026-024). */
const HERE = import.meta.dir;
const HOSTS = join(HERE, "hosts");
const READER = join(HERE, "lib", "shell-command-reader");
/** The reader package's name: its export paths are `${READER_PACKAGE}/<path>`. */
const READER_PACKAGE = "bounded-shell-command-reader";
/** The reader's entry, its composition root: what bounded/shell-command-reader is built from. */
const READER_ENTRY = join(READER, "composition-root", "shell-command-reading.ts");

/** What bounded carries from private packages: each entry point, where it goes, whether it is run as a program, and whether it is the reader, built with its own package's sources. */
const CARRIED: readonly { readonly entry: string; readonly out: string; readonly program?: true; readonly reader?: true }[] = [
  { entry: join(HERE, "cli", "main.ts"), out: "dist/cli.js", program: true },
  { entry: join(HOSTS, "claude-code", "main.ts"), out: "dist/hosts/claude-code/hook.js", program: true },
  { entry: join(HOSTS, "claude-code", "host-installer.ts"), out: "dist/hosts/claude-code/host-installer.js" },
  { entry: join(HOSTS, "pi", "index.ts"), out: "dist/hosts/pi/index.js" },
  { entry: join(HOSTS, "pi", "host-installer.ts"), out: "dist/hosts/pi/host-installer.js" },
  { entry: READER_ENTRY, out: "dist/shell-command-reader/index.js", reader: true },
];

/** The private workspace packages' export paths the carried apps import, each with the bounded export path dist reaches it through. */
export const PRIVATE_PACKAGE_EXPORTS: Readonly<Record<string, string>> = Object.freeze({ "bounded-shell-command-reader/shell-command-reading": "bounded/shell-command-reader" });

/** Each private export path's source, whose value exports the mapped module re-exports by name. */
const PRIVATE_PACKAGE_SOURCES: Readonly<Record<string, string>> = Object.freeze({ "bounded-shell-command-reader/shell-command-reading": READER_ENTRY });

/** The reader package's export paths (its manifest's `exports`), each with its source file relative to the package. */
async function readerExports(): Promise<Readonly<Record<string, string>>> {
  const manifest = (await Bun.file(join(READER, "package.json")).json()) as { exports?: Record<string, string> };
  return Object.freeze(Object.fromEntries(Object.entries(manifest.exports ?? {}).map(([path, target]) => [`${READER_PACKAGE}${path.slice(1)}`, target])));
}

type Target = string | Record<string, string>;
interface Manifest {
  readonly exports: Record<string, Target>;
  readonly dependencies?: Record<string, string>;
}

/** The package imports a built file makes: its import and export statements' and dynamic imports' specifiers that are not relative. */
const importsOf = (text: string): string[] =>
  [...text.matchAll(/^(?:import|export)\b[^";]*?\bfrom\s*"([^"]+)"/gm), ...text.matchAll(/^import\s*"([^"]+)"/gm), ...text.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g)]
    .map(([, spec = ""]) => spec)
    .filter((spec) => !spec.startsWith("."));

/** Why `file` in dist may not import `spec`, or undefined when it may: node's modules, bounded's own export paths and bounded's `dependencies` only. */
export function unknownDistImport(file: string, spec: string, dependencies: readonly string[]): string | undefined {
  const known = spec.startsWith("node:") || spec === "bounded" || spec.startsWith("bounded/") || dependencies.includes(spec) || dependencies.some((name) => spec.startsWith(`${name}/`));
  return known ? undefined : `${file} imports ${spec}, which is neither node's, bounded's nor one of bounded's dependencies: add it to bounded's dependencies`;
}

/**
 * Maps each private package's export path (PRIVATE_PACKAGE_EXPORTS) to a
 * module re-exporting, by name, what bounded's own export path for it
 * exports, so the bundle imports that external path instead of inlining the
 * private package.
 */
const privatePackageExports: BunPlugin = {
  name: "bounded-private-package-exports",
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, ({ path }) => (Object.hasOwn(PRIVATE_PACKAGE_EXPORTS, path) ? { path, namespace: "bounded-private-package" } : undefined));
    build.onLoad({ filter: /.*/, namespace: "bounded-private-package" }, async ({ path }) => {
      const source = PRIVATE_PACKAGE_SOURCES[path];
      const target = PRIVATE_PACKAGE_EXPORTS[path];
      if (source === undefined || target === undefined) throw new Error(`${path} has no export of bounded mapped for it`);
      const names = Object.keys((await import(source)) as Record<string, unknown>);
      return { contents: `export { ${names.join(", ")} } from ${JSON.stringify(target)};\n`, loader: "js" };
    });
  },
};

/**
 * For the reader's own entry: each of its package's export paths it imports
 * resolves to that path's source, so the reader is built whole into
 * dist/shell-command-reader and imports nothing of its private package.
 */
function readerOwnSources(exports: Readonly<Record<string, string>>): BunPlugin {
  return {
    name: "bounded-reader-own-sources",
    setup(build) {
      build.onResolve({ filter: /^bounded-shell-command-reader\// }, ({ path }) => {
        const target = exports[path];
        if (target === undefined) throw new Error(`${path} is not an export path of ${READER_PACKAGE}`);
        return { path: join(READER, target) };
      });
    },
  };
}

/**
 * The declarations a consumer's tsc reads (dist/types, each export path's
 * `types`): emitted from the sources by tsc (tsconfig.types.json: the
 * core's, the shipped packs' and the shell command reader's entry, under
 * src/), placed so src/ is dist/types (dist/types/core, dist/types/packs)
 * and the reader's is dist/types/shell-command-reader, with an index there,
 * and each relative `.ts` specifier rewritten to `.js`, as a consumer's tsc
 * resolves declarations without allowImportingTsExtensions. A reader
 * declaration's import of its own package's export path is rewritten to the
 * relative path of that export's declaration, so no published declaration
 * names the private package.
 */
async function buildDeclarations(exports: Readonly<Record<string, string>>): Promise<void> {
  const emittedRoot = join(HERE, "dist", "types-emitted");
  const tsc = Bun.resolveSync("typescript/bin/tsc", HERE);
  const emitted = Bun.spawnSync([process.execPath, tsc, "-p", join(HERE, "tsconfig.types.json")], { cwd: HERE, stdout: "pipe", stderr: "pipe" });
  if (emitted.exitCode !== 0) throw new Error(`bounded's declarations could not be emitted:\n${emitted.stdout.toString()}${emitted.stderr.toString()}`);
  await rename(emittedRoot, join(HERE, "dist", "types"));
  const emittedLibraries = join(HERE, "dist", "types", relative(HERE, dirname(READER)));
  await rename(join(emittedLibraries, basename(READER)), join(HERE, "dist", "types", "shell-command-reader"));
  await rm(emittedLibraries, { recursive: true, force: true });
  const readerTypes = join(HERE, "dist", "types", "shell-command-reader");
  /** The declaration of the reader's export path `spec`, relative to `file`'s directory, as a `.js` specifier. */
  const ownExport = (file: string, spec: string): string => {
    const target = exports[spec];
    if (target === undefined) throw new Error(`${file} imports ${spec}, which is not an export path of ${READER_PACKAGE}`);
    const declaration = relative(dirname(file), join(readerTypes, target.replace(/\.ts$/, ".js")));
    return declaration.startsWith(".") ? declaration : `./${declaration}`;
  };
  for await (const path of new Bun.Glob("dist/types/**/*.d.ts").scan({ cwd: HERE })) {
    const file = join(HERE, path);
    const text = await Bun.file(file).text();
    const rewritten = text
      .replace(/((?:\bfrom|\bimport)\s*\(?\s*")(\.{1,2}\/[^"]*)\.ts(")/g, "$1$2.js$3")
      .replace(/((?:\bfrom|\bimport)\s*\(?\s*")(bounded-shell-command-reader\/[^"]*)(")/g, (_, before: string, spec: string, after: string) => `${before}${ownExport(file, spec)}${after}`);
    if (rewritten !== text) await Bun.write(file, rewritten);
  }
  // The export's declarations are its entry's (composition-root/shell-command-reading), placed at the export's own index with each relative specifier re-rooted there.
  const entry = join(readerTypes, "composition-root", "shell-command-reading.d.ts");
  const entryText = await Bun.file(entry).text();
  const reRooted = entryText.replace(/((?:\bfrom|\bimport)\s*\(?\s*")(\.{1,2}\/[^"]*)(")/g, (_, before: string, spec: string, after: string) => `${before}./${relative(readerTypes, join(dirname(entry), spec))}${after}`);
  await Bun.write(join(readerTypes, "index.d.ts"), reRooted);
}

/** Builds dist/ and checks it: every export target built, and nothing imported but node's modules, bounded and its dependencies. */
export async function buildDist(): Promise<void> {
  const manifest = (await Bun.file(join(HERE, "package.json")).json()) as Manifest;
  await rm(join(HERE, "dist"), { recursive: true, force: true });

  const library = Object.values(manifest.exports).flatMap((target) => (typeof target === "object" && target.default?.startsWith("./dist/") && target.bun !== undefined ? [target] : []));
  const built = await Bun.build({
    entrypoints: library.map((target) => join(HERE, target.bun ?? "")),
    root: HERE,
    outdir: join(HERE, "dist"),
    target: "node",
    format: "esm",
    splitting: true,
    packages: "external",
    naming: { entry: "[dir]/[name].[ext]", chunk: "chunks/[name]-[hash].[ext]" },
  });
  if (!built.success) throw new AggregateError(built.logs, "bounded's library could not be built");

  const ownReaderExports = await readerExports();
  for (const { entry, out, program, reader } of CARRIED) {
    // Split, so an entry's dynamic imports stay dynamic: the Claude Code hook's bootstrap loads everything
    // inside its try, so a missing module is a deny, not a crash before it (src/hosts/claude-code/main.ts).
    await mkdir(dirname(join(HERE, out)), { recursive: true });
    const carried = await Bun.build({
      entrypoints: [entry],
      outdir: dirname(join(HERE, out)),
      target: "node",
      format: "esm",
      splitting: true,
      packages: "external",
      plugins: [reader === true ? readerOwnSources(ownReaderExports) : privatePackageExports],
      naming: { entry: basename(out), chunk: "chunks/[name]-[hash].[ext]" },
    });
    if (!carried.success) throw new AggregateError(carried.logs, `${entry} could not be built`);
    const text = (await Bun.file(join(HERE, out)).text()).replace(/^#!.*\n/, "").replace(/^\/\/ @bun.*\n/, "");
    await Bun.write(join(HERE, out), program === true ? `#!/usr/bin/env node\n${text}` : text);
  }

  await buildDeclarations(ownReaderExports);

  const dependencies = Object.keys(manifest.dependencies ?? {});
  const targets = Object.values(manifest.exports).flatMap((target) => (typeof target === "string" ? [target] : [target.default ?? ""])).filter((target) => target.startsWith("./dist/"));
  const typeTargets = Object.values(manifest.exports).flatMap((target) => (typeof target === "object" && target.types?.startsWith("./dist/") ? [target.types] : []));
  for (const target of [...targets, ...typeTargets, ...CARRIED.map(({ out }) => `./${out}`)]) {
    const file = Bun.file(join(HERE, target));
    if (!(await file.exists())) throw new Error(`${target} was not built: bounded's exports and build-dist.ts disagree`);
  }
  for await (const path of new Bun.Glob("dist/**/*.js").scan({ cwd: HERE })) {
    for (const spec of importsOf(await Bun.file(join(HERE, path)).text())) {
      const problem = unknownDistImport(path, spec, dependencies);
      if (problem !== undefined) throw new Error(problem);
    }
  }
}

if (import.meta.main) await buildDist();
