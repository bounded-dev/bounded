// The four published packages: each manifest is publishable, each tarball
// ships its sources but no tests, test support or fixtures (except the
// exported installer conformance suite), every export path and bin target
// is in it, and `workspace:*` becomes the released version.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = import.meta.dir;
/** The published packages. The CLI (apps/cli, bounded-cli) is not one: bounded's prepack bundles it as bounded's bin. */
const PACKAGES = [
  { name: "bounded", dir: "contexts/core" },
  { name: "bounded-claude-code", dir: "apps/claude-code" },
  { name: "bounded-pi", dir: "apps/pi" },
] as const;
const VERSION = "3.0.0";
const CONFORMANCE = "src/application/project-setup/init-project/init-project.host-installer.test-support.ts";

interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  license?: string;
  description?: string;
  repository?: { type?: string; url?: string; directory?: string };
  files?: string[];
  engines?: Record<string, string>;
  exports?: Record<string, string>;
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
}

const manifestOf = (dir: string): Manifest => JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8")) as Manifest;

/** The files `bun pm pack --dry-run` would put in the package's tarball. */
function packedFiles(dir: string): string[] {
  const ran = Bun.spawnSync(["bun", "pm", "pack", "--dry-run"], { cwd: join(ROOT, dir), stdout: "pipe", stderr: "pipe" });
  if (ran.exitCode !== 0) throw new Error(ran.stderr.toString());
  return ran.stdout
    .toString()
    .split("\n")
    .flatMap((line) => /^packed \S+ (.+)$/.exec(line.trim())?.[1] ?? [])
    .sort();
}

describe("the published packages", () => {
  test("the root workspace stays private", () => {
    expect(manifestOf(".").private).toBe(true);
  });

  for (const { name, dir } of PACKAGES) {
    describe(name, () => {
      test("has a publishable manifest: not private, the lockstep version, the repository's licence, its directory, a description, files, and bun as its engine", () => {
        const manifest = manifestOf(dir);
        expect(manifest.name).toBe(name);
        expect(manifest.private).toBeUndefined();
        expect(manifest.version).toBe(VERSION);
        expect(readFileSync(join(ROOT, "LICENSE"), "utf8")).toStartWith("MIT License");
        expect(manifest.license).toBe("MIT");
        expect(manifest.repository).toEqual({ type: "git", url: "git+https://github.com/bounded-dev/the-bounded-harness.git", directory: dir });
        expect((manifest.description ?? "").length).toBeGreaterThan(10);
        expect(manifest.files).toContain("src");
        expect(manifest.engines?.bun).toBeDefined();
      });

      test("its tarball ships the sources and the licence, without tests, test support or fixtures, and holds every export path and bin target", () => {
        const files = packedFiles(dir);
        expect(files).toContain("package.json");
        expect(files).toContain("LICENSE");
        expect(files.some((file) => file.startsWith("src/") && file.endsWith(".ts"))).toBe(true);
        expect(files.filter((file) => file.endsWith(".test.ts"))).toEqual([]);
        expect(files.filter((file) => file.endsWith(".test-support.ts") && file !== CONFORMANCE)).toEqual([]);
        expect(files.filter((file) => file.split("/").includes("fixtures") || file.startsWith("test/"))).toEqual([]);
        const manifest = manifestOf(dir);
        for (const target of [...Object.values(manifest.exports ?? {}), ...Object.values(manifest.bin ?? {})]) expect(files).toContain(target.replace(/^\.\//, ""));
      });
    });
  }

  test("the CLI is an app in source, private at the lockstep version, and ships as bounded's bin, built by bounded's prepack", () => {
    const cli = manifestOf("apps/cli");
    expect(cli.private).toBe(true);
    expect(cli.version).toBe(VERSION);
    const core = manifestOf("contexts/core") as Manifest & { scripts?: Record<string, string> };
    expect(core.bin).toEqual({ bounded: "dist/cli.js" });
    expect(core.files).toContain("dist/cli.js");
    expect(core.scripts?.prepack).toContain("apps/cli/src/main.ts");
    expect(core.scripts?.prepack).toContain("dist/cli.js");
    expect(packedFiles("contexts/core")).toContain("dist/cli.js");
    for (const { dir } of PACKAGES) expect(manifestOf(dir).dependencies?.["bounded-cli"]).toBeUndefined();
  });

  test("bounded's tarball ships the exported installer conformance suite", () => {
    expect(packedFiles("contexts/core")).toContain(CONFORMANCE);
  });

  test("packed, every workspace:* dependency becomes the released version", () => {
    const into = mkdtempSync(join(tmpdir(), "bounded-packaging-"));
    for (const { name, dir } of PACKAGES) {
      const ran = Bun.spawnSync(["bun", "pm", "pack", "--destination", into, "--quiet"], { cwd: join(ROOT, dir), stdout: "pipe", stderr: "pipe" });
      expect(ran.exitCode).toBe(0);
      const tarball = join(into, `${name}-${VERSION}.tgz`);
      const packed = JSON.parse(Bun.spawnSync(["tar", "-xzOf", tarball, "package/package.json"]).stdout.toString()) as Manifest;
      expect(packed.version).toBe(VERSION);
      expect(JSON.stringify(packed)).not.toContain("workspace:");
      if (name !== "bounded") expect(packed.dependencies?.bounded).toBe(VERSION);
    }
  });
});
