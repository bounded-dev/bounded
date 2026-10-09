// The one published package, `bounded`, whose directory is src/ (ADR 2026-024).
// Its prepack (src/build-dist.ts) compiles the library entry points, the CLI
// and the host adapters (src/cli, src/hosts/claude-code, src/hosts/pi, private
// apps in source) to JavaScript for Node in
// dist/, so nothing needs bun at run time. The tarball ships dist/ and the
// core's and the packs' TypeScript sources (for types and for bun), without tests, test support
// (but the exported conformance suite) or fixtures.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRIVATE_PACKAGE_EXPORTS, unknownDistImport } from "../build-dist.ts";

const ROOT = join(import.meta.dir, "..", "..");
const CORE = join(ROOT, "src");
const VERSION = "3.3.0";
const CONFORMANCE = "core/application/project-setup/init-project/init-project.host-installer.test-support.ts";
/** The conformance suites bounded publishes for other packages' tests (bounded/testing/*): the only test support in its tarball. */
const PUBLISHED_TEST_SUPPORT = [CONFORMANCE, "core/application/bounded-log/judge-event/judge-event.shell-command-reader.test-support.ts"];
/** The private apps bounded's dist carries. */
const APPS = ["src/cli", "src/hosts/claude-code", "src/hosts/pi"];
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

/** The modules a built file imports: its import and export statements' (over several lines too) and dynamic imports' specifiers. */
const importsIn = (text: string): string[] =>
  [...text.matchAll(/^(?:import|export)\b[^";]*?\bfrom\s*"([^"]+)"/gm), ...text.matchAll(/^import\s*"([^"]+)"/gm), ...text.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g)].map(([, spec = ""]) => spec);

/** Every file under dist/, as built by the prepack. */
function distFiles(dir = join(CORE, "dist")): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? distFiles(join(dir, entry.name)) : [join(dir, entry.name)]));
}

