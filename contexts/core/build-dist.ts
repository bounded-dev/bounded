// Builds bounded's dist/: JavaScript for Node, so nothing needs bun at run
// time (ADR 2026-016). Run by the package's prepack (so `bun pm pack` and
// `bun publish` always ship a fresh build) and before the workspace's tests.
//
// - The library: every export path whose `default` condition is under dist/
//   is built from its `bun` (TypeScript source) target, in one code-split
//   build mirroring src/ in dist/, so code two entry points share is one
//   module, as in the source.
// - The apps bounded carries: the CLI (its bin) and the host adapters, private
//   apps in source. The list of bundled hosts lives here and in the
//   package's export paths, never in the core's code.
// Every package import stays external: `bounded/*` resolves through the
// package's own export paths, and anything else must be one of bounded's
// dependencies, so the tree-sitter grammar and the rest load from node_modules.
import { mkdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const HERE = import.meta.dir;
const APPS = join(HERE, "..", "..", "apps");

/** What bounded carries from the apps: each entry point, where it goes, and whether it is run as a program. */
const CARRIED: readonly { readonly entry: string; readonly out: string; readonly program?: true }[] = [
  { entry: join(APPS, "cli", "src", "main.ts"), out: "dist/cli.js", program: true },
  { entry: join(APPS, "claude-code", "src", "main.ts"), out: "dist/hosts/claude-code/hook.js", program: true },
  { entry: join(APPS, "claude-code", "src", "host-installer.ts"), out: "dist/hosts/claude-code/host-installer.js" },
  { entry: join(APPS, "pi", "src", "index.ts"), out: "dist/hosts/pi/index.js" },
  { entry: join(APPS, "pi", "src", "host-installer.ts"), out: "dist/hosts/pi/host-installer.js" },
];

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

/** Builds dist/ and checks it: every export target built, and nothing imported but node's modules, bounded and its dependencies. */
export async function buildDist(): Promise<void> {
  const manifest = (await Bun.file(join(HERE, "package.json")).json()) as Manifest;
  await rm(join(HERE, "dist"), { recursive: true, force: true });

  const library = Object.values(manifest.exports).flatMap((target) => (typeof target === "object" && target.default?.startsWith("./dist/") && target.bun !== undefined ? [target] : []));
  const built = await Bun.build({
    entrypoints: library.map((target) => join(HERE, target.bun ?? "")),
    root: join(HERE, "src"),
    outdir: join(HERE, "dist"),
    target: "node",
    format: "esm",
    splitting: true,
    packages: "external",
    naming: { entry: "[dir]/[name].[ext]", chunk: "chunks/[name]-[hash].[ext]" },
  });
  if (!built.success) throw new AggregateError(built.logs, "bounded's library could not be built");

  for (const { entry, out, program } of CARRIED) {
    // Split, so an entry's dynamic imports stay dynamic: the Claude Code hook's bootstrap loads everything
    // inside its try, so a missing module is a deny, not a crash before it (apps/claude-code/src/main.ts).
    await mkdir(dirname(join(HERE, out)), { recursive: true });
    const carried = await Bun.build({
      entrypoints: [entry],
      outdir: dirname(join(HERE, out)),
      target: "node",
      format: "esm",
      splitting: true,
      packages: "external",
      naming: { entry: basename(out), chunk: "chunks/[name]-[hash].[ext]" },
    });
    if (!carried.success) throw new AggregateError(carried.logs, `${entry} could not be built`);
    const text = (await Bun.file(join(HERE, out)).text()).replace(/^#!.*\n/, "").replace(/^\/\/ @bun.*\n/, "");
    await Bun.write(join(HERE, out), program === true ? `#!/usr/bin/env node\n${text}` : text);
  }

  const allowed = new Set(Object.keys(manifest.dependencies ?? {}));
  const targets = Object.values(manifest.exports).flatMap((target) => (typeof target === "string" ? [target] : [target.default ?? ""])).filter((target) => target.startsWith("./dist/"));
  for (const target of [...targets, ...CARRIED.map(({ out }) => `./${out}`)]) {
    const file = Bun.file(join(HERE, target));
    if (!(await file.exists())) throw new Error(`${target} was not built: bounded's exports and build-dist.ts disagree`);
  }
  for await (const path of new Bun.Glob("dist/**/*.js").scan({ cwd: HERE })) {
    for (const spec of importsOf(await Bun.file(join(HERE, path)).text())) {
      const known = spec.startsWith("node:") || spec === "bounded" || spec.startsWith("bounded/") || allowed.has(spec) || [...allowed].some((name) => spec.startsWith(`${name}/`));
      if (!known) throw new Error(`${path} imports ${spec}, which is neither node's, bounded's nor one of bounded's dependencies: add it to bounded's dependencies`);
    }
  }
}

if (import.meta.main) await buildDist();
