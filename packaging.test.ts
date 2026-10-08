// The one published package, `bounded`. Its prepack (contexts/core/build-dist.ts)
// compiles the library entry points, the CLI and the host adapters (apps/cli,
// apps/claude-code, apps/pi, private apps in source) to JavaScript for Node in
// dist/, so nothing needs bun at run time. The tarball ships dist/ and the
// TypeScript sources (for types and for bun), without tests, test support
// (but the exported conformance suite) or fixtures.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = import.meta.dir;
const CORE = join(ROOT, "contexts/core");
const VERSION = "3.0.0";
const CONFORMANCE = "src/application/project-setup/init-project/init-project.host-installer.test-support.ts";
/** What the hooks and the pi loader run, beside every export target: the Claude Code hook is run by path, not imported. */
const RUN_BY_PATH = ["dist/cli.js", "dist/hosts/claude-code/hook.js"];

type Target = string | Record<string, string>;
interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  license?: string;
  description?: string;
  repository?: { type?: string; url?: string; directory?: string };
  files?: string[];
  engines?: Record<string, string>;
  exports?: Record<string, Target>;
  bin?: Record<string, string>;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
}

const manifestOf = (dir: string): Manifest => JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8")) as Manifest;
const targetsOf = (target: Target): string[] => (typeof target === "string" ? [target] : Object.values(target)).map((path) => path.replace(/^\.\//, ""));

/** The files `bun pm pack --dry-run` would put in bounded's tarball; it runs the prepack, building dist/. */
function packedFiles(): string[] {
  const ran = Bun.spawnSync(["bun", "pm", "pack", "--dry-run"], { cwd: CORE, stdout: "pipe", stderr: "pipe" });
  if (ran.exitCode !== 0) throw new Error(ran.stderr.toString());
  return ran.stdout
    .toString()
    .split("\n")
    .flatMap((line) => /^packed \S+ (.+)$/.exec(line.trim())?.[1] ?? [])
    .sort();
}
const packed = packedFiles();

/** Every file under dist/, as built by the prepack. */
function distFiles(dir = join(CORE, "dist")): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? distFiles(join(dir, entry.name)) : [join(dir, entry.name)]));
}

