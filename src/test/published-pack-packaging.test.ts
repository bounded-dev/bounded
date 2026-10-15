// The published packs (ADR 2026-030): each src/published-packs/<name>/ is a
// package of its own, bounded-<name>, with bounded as a peer dependency. Its
// prepack (src/build-published-pack.ts, then bounded's built CLI's catalog
// build) compiles each export to JavaScript for Node in dist/, with
// declarations in dist/types, and writes its catalogue. Each package is
// packed once here and installed beside bounded (src/, built by the preload),
// as a project installs it; bounded's own tarball is covered by
// packaging.test.ts.
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { missingBoundedDeclarations, unknownPublishedPackImport } from "../build-published-pack.ts";

const ROOT = join(import.meta.dir, "..", "..");
const CORE = join(ROOT, "src");

type Target = string | Record<string, string>;
interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  license?: string;
  repository?: { type?: string; url?: string; directory?: string };
  engines?: Record<string, string>;
  type?: string;
  files?: string[];
  scripts?: Record<string, string>;
  keywords?: string[];
  exports?: Record<string, Target>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  bounded?: { catalog?: string; packs?: Record<string, string> };
}

const manifestOf = (dir: string): Manifest => JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8")) as Manifest;

/** Every published package's directory, from the repository root. */
const publishedPackageDirs = [...new Glob("src/published-packs/*/package.json").scanSync({ cwd: ROOT })].map((manifest) => manifest.slice(0, -"/package.json".length)).sort();

/** A published package, packed once: its directory, its manifest, its tarball and the files the tarball holds (without the leading package/). */
interface Packed {
  readonly dir: string;
  readonly manifest: Manifest;
  readonly tarball: string;
  readonly files: readonly string[];
}

