// `bounded init --from <dir>`: the first install, run through npx before the
// project has any bounded package. It adds bounded, which carries the CLI and
// the host adapters, as a devDependency from its tarball in <dir>, then hands
// over to the installed bounded with the hosts found or named. The package is
// a small stand-in packed here, so bun installs it without the network.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBoundedCli } from "./bounded-cli.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "bounded-init-from-")));

/** Packs a stand-in bounded whose bin prints that it was handed over to, and its arguments. */
function packBounded(into: string, version: string): string {
  const dir = join(scratch, "sources", `bounded-${version}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(into, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "bounded", version, type: "module", bin: { bounded: "./cli.js" } }));
  writeFileSync(join(dir, "cli.js"), `process.stdout.write("handed over to bounded ${version}: " + process.argv.slice(2).join(" ") + "\\n");\n`);
  const ran = Bun.spawnSync(["bun", "pm", "pack", "--destination", into, "--quiet"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  if (ran.exitCode !== 0) throw new Error(ran.stderr.toString());
  return join(into, `bounded-${version}.tgz`);
}

const releaseDir = join(scratch, "release");
const boundedTarball = packBounded(releaseDir, "1.0.0");

/** A fresh project with a package.json naming bun as its package manager (unless `manifest` is false), and the given directories. */
const FRESH = { name: "demo", private: true, packageManager: "bun@1.3.14" };
function project(dirs: readonly string[], manifest = true): string {
  const root = mkdtempSync(join(scratch, "project-"));
  if (manifest) writeFileSync(join(root, "package.json"), JSON.stringify(FRESH, null, 2));
  for (const dir of dirs) mkdirSync(join(root, dir));
  return root;
}

const manifestOf = (root: string): { devDependencies?: Record<string, string>; dependencies?: Record<string, string>; overrides?: Record<string, string> } => JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

describe("bounded init --from <dir>: the one bounded tarball", () => {
  test("adds bounded alone as a devDependency, overrides it with its tarball, and hands over to the installed bounded with the host found", async () => {
    const root = project([".claude"]);
    const ran = await runBoundedCli(["init", "--from", releaseDir], root);
    expect(ran.stderr).toBe("");
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout).toContain("handed over to bounded 1.0.0: init --no-install --host claude-code");
    const manifest = manifestOf(root);
    expect(Object.keys(manifest.devDependencies ?? {})).toEqual(["bounded"]);
    expect(manifest.dependencies ?? {}).toEqual({});
    expect(manifest.overrides?.bounded).toBe(`file:${boundedTarball}`);
  });

  test.skipIf(Bun.which("npm") === null)("under npm (skipped when npm is not installed), overrides bounded with $bounded, the reference npm accepts beside a direct dependency, and installs bounded alone", async () => {
    const root = mkdtempSync(join(scratch, "project-npm-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demo", private: true, packageManager: "npm@11.0.0" }, null, 2));
    mkdirSync(join(root, ".claude"));
    const ran = await runBoundedCli(["init", "--from", releaseDir], root);
    expect(ran.stderr).toBe("");
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout).toContain("with npm");
    expect(ran.stdout).toContain("handed over to bounded 1.0.0: init --no-install --host claude-code");
    const manifest = manifestOf(root);
    expect(Object.keys(manifest.devDependencies ?? {})).toEqual(["bounded"]);
    expect(manifest.overrides?.bounded).toBe("$bounded");
    expect(readFileSync(join(root, "package-lock.json"), "utf8")).toContain("node_modules/bounded");
  });

  test("hands over every host found: .claude/ and .pi/", async () => {
    const root = project([".claude", ".pi"]);
    const ran = await runBoundedCli(["init", "--from", releaseDir], root);
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout).toContain(": init --no-install --host claude-code --host pi");
    expect(Object.keys(manifestOf(root).devDependencies ?? {})).toEqual(["bounded"]);
  });

  test("--host names the hosts instead of finding them, and they are handed over", async () => {
    const root = project([]);
    const ran = await runBoundedCli(["init", "--from", releaseDir, "--host", "pi"], root);
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout).toContain(": init --no-install --host pi");
    expect(Object.keys(manifestOf(root).devDependencies ?? {})).toEqual(["bounded"]);
  });

  test("refuses when no host is found and none is named, saying how to name one", async () => {
    const root = project([]);
    const ran = await runBoundedCli(["init", "--from", releaseDir], root);
    expect(ran.exitCode).toBe(1);
    expect(ran.stderr).toContain("--host");
    expect(manifestOf(root)).toEqual(FRESH as never);
  });

  test("refuses a host name that is not one, changing nothing", async () => {
    const root = project([]);
    const bad = await runBoundedCli(["init", "--from", releaseDir, "--host", "../evil"], root);
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain("../evil");
    expect(bad.stdout).toBe("");
    expect(manifestOf(root)).toEqual(FRESH as never);
  });

  test("refuses a project that already has a configuration, changing nothing", async () => {
    const root = project([".claude"]);
    writeFileSync(join(root, "bounded.config.ts"), "// mine\n");
    const before = readFileSync(join(root, "package.json"), "utf8");
    const ran = await runBoundedCli(["init", "--from", releaseDir], root);
    expect(ran.exitCode).toBe(1);
    expect(ran.stderr).toContain("bounded update");
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(before);
  });

  test("refuses a directory with no package.json, saying to create one", async () => {
    const root = project([".claude"], false);
    const ran = await runBoundedCli(["init", "--from", releaseDir], root);
    expect(ran.exitCode).toBe(1);
    expect(ran.stderr).toContain("package.json");
  });
});