describe("bounded, the one published package", () => {
  test("the root workspace and the apps stay private, at the lockstep version, and depend on no app", () => {
    expect(manifestOf(".").private).toBe(true);
    for (const dir of ["apps/cli", "apps/claude-code", "apps/pi"]) {
      const app = manifestOf(dir);
      expect(app.private).toBe(true);
      expect(app.version).toBe(VERSION);
      expect(Object.keys(app.dependencies ?? {}).filter((name) => name.startsWith("bounded-"))).toEqual([]);
    }
  });

  test("has a publishable manifest: not private, the version, the repository's licence and directory, a description, node as its engine, and its prepack build", () => {
    const manifest = manifestOf("contexts/core");
    expect(manifest.name).toBe("bounded");
    expect(manifest.private).toBeUndefined();
    expect(manifest.version).toBe(VERSION);
    expect(readFileSync(join(ROOT, "LICENSE"), "utf8")).toStartWith("MIT License");
    expect(manifest.license).toBe("MIT");
    expect(manifest.repository).toEqual({ type: "git", url: "git+https://github.com/bounded-dev/the-bounded-harness.git", directory: "contexts/core" });
    expect((manifest.description ?? "").length).toBeGreaterThan(10);
    expect(manifest.engines).toEqual({ node: ">=22.18" });
    expect(manifest.files).toEqual(expect.arrayContaining(["dist", "src"]));
    expect(manifest.bin).toEqual({ bounded: "dist/cli.js" });
    expect(manifest.scripts?.prepack).toBe("bun build-dist.ts");
  });

  test("every library export runs from dist/ under node, with its TypeScript source for types and for bun", () => {
    const exports = manifestOf("contexts/core").exports ?? {};
    for (const [path, target] of Object.entries(exports)) {
      if (path === "./testing/host-installer-conformance") {
        // A bun:test module: it runs only under bun's test runner, so it has no node build.
        expect(target).toEqual({ types: `./${CONFORMANCE}`, bun: `./${CONFORMANCE}` });
        continue;
      }
      if (path.startsWith("./hosts/")) {
        expect(typeof target).toBe("string");
        expect(String(target)).toStartWith("./dist/hosts/");
        continue;
      }
      expect(typeof target === "object" && target.default).toStartWith("./dist/");
      expect(typeof target === "object" && target.types).toStartWith("./src/");
      expect(typeof target === "object" && target.bun).toBe(typeof target === "object" ? target.types : "");
    }
    expect(Object.keys(exports).filter((path) => path.startsWith("./hosts/"))).toEqual(["./hosts/claude-code/host-installer", "./hosts/pi", "./hosts/pi/host-installer"]);
  });

  test("its tarball holds every export target, the bin, the Claude Code hook and the licence, without tests, test support or fixtures", () => {
    expect(packed).toContain("package.json");
    expect(packed).toContain("LICENSE");
    expect(packed).toContain(CONFORMANCE);
    for (const target of [...Object.values(manifestOf("contexts/core").exports ?? {}).flatMap(targetsOf), ...RUN_BY_PATH]) expect(packed).toContain(target);
    expect(packed.filter((file) => file.endsWith(".test.ts"))).toEqual([]);
    expect(packed.filter((file) => file.endsWith(".test-support.ts") && file !== CONFORMANCE)).toEqual([]);
    expect(packed.filter((file) => file.split("/").includes("fixtures") || file.startsWith("test/"))).toEqual([]);
  });

  test("dist/ imports only node's modules, bounded's own export paths and bounded's dependencies, so it resolves from an installed bounded", () => {
    const allowed = new Set(Object.keys(manifestOf("contexts/core").dependencies ?? {}));
    const files = distFiles().filter((file) => file.endsWith(".js"));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toMatch(/\bBun\.|from "bun"|from "bun:/);
      // Import and export statements (over several lines too) and dynamic imports; not a string that merely ends in "from".
      const statements = [...text.matchAll(/^(?:import|export)\b[^";]*?\bfrom\s*"([^"]+)"/gm), ...text.matchAll(/^import\s*"([^"]+)"/gm), ...text.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g)];
      for (const [, spec = ""] of statements.filter(([, found = ""]) => !found.startsWith("."))) {
        const external = spec.startsWith("node:") || spec === "bounded" || spec.startsWith("bounded/") || allowed.has(spec) || [...allowed].some((name) => spec.startsWith(`${name}/`));
        expect(`${file}: ${spec} ${external ? "allowed" : "not allowed"}`).toEndWith("allowed");
      }
    }
  });

  test("the bin and the Claude Code hook start with node, and the library loads under node from dist/", () => {
    for (const file of RUN_BY_PATH) expect(readFileSync(join(CORE, file), "utf8").startsWith("#!/usr/bin/env node")).toBe(true);
    const loaded = Bun.spawnSync(["node", "--input-type=module", "-e", 'const d = await import("bounded/domain"); const g = await import("bounded/path-gate"); console.log(typeof d.defineConfig, g.pathGate.id.value)'], { cwd: CORE, stdout: "pipe", stderr: "pipe" });
    expect(loaded.stderr.toString()).toBe("");
    expect(loaded.stdout.toString().trim()).toBe("function bounded/path-gate");
  });

  test("the built Claude Code hook keeps its crash-safe bootstrap: nothing is imported before its try, so a missing module is a deny", () => {
    const hook = readFileSync(join(CORE, "dist/hosts/claude-code/hook.js"), "utf8");
    const beforeTry = hook.slice(0, hook.search(/^try \{/m));
    expect(hook.search(/^try \{/m)).toBeGreaterThan(0);
    // Before the try, only the bundler's own helper chunks, relative, which import nothing but node's built-ins: no package that could be missing.
    const specsOf = (text: string): string[] => [...text.matchAll(/^(?:import|export)\b[^";]*?\bfrom\s*"([^"]+)"/gm), ...text.matchAll(/^import\s*"([^"]+)"/gm)].map(([, spec = ""]) => spec);
    const early = specsOf(beforeTry);
    expect(early.filter((spec) => !spec.startsWith("./"))).toEqual([]);
    for (const chunk of early) expect(specsOf(readFileSync(join(CORE, "dist/hosts/claude-code", chunk), "utf8")).filter((spec) => !spec.startsWith("node:"))).toEqual([]);
    expect(hook).toMatch(/await import\(|import\("/);
  });

  test("ships a README saying what Bounded is, how to start, and a path gate rule, linking to the repository's docs", () => {
    expect(manifestOf("contexts/core").files).toContain("README.md");
    expect(packed).toContain("README.md");
    const readme = readFileSync(join(CORE, "README.md"), "utf8");
    expect(readme).toContain("npx bounded init");
    expect(readme).toContain("pathGate.points.protectedPaths");
    expect(readme).toContain("https://github.com/bounded-dev/the-bounded-harness");
  });

  test("a consumer's tsc reads the shipped TypeScript sources with allowImportingTsExtensions, under bundler and nodenext resolution; without it they do not compile (no .d.ts yet)", () => {
    const consumer = mkdtempSync(join(tmpdir(), "bounded-consumer-"));
    const into = join(consumer, "release");
    expect(Bun.spawnSync(["bun", "pm", "pack", "--destination", into, "--quiet"], { cwd: CORE }).exitCode).toBe(0);
    mkdirSync(join(consumer, "node_modules", "bounded"), { recursive: true });
    expect(Bun.spawnSync(["tar", "-xzf", join(into, `bounded-${VERSION}.tgz`), "-C", join(consumer, "node_modules", "bounded"), "--strip-components=1"]).exitCode).toBe(0);
    for (const dependency of ["zod", "picomatch", "@vscode"]) symlinkSync(join(ROOT, "node_modules", dependency), join(consumer, "node_modules", dependency));
    writeFileSync(join(consumer, "a.ts"), 'import { corePack, defineConfig } from "bounded/domain";\nexport default defineConfig({ packs: [corePack] });\n');
    writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "consumer", type: "module" }));
    /** The consumer's tsc, with a typical strict tsconfig and `options`. */
    const tsc = (options: Record<string, unknown>) => {
      writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: true, noEmit: true, target: "es2022", ...options }, files: ["a.ts"] }));
      return Bun.spawnSync([join(ROOT, "node_modules", ".bin", "tsc"), "-p", "."], { cwd: consumer, stdout: "pipe", stderr: "pipe" });
    };
    for (const resolution of [{ module: "preserve", moduleResolution: "bundler" }, { module: "nodenext", moduleResolution: "nodenext" }]) {
      expect(tsc({ ...resolution, allowImportingTsExtensions: true }).exitCode).toBe(0);
      const without = tsc(resolution);
      expect(without.exitCode).not.toBe(0);
      expect(without.stdout.toString()).toContain("TS5097");
    }
  });

  test("packed, its manifest names the version, the bin and bounded's three runtime dependencies, with no workspace:* left", () => {
    const into = mkdtempSync(join(tmpdir(), "bounded-packaging-"));
    const ran = Bun.spawnSync(["bun", "pm", "pack", "--destination", into, "--quiet"], { cwd: CORE, stdout: "pipe", stderr: "pipe" });
    expect(ran.exitCode).toBe(0);
    const inTarball = JSON.parse(Bun.spawnSync(["tar", "-xzOf", join(into, `bounded-${VERSION}.tgz`), "package/package.json"]).stdout.toString()) as Manifest;
    expect(inTarball.version).toBe(VERSION);
    expect(inTarball.bin).toEqual({ bounded: "dist/cli.js" });
    expect(Object.keys(inTarball.dependencies ?? {}).sort()).toEqual(["@vscode/tree-sitter-wasm", "picomatch", "zod"]);
    expect(JSON.stringify(inTarball)).not.toContain("workspace:");
  });
});