/** Packs a published package with `bun pm pack` in its directory (its prepack runs) and lists its tarball. */
function pack(dir: string): Packed {
  const manifest = manifestOf(dir);
  const into = mkdtempSync(join(tmpdir(), "bounded-published-pack-"));
  const ran = Bun.spawnSync(["bun", "pm", "pack", "--destination", into, "--quiet"], { cwd: join(ROOT, dir), stdout: "pipe", stderr: "pipe" });
  if (ran.exitCode !== 0) throw new Error(`${dir} could not be packed:\n${ran.stdout.toString()}${ran.stderr.toString()}`);
  const tarball = join(into, `${manifest.name}-${manifest.version}.tgz`);
  const listed = Bun.spawnSync(["tar", "-tzf", tarball], { stdout: "pipe", stderr: "pipe" });
  if (listed.exitCode !== 0) throw new Error(`${tarball} could not be listed: ${listed.stderr.toString()}`);
  const files = listed.stdout
    .toString()
    .split("\n")
    .filter((line) => line !== "" && !line.endsWith("/"))
    .map((line) => line.replace(/^package\//, ""))
    .sort();
  return { dir, manifest, tarball, files };
}

const packed: readonly Packed[] = publishedPackageDirs.map(pack);

/** Every packed published package; it throws when there is none, so no case passes on an empty list. */
function everyPackage(): readonly Packed[] {
  if (packed.length === 0) throw new Error("no published package was found under src/published-packs/");
  return packed;
}
/** The example published package, packed; it throws when it is missing. */
function example(): Packed {
  const found = packed.find(({ dir }) => dir === "src/published-packs/example");
  if (found === undefined) throw new Error("src/published-packs/example was not found");
  return found;
}

/** The modules a built file imports: its import and export statements' (over several lines too) and dynamic imports' specifiers. */
const importsIn = (text: string): string[] =>
  [...text.matchAll(/^(?:import|export)\b[^";]*?\bfrom\s*"([^"]+)"/gm), ...text.matchAll(/^import\s*"([^"]+)"/gm), ...text.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g)].map(([, spec = ""]) => spec);

/** Every file under a directory. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]));
}

/** A scratch project with bounded linked to src/ and the example's tarball extracted into node_modules/bounded-example. */
function projectWithExample(): string {
  const project = mkdtempSync(join(tmpdir(), "bounded-published-pack-project-"));
  mkdirSync(join(project, "node_modules", "bounded-example"), { recursive: true });
  symlinkSync(CORE, join(project, "node_modules", "bounded"), "dir");
  expect(Bun.spawnSync(["tar", "-xzf", example().tarball, "-C", join(project, "node_modules", "bounded-example"), "--strip-components=1"]).exitCode).toBe(0);
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "project", type: "module" }));
  return project;
}

const CONFIG = [
  'import { contribution, defineConfig } from "bounded/domain";',
  'import { refusedToolsPack } from "bounded-example";',
  "export default defineConfig({",
  "  packs: [refusedToolsPack],",
  '  contributes: [contribution(refusedToolsPack.points.refusedTools, [{ tool: "web", redirect: "Read docs/ instead" }])],',
  "});",
  "",
].join("\n");

/** What a Node script opening `project` with bounded/open-project prints: the problem, and the verdicts for a web tool use and a read. */
function judgedUnderNode(project: string): { readonly problem: unknown; readonly listed: { kind: string; redirect?: string }; readonly unlisted: { kind: string } } {
  const script = [
    'const { openProject } = await import("bounded/open-project");',
    "const { judge, problem } = await openProject(process.cwd());",
    'const listed = await judge({ kind: "tool-use", role: null, tool: "web", effects: [{ kind: "fetch", url: "https://example.com" }] });',
    'const unlisted = await judge({ kind: "tool-use", role: null, tool: "read", effects: [{ kind: "read", path: "README.md" }] });',
    "console.log(JSON.stringify({ problem, listed, unlisted }));",
  ].join("\n");
  const ran = Bun.spawnSync(["node", "--input-type=module", "-e", script], { cwd: project, stdout: "pipe", stderr: "pipe" });
  const out = ran.stdout.toString().trim();
  if (ran.exitCode !== 0 || out === "") throw new Error(`node could not judge with the project:\n${out}${ran.stderr.toString()}`);
  return JSON.parse(out.split("\n").at(-1) ?? "");
}

describe("the published packs, each its own npm package", () => {
  test("finds every published package, the example among them", () => {
    expect(publishedPackageDirs.length).toBeGreaterThan(0);
    expect(publishedPackageDirs).toContain("src/published-packs/example");
  });

  test("each has a packable manifest: its name, the licence, the repository and its directory, node as its engine, an ES module, its prepack, the bounded field and keyword, and bounded as a peer at ~<major>.<minor>.0 of the workspace's bounded", () => {
    const [major, minor] = manifestOf("src").version.split(".");
    for (const { dir, manifest } of everyPackage()) {
      const name = dir.split("/").at(-1) ?? "";
      expect({ dir, name: manifest.name }).toEqual({ dir, name: `bounded-${name}` });
      expect({ dir, license: manifest.license }).toEqual({ dir, license: "MIT" });
      expect({ dir, repository: manifest.repository }).toEqual({ dir, repository: { type: "git", url: "git+https://github.com/bounded-dev/bounded.git", directory: dir } });
      expect({ dir, engines: manifest.engines }).toEqual({ dir, engines: { node: ">=22.18" } });
      expect({ dir, type: manifest.type }).toEqual({ dir, type: "module" });
      expect({ dir, prepack: manifest.scripts?.prepack }).toEqual({ dir, prepack: "bun ../../build-published-pack.ts && node ../../dist/cli.js catalog build" });
      expect({ dir, keyword: manifest.keywords?.includes("bounded-pack") }).toEqual({ dir, keyword: true });
      expect({ dir, catalogueFile: manifest.files?.includes("bounded.catalog.json") }).toEqual({ dir, catalogueFile: true });
      expect({ dir, catalogue: manifest.bounded?.catalog }).toEqual({ dir, catalogue: "./bounded.catalog.json" });
      const packs = Object.entries(manifest.bounded?.packs ?? {});
      expect({ dir, packs: packs.length > 0 }).toEqual({ dir, packs: true });
      for (const [exportPath, packDir] of packs) {
        expect({ dir, exportPath, exported: Object.keys(manifest.exports ?? {}).includes(exportPath) }).toEqual({ dir, exportPath, exported: true });
        expect({ dir, packDir, underPacks: /^packs\/[a-z0-9]+(-[a-z0-9]+)*$/.test(packDir) }).toEqual({ dir, packDir, underPacks: true });
      }
      expect({ dir, peer: manifest.peerDependencies?.bounded }).toEqual({ dir, peer: `~${major}.${minor}.0` });
      expect({ dir, dependency: manifest.dependencies?.bounded }).toEqual({ dir, dependency: undefined });
    }
  });

  test("build-published-pack refuses, naming the package, a built import that is not node's, bounded's, the package's own or its dependency's, and refuses to run before bounded's declarations are built", () => {
    expect(unknownPublishedPackImport("dist/packs/a/index.js", "picomatch", "bounded-x", [])).toBe(
      "dist/packs/a/index.js imports picomatch, which is neither node's, bounded's, bounded-x's nor one of bounded-x's dependencies: add it to bounded-x's dependencies",
    );
    for (const spec of ["node:fs", "bounded", "bounded/domain", "bounded-x", "bounded-x/other", "picomatch", "picomatch/posix"]) {
      expect({ spec, problem: unknownPublishedPackImport("dist/packs/a/index.js", spec, "bounded-x", ["picomatch"]) }).toEqual({ spec, problem: undefined });
    }
    expect(unknownPublishedPackImport("dist/packs/a/index.js", "bounded-xy", "bounded-x", [])).toBeDefined();
    expect(missingBoundedDeclarations(mkdtempSync(join(tmpdir(), "bounded-no-declarations-")))).toBe(
      "bounded's declarations are not built (src/dist/types is missing): build bounded first with bun src/build-dist.ts",
    );
    expect(missingBoundedDeclarations(CORE)).toBeUndefined();
  });

  test("the example is a fixture: private, so it is never published", () => {
    expect(example().manifest.name).toBe("bounded-example");
    expect(example().manifest.private).toBe(true);
  });

  test("every export runs from dist/ under node, with declarations, and its TypeScript source for bun, bun first", () => {
    for (const { dir, manifest } of everyPackage()) {
      const exports = Object.entries(manifest.exports ?? {});
      expect({ dir, exports: exports.length > 0 }).toEqual({ dir, exports: true });
      for (const [path, target] of exports) {
        const conditions = typeof target === "object" ? target : {};
        expect({ dir, path, keys: Object.keys(conditions) }).toEqual({ dir, path, keys: ["bun", "types", "default"] });
        expect({ dir, path, built: (conditions.default ?? "").startsWith("./dist/") }).toEqual({ dir, path, built: true });
        expect({ dir, path, types: conditions.types }).toEqual({ dir, path, types: (conditions.bun ?? "").replace(/^\.\//, "./dist/types/").replace(/\.ts$/, ".d.ts") });
      }
    }
  });

  test("its tarball holds package.json, README.md, LICENSE, bounded.catalog.json, dist/ and its packs' sources and examples, without tests, test support, fixtures or test/", () => {
    for (const { dir, manifest, files } of everyPackage()) {
      expect({ dir, topLevel: [...new Set(files.map((file) => file.split("/")[0] ?? ""))].sort() }).toEqual({ dir, topLevel: ["LICENSE", "README.md", "bounded.catalog.json", "dist", "package.json", "packs"] });
      for (const target of Object.values(manifest.exports ?? {}).flatMap((given) => (typeof given === "string" ? [given] : Object.values(given)))) {
        expect({ dir, target, packed: files.includes(target.replace(/^\.\//, "")) }).toEqual({ dir, target, packed: true });
      }
      expect({ dir, tests: files.filter((file) => file.endsWith(".test.ts") || file.endsWith(".test-support.ts") || file.split("/").includes("fixtures") || file.startsWith("test/")) }).toEqual({ dir, tests: [] });
      // Two patterns: bun's Glob matches no brace alternative holding a '/'.
      const sources = ["packs/*/README.md", "packs/*/examples/*.config.ts", "packs/*/examples/*.scenarios.ts"].flatMap((pattern) => [...new Glob(pattern).scanSync({ cwd: join(ROOT, dir) })]).sort();
      expect({ dir, sources: sources.length > 0 }).toEqual({ dir, sources: true });
      for (const source of sources) expect({ dir, source, packed: files.includes(source) }).toEqual({ dir, source, packed: true });
    }
  });

  test("packed, its manifest keeps bounded as a peer only, with no workspace: left", () => {
    for (const { dir, tarball } of everyPackage()) {
      const text = Bun.spawnSync(["tar", "-xzOf", tarball, "package/package.json"]).stdout.toString();
      const inTarball = JSON.parse(text) as Manifest;
      expect({ dir, peer: inTarball.peerDependencies?.bounded !== undefined }).toEqual({ dir, peer: true });
      expect({ dir, dependency: inTarball.dependencies?.bounded }).toEqual({ dir, dependency: undefined });
      expect({ dir, workspace: text.includes("workspace:") }).toEqual({ dir, workspace: false });
    }
  });

  test("dist/ imports only node's modules, bounded's export paths, its own package's export paths and its dependencies", () => {
    for (const { dir, manifest } of everyPackage()) {
      const dependencies = Object.keys(manifest.dependencies ?? {});
      const scripts = filesUnder(join(ROOT, dir, "dist")).filter((file) => file.endsWith(".js"));
      expect({ dir, scripts: scripts.length > 0 }).toEqual({ dir, scripts: true });
      for (const file of scripts) {
        const text = readFileSync(file, "utf8");
        expect({ file, bun: /\bBun\.|from "bun"|from "bun:/.test(text) }).toEqual({ file, bun: false });
        for (const spec of importsIn(text).filter((found) => !found.startsWith("."))) {
          const allowed =
            spec.startsWith("node:") || spec === "bounded" || spec.startsWith("bounded/") || spec === manifest.name || spec.startsWith(`${manifest.name}/`) || dependencies.some((name) => spec === name || spec.startsWith(`${name}/`));
          expect({ file, spec, allowed }).toEqual({ file, spec, allowed: true });
        }
      }
    }
  });

  test("its catalogue lists each of its packs, rooted at its package", () => {
    const { tarball } = example();
    const catalogue = JSON.parse(Bun.spawnSync(["tar", "-xzOf", tarball, "package/bounded.catalog.json"]).stdout.toString()) as {
      catalogVersion?: number;
      package?: { name?: string };
      packs?: { id?: string; importPath?: string; exportName?: string; examples?: { path?: string; scenarios?: unknown }[] }[];
    };
    expect(catalogue.catalogVersion).toBe(1);
    expect(catalogue.package?.name).toBe("bounded-example");
    expect((catalogue.packs ?? []).map(({ id, importPath, exportName }) => ({ id, importPath, exportName }))).toEqual([{ id: "bounded-example/refused-tools", importPath: "bounded-example", exportName: "refusedToolsPack" }]);
    const examples = (catalogue.packs ?? []).flatMap((pack) => pack.examples ?? []);
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) expect({ path: example.path, scenarios: Array.isArray(example.scenarios) && example.scenarios.length > 0 }).toEqual({ path: example.path, scenarios: true });
  });

  test("installed beside bounded, under node, a project selecting the published pack judges with it", () => {
    const project = projectWithExample();
    writeFileSync(join(project, "bounded.config.ts"), CONFIG);
    const judged = judgedUnderNode(project);
    expect(judged.problem).toBeNull();
    expect(judged.listed.kind).toBe("refuse");
    expect(judged.listed.redirect).toBe("Read docs/ instead");
    expect(judged.unlisted.kind).toBe("allow");
  }, 60_000);

  test("a second copy of bounded under the published pack is refused, never used: the selection names the pack built by a different copy and every event is refused", () => {
    const project = projectWithExample();
    writeFileSync(join(project, "bounded.config.ts"), CONFIG);
    const nested = join(project, "node_modules", "bounded-example", "node_modules");
    mkdirSync(join(nested, "bounded"), { recursive: true });
    cpSync(join(CORE, "dist"), join(nested, "bounded", "dist"), { recursive: true });
    cpSync(join(CORE, "package.json"), join(nested, "bounded", "package.json"));
    for (const dependency of ["zod", "picomatch", "@vscode"]) symlinkSync(join(ROOT, "node_modules", dependency), join(nested, dependency));
    const judged = judgedUnderNode(project);
    expect(String(judged.problem)).toContain("was built by a different copy of bounded");
    expect(judged.listed.kind).toBe("refuse");
    expect(judged.unlisted.kind).toBe("refuse");
  }, 60_000);

  test("a consumer's tsc compiles a configuration selecting the published pack against the packed declarations, and rejects a contribution to its point when the pack is not listed", () => {
    const project = projectWithExample();
    const imports = 'import { contribution, corePack, defineConfig } from "bounded/domain";\nimport { refusedToolsPack } from "bounded-example";\n';
    const rule = '[{ tool: "web", redirect: "Read docs/ instead" }]';
    writeFileSync(join(project, "accepted.ts"), `${imports}export default defineConfig({ packs: [corePack, refusedToolsPack], contributes: [contribution(refusedToolsPack.points.refusedTools, ${rule})] });\n`);
    writeFileSync(join(project, "rejected.ts"), `${imports}export default defineConfig({ packs: [corePack], contributes: [contribution(refusedToolsPack.points.refusedTools, ${rule})] });\n`);
    const tsc = (files: string[], options: Record<string, unknown>) => {
      writeFileSync(join(project, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: true, noEmit: true, target: "es2022", ...options }, files }));
      return Bun.spawnSync([join(ROOT, "node_modules", ".bin", "tsc"), "-p", "."], { cwd: project, stdout: "pipe", stderr: "pipe" });
    };
    const resolutions = [{ module: "preserve", moduleResolution: "bundler" }, { module: "nodenext", moduleResolution: "nodenext" }];
    for (const resolution of [...resolutions, ...resolutions.map((options) => ({ ...options, skipLibCheck: false }))]) {
      const accepted = tsc(["accepted.ts"], resolution);
      expect({ resolution, output: accepted.stdout.toString() }).toEqual({ resolution, output: "" });
      expect({ resolution, exit: accepted.exitCode }).toEqual({ resolution, exit: 0 });
      const rejected = tsc(["rejected.ts"], resolution);
      expect({ resolution, failed: rejected.exitCode !== 0 }).toEqual({ resolution, failed: true });
      const errors = rejected.stdout
        .toString()
        .split("\n")
        .filter((line) => /error TS/.test(line));
      expect({ resolution, errors: errors.length > 0 }).toEqual({ resolution, errors: true });
      expect({ resolution, inFile: errors.every((line) => line.startsWith("rejected.ts(")) }).toEqual({ resolution, inFile: true });
      expect({ resolution, assignable: rejected.stdout.toString().includes("is not assignable to type") }).toEqual({ resolution, assignable: true });
    }
  }, 120_000);
});