describe("bounded, the one published package", () => {
  test("the root workspace and the apps stay private, at the lockstep version, and depend on no app", () => {
    expect(manifestOf(".").private).toBe(true);
    const appNames = APPS.map((dir) => manifestOf(dir).name);
    // The private context bounded's dist carries (ADR 2026-020) moves in lockstep with them.
    for (const dir of [...APPS, "src/lib/shell-command-reader"]) {
      const app = manifestOf(dir);
      expect(app.private).toBe(true);
      expect(app.version).toBe(VERSION);
      expect(Object.keys(app.dependencies ?? {}).filter((name) => appNames.includes(name))).toEqual([]);
    }
  });

  test("has a publishable manifest: not private, the version, the repository's licence and directory, a description, node as its engine, and its prepack build", () => {
    const manifest = manifestOf("src");
    expect(manifest.name).toBe("bounded");
    expect(manifest.private).toBeUndefined();
    expect(manifest.version).toBe(VERSION);
    expect(readFileSync(join(ROOT, "LICENSE"), "utf8")).toStartWith("MIT License");
    expect(manifest.license).toBe("MIT");
    expect(manifest.repository).toEqual({ type: "git", url: "git+https://github.com/bounded-dev/bounded.git", directory: "src" });
    expect((manifest.description ?? "").length).toBeGreaterThan(10);
    expect(manifest.engines).toEqual({ node: ">=22.18" });
    expect(manifest.files).toEqual(expect.arrayContaining(["dist", "core", "packs"]));
    expect(manifest.bin).toEqual({ bounded: "dist/cli.js" });
    expect(manifest.scripts?.prepack).toBe("bun build-dist.ts");
  });

  test("every library export runs from dist/ under node, with declarations for types and its TypeScript source for bun, bun first", () => {
    const exports = manifestOf("src").exports ?? {};
    for (const [path, target] of Object.entries(exports)) {
      if (path.startsWith("./testing/")) {
        // A bun:test module: it runs only under bun's test runner, so it has no node build.
        expect(typeof target === "object" && Object.keys(target).sort()).toEqual(["bun", "types"]);
        expect(typeof target === "object" && target.types).toBe(typeof target === "object" ? target.bun : "");
        expect(PUBLISHED_TEST_SUPPORT).toContain(typeof target === "object" ? (target.bun ?? "").replace(/^\.\//, "") : "");
        continue;
      }
      if (path === "./shell-command-reader") {
        // Built only into dist/, from the private context bounded-shell-command-reader: there is no source of it in bounded for bun.
        expect(target).toEqual({ types: "./dist/types/shell-command-reader/index.d.ts", default: "./dist/shell-command-reader/index.js" });
        continue;
      }
      if (path.startsWith("./hosts/")) {
        expect(typeof target).toBe("string");
        expect(String(target)).toStartWith("./dist/hosts/");
        continue;
      }
      expect(typeof target === "object" && target.default).toStartWith("./dist/");
      // The workspace's tsc and bun resolve "bun" (tsconfig customConditions), a consumer's tsc "types": bun comes first.
      expect(typeof target === "object" && Object.keys(target)).toEqual(["bun", "types", "default"]);
      // Its TypeScript source is the core's or a shipped pack's (ADR 2026-024).
      expect(typeof target === "object" && /^\.\/(?:core|packs)\//.test(target.bun ?? "")).toBe(true);
      expect(typeof target === "object" && target.types).toBe(typeof target === "object" ? (target.bun ?? "").replace(/^\.\//, "./dist/types/").replace(/\.ts$/, ".d.ts") : "");
    }
    expect(Object.keys(exports).filter((path) => path.startsWith("./hosts/"))).toEqual(["./hosts/claude-code/host-installer", "./hosts/pi", "./hosts/pi/host-installer"]);
  });

  test("its tarball holds every export target, the bin, the Claude Code hook and the licence, without tests, test support or fixtures", () => {
    expect(packed).toContain("package.json");
    expect(packed).toContain("LICENSE");
    expect(packed).toContain(CONFORMANCE);
    for (const target of [...Object.values(manifestOf("src").exports ?? {}).flatMap(targetsOf), ...RUN_BY_PATH]) expect(packed).toContain(target);
    expect(packed.filter((file) => file.endsWith(".test.ts"))).toEqual([]);
    expect(packed.filter((file) => file.endsWith(".test-support.ts")).sort()).toEqual([...PUBLISHED_TEST_SUPPORT].sort());
    expect(packed.filter((file) => file.split("/").includes("fixtures") || file.startsWith("test/") || file.startsWith("core/test/"))).toEqual([]);
  });

  test("its tarball holds dist/, the core's and the packs' sources, README.md, LICENSE and package.json: nothing of the hosts', the cli's or the libraries' sources, nor the repository's tests", () => {
    const topLevel = [...new Set(packed.map((file) => file.split("/")[0] ?? ""))].sort();
    expect(topLevel).toEqual(["LICENSE", "README.md", "core", "dist", "package.json", "packs"]);
  });

  test("dist/ imports only node's modules, bounded's own export paths and bounded's dependencies, so it resolves from an installed bounded", () => {
    const allowed = new Set(Object.keys(manifestOf("src").dependencies ?? {}));
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
    const loaded = Bun.spawnSync(["node", "--input-type=module", "-e", 'const d = await import("bounded/domain"); const g = await import("bounded/protected-paths"); console.log(typeof d.defineConfig, g.protectedPathsPack.id.value)'], { cwd: CORE, stdout: "pipe", stderr: "pipe" });
    expect(loaded.stderr.toString()).toBe("");
    expect(loaded.stdout.toString().trim()).toBe("function bounded/protected-paths");
  });

  test("the built Claude Code hook keeps its crash-safe bootstrap: nothing is imported before its try, so a missing module is a deny", () => {
    const hook = readFileSync(join(CORE, "dist/hosts/claude-code/hook.js"), "utf8");
    const beforeTry = hook.slice(0, hook.search(/^try \{/m));
    expect(hook.search(/^try \{/m)).toBeGreaterThan(0);
    // Every top-level static import, before the try or after it, is the bundler's own helper chunk, relative, importing nothing but node's built-ins:
    // no package that could be missing is loaded outside the try.
    const specsOf = (text: string): string[] => [...text.matchAll(/^(?:import|export)\b[^";]*?\bfrom\s*"([^"]+)"/gm), ...text.matchAll(/^import\s*"([^"]+)"/gm)].map(([, spec = ""]) => spec);
    expect(specsOf(beforeTry)).toEqual(specsOf(hook));
    const early = specsOf(hook);
    expect(early.filter((spec) => !spec.startsWith("./"))).toEqual([]);
    for (const chunk of early) expect(specsOf(readFileSync(join(CORE, "dist/hosts/claude-code", chunk), "utf8")).filter((spec) => !spec.startsWith("node:"))).toEqual([]);
    expect(hook).toMatch(/await import\(|import\("/);
  });

  test("ships a README saying what Bounded is, how to start, and a protected-paths rule, linking to the repository's docs", () => {
    expect(manifestOf("src").files).toContain("README.md");
    expect(packed).toContain("README.md");
    const readme = readFileSync(join(CORE, "README.md"), "utf8");
    expect(readme).toContain("npx bounded init");
    expect(readme).toContain("protectedPathsPack.points.protectedPaths");
    expect(readme).toContain("https://github.com/bounded-dev/bounded");
  });

  test("its README says the adapter export paths are internal: they serve the hosts bounded carries, not a project's configuration", () => {
    const exports = Object.keys(manifestOf("src").exports ?? {});
    expect(exports.filter((path) => path.includes("adapters"))).toEqual(["./adapters", "./prereqs/adapters", "./protected-paths/adapters"]);
    const readme = readFileSync(join(CORE, "README.md"), "utf8");
    const internal = readme.split("\n\n").find((paragraph) => paragraph.includes("`bounded/adapters`") && paragraph.includes("`bounded/protected-paths/adapters`") && paragraph.includes("`bounded/prereqs/adapters`"));
    expect(internal).toBeDefined();
    expect(internal ?? "").toContain("internal");
  });

  test("a consumer's tsc (strict, skipLibCheck, bundler and nodenext, no allowImportingTsExtensions) compiles a configuration against the packed tarball's declarations, and still rejects a contribution to an unselected pack's point", () => {
    const consumer = mkdtempSync(join(tmpdir(), "bounded-consumer-"));
    const into = join(consumer, "release");
    expect(Bun.spawnSync(["bun", "pm", "pack", "--destination", into, "--quiet"], { cwd: CORE }).exitCode).toBe(0);
    mkdirSync(join(consumer, "node_modules", "bounded"), { recursive: true });
    expect(Bun.spawnSync(["tar", "-xzf", join(into, `bounded-${VERSION}.tgz`), "-C", join(consumer, "node_modules", "bounded"), "--strip-components=1"]).exitCode).toBe(0);
    for (const dependency of ["zod", "picomatch", "@vscode"]) symlinkSync(join(ROOT, "node_modules", dependency), join(consumer, "node_modules", dependency));
    // A configuration as a project writes it, and the strict-typing rule (AGENTS.md): a contribution to a point of a pack the project does not select must not compile.
    const imports = 'import { contribution, corePack, defineConfig } from "bounded/domain";\nimport { protectedPathsPack } from "bounded/protected-paths";\n';
    const rule = '[{ match: "secrets/**", deny: ["read"], redirect: "Ask" }]';
    writeFileSync(join(consumer, "accepted.ts"), `${imports}export default defineConfig({ packs: [corePack, protectedPathsPack], contributes: [contribution(protectedPathsPack.points.protectedPaths, ${rule})] });\n`);
    writeFileSync(join(consumer, "rejected.ts"), `${imports}export default defineConfig({ packs: [corePack], contributes: [contribution(protectedPathsPack.points.protectedPaths, ${rule})] });\n`);
    // Other compile-time rules survive too: a rule value of the wrong type (no deny) is refused.
    writeFileSync(join(consumer, "wrong-value.ts"), `${imports}export default defineConfig({ packs: [corePack, protectedPathsPack], contributes: [contribution(protectedPathsPack.points.protectedPaths, [{ match: "secrets/**", redirect: "Ask" }])] });\n`);
    // A configuration that lists only the protected-paths pack, which brings in the core; the project still contributes only to points of packs it lists.
    writeFileSync(join(consumer, "brought-in-accepted.ts"), `${imports}const config = defineConfig({ packs: [protectedPathsPack], contributes: [contribution(protectedPathsPack.points.protectedPaths, ${rule})] });\nexport const listed = config.listedPacks;\nexport default config;\n`);
    writeFileSync(join(consumer, "brought-in-rejected.ts"), `${imports}export default defineConfig({ packs: [protectedPathsPack], contributes: [contribution(corePack.points.effectGuards.write, [])] });\n`);
    // A third-party host opening a project with the reader bounded publishes, its declarations reaching the core's port.
    writeFileSync(
      join(consumer, "host-accepted.ts"),
      'import { openProject } from "bounded/open-project";\nimport { protectedPathsPortProvisions } from "bounded/protected-paths/adapters";\nimport { TreeSitterShellCommandReader } from "bounded/shell-command-reader";\nexport const judge = openProject("/p", { ports: protectedPathsPortProvisions(), shellCommandReader: new TreeSitterShellCommandReader() });\n',
    );
    writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "consumer", type: "module" }));
    /** The consumer's tsc over `files`, with a typical strict tsconfig and `options`. */
    const tsc = (files: string[], options: Record<string, unknown>) => {
      writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: true, noEmit: true, target: "es2022", ...options }, files }));
      return Bun.spawnSync([join(ROOT, "node_modules", ".bin", "tsc"), "-p", "."], { cwd: consumer, stdout: "pipe", stderr: "pipe" });
    };
    const resolutions = [{ module: "preserve", moduleResolution: "bundler" }, { module: "nodenext", moduleResolution: "nodenext" }];
    // With skipLibCheck off too: the declarations themselves check cleanly.
    for (const resolution of [...resolutions, ...resolutions.map((options) => ({ ...options, skipLibCheck: false }))]) {
      const accepted = tsc(["accepted.ts"], resolution);
      expect(accepted.stdout.toString()).toBe("");
      expect(accepted.exitCode).toBe(0);
      const rejected = tsc(["rejected.ts"], resolution);
      expect(rejected.exitCode).not.toBe(0);
      const errors = rejected.stdout.toString().split("\n").filter((line) => /error TS/.test(line));
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.every((line) => line.startsWith("rejected.ts("))).toBe(true);
      expect(rejected.stdout.toString()).toContain("is not assignable to type");
      const wrongValue = tsc(["wrong-value.ts"], resolution);
      expect(wrongValue.exitCode).not.toBe(0);
      const wrongErrors = wrongValue.stdout.toString().split("\n").filter((line) => /error TS/.test(line));
      expect(wrongErrors.length).toBeGreaterThan(0);
      expect(wrongErrors.every((line) => line.startsWith("wrong-value.ts("))).toBe(true);
      expect(wrongValue.stdout.toString()).toContain("deny");
      const hostAccepted = tsc(["host-accepted.ts"], resolution);
      expect(hostAccepted.stdout.toString()).toBe("");
      expect(hostAccepted.exitCode).toBe(0);
      const broughtInAccepted = tsc(["brought-in-accepted.ts"], resolution);
      expect(broughtInAccepted.stdout.toString()).toBe("");
      expect(broughtInAccepted.exitCode).toBe(0);
      const broughtInRejected = tsc(["brought-in-rejected.ts"], resolution);
      expect(broughtInRejected.exitCode).not.toBe(0);
      const broughtInErrors = broughtInRejected.stdout.toString().split("\n").filter((line) => /error TS/.test(line));
      expect(broughtInErrors.length).toBeGreaterThan(0);
      expect(broughtInErrors.every((line) => line.startsWith("brought-in-rejected.ts("))).toBe(true);
      expect(broughtInRejected.stdout.toString()).toContain("is not assignable to type");
    }
  }, 120_000);

  test("bounded/shell-command-reader is built into dist from the private context, with declarations, and imports only bounded and its dependencies", () => {
    for (const file of ["dist/shell-command-reader/index.js", "dist/types/shell-command-reader/index.d.ts"]) expect(packed).toContain(file);
    const specs = importsIn(readFileSync(join(CORE, "dist/shell-command-reader/index.js"), "utf8")).filter((spec) => !spec.startsWith("."));
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) expect([spec, spec === "bounded/domain" || spec === "bounded/application" || spec.startsWith("@vscode/tree-sitter-wasm") || spec.startsWith("node:")]).toEqual([spec, true]);
    const declarations = readFileSync(join(CORE, "dist/types/shell-command-reader/index.d.ts"), "utf8");
    expect(declarations).toContain("TreeSitterShellCommandReader");
    const loaded = Bun.spawnSync(["node", "--input-type=module", "-e", 'const r = await import("bounded/shell-command-reader"); console.log(typeof r.TreeSitterShellCommandReader)'], { cwd: CORE, stdout: "pipe", stderr: "pipe" });
    expect(loaded.stderr.toString()).toBe("");
    expect(loaded.stdout.toString().trim()).toBe("function");
  });

  test("the built hosts reach the shell command reader through bounded/shell-command-reader: dist/hosts/claude-code and dist/hosts/pi import it, and no dist file imports bounded-shell-command-reader", () => {
    const files = distFiles().filter((file) => file.endsWith(".js"));
    const importing = (dir: string, spec: string) => files.filter((file) => file.startsWith(join(CORE, dir)) && importsIn(readFileSync(file, "utf8")).includes(spec));
    expect(importing("dist/hosts/claude-code", "bounded/shell-command-reader").length).toBeGreaterThan(0);
    expect(importing("dist/hosts/pi", "bounded/shell-command-reader").length).toBeGreaterThan(0);
    expect(files.filter((file) => importsIn(readFileSync(file, "utf8")).some((spec) => spec.startsWith("bounded-shell-command-reader")))).toEqual([]);
    // One copy of the reader in dist: its translation of commands is not inlined into the hosts.
    expect(files.filter((file) => readFileSync(file, "utf8").includes("function describeShellCommand")).map((file) => file.slice(CORE.length + 1))).toEqual(["dist/shell-command-reader/index.js"]);
  });

  test("build-dist rewrites only the shell command reader's package to its export", () => {
    expect(PRIVATE_PACKAGE_EXPORTS).toEqual({ "bounded-shell-command-reader/adapters": "bounded/shell-command-reader" });
    const dependencies = Object.keys(manifestOf("src").dependencies ?? {});
    expect(unknownDistImport("dist/hosts/pi/index.js", "bounded-shell-command-reader/adapters", dependencies)).toBe(
      "dist/hosts/pi/index.js imports bounded-shell-command-reader/adapters, which is neither node's, bounded's nor one of bounded's dependencies: add it to bounded's dependencies",
    );
    expect(unknownDistImport("dist/hosts/pi/index.js", "bounded/shell-command-reader", dependencies)).toBeUndefined();
    expect(unknownDistImport("dist/shell-command-reader/index.js", "@vscode/tree-sitter-wasm", dependencies)).toBeUndefined();
  });

  test("under Node, the built library parses an execute effect with a reading", () => {
    const script = 'const { Effect } = await import("bounded/domain"); const parsed = Effect.parse({ kind: "execute", command: "ls", reading: { outcome: "read", programs: [{ name: { kind: "literal", text: "ls" }, arguments: [], workingDirectory: "." }], fileEffects: [{ effect: { kind: "list", root: "." } }], unresolved: [] } }); console.log(parsed.ok && parsed.value.reading.outcome)';
    const ran = Bun.spawnSync(["node", "--input-type=module", "-e", script], { cwd: CORE, stdout: "pipe", stderr: "pipe" });
    expect(ran.stderr.toString()).toBe("");
    expect(ran.stdout.toString().trim()).toBe("read");
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
