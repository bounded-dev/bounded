// `bounded init --from <dir>`: the first install, run through npx before the
// project has any bounded package. It adds bounded, bounded-cli and the
// detected hosts' adapter packages as devDependencies from the tarballs in
// <dir>, then hands over to the bounded-cli it installed. The packages are
// small stand-ins packed here, so bun installs them without the network.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBoundedCli } from "./bounded-cli.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "bounded-init-from-")));

function pack(into: string, name: string, version: string, options: { bin?: boolean } = {}): string {
  const dir = join(scratch, "sources", `${name}-${version}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(into, { recursive: true });
  const manifest: Record<string, unknown> = { name, version, type: "module" };
  if (options.bin === true) {
    manifest.bin = { bounded: "./cli.js" };
    writeFileSync(join(dir, "cli.js"), `process.stdout.write("handed over to ${name} ${version}: " + process.argv.slice(2).join(" ") + "\\n");\n`);
  }
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  const ran = Bun.spawnSync(["bun", "pm", "pack", "--destination", into, "--quiet"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  if (ran.exitCode !== 0) throw new Error(ran.stderr.toString());
  return join(into, `${name}-${version}.tgz`);
}

const releaseDir = join(scratch, "release");
const boundedTarball = pack(releaseDir, "bounded", "1.0.0");
pack(releaseDir, "bounded-cli", "1.0.0", { bin: true });
pack(releaseDir, "bounded-claude-code", "1.0.0");
pack(releaseDir, "bounded-pi", "1.0.0");

/** A fresh project with a package.json naming bun as its package manager (unless `manifest` is false), and the given directories. */
const FRESH = { name: "demo", private: true, packageManager: "bun@1.3.14" };
function project(dirs: readonly string[], manifest = true): string {
  const root = mkdtempSync(join(scratch, "project-"));
  if (manifest) writeFileSync(join(root, "package.json"), JSON.stringify(FRESH, null, 2));
  for (const dir of dirs) mkdirSync(join(root, dir));
  return root;
}

const manifestOf = (root: string): { devDependencies?: Record<string, string>; dependencies?: Record<string, string>; overrides?: Record<string, string> } => JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

describe("bounded-cli — bounded init --from", () => {
  test("adds bounded, bounded-cli and the detected host's adapter as devDependencies, overrides bounded, and hands over to the installed CLI", async () => {
    const root = project([".claude"]);
    const ran = await runBoundedCli(["init", "--from", releaseDir], root);
    expect(ran.stderr).toBe("");
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout).toContain("handed over to bounded-cli 1.0.0: init");
    const manifest = manifestOf(root);
    expect(Object.keys(manifest.devDependencies ?? {}).sort()).toEqual(["bounded", "bounded-claude-code", "bounded-cli"]);
    expect(manifest.dependencies ?? {}).toEqual({});
    expect(manifest.overrides?.bounded).toBe(`file:${boundedTarball}`);
  });

  test("adds every detected host's adapter: .claude/ and .pi/", async () => {
    const root = project([".claude", ".pi"]);
    expect((await runBoundedCli(["init", "--from", releaseDir], root)).exitCode).toBe(0);
    expect(Object.keys(manifestOf(root).devDependencies ?? {}).sort()).toEqual(["bounded", "bounded-claude-code", "bounded-cli", "bounded-pi"]);
  });

  test("--host names the hosts instead of detecting them", async () => {
    const root = project([]);
    expect((await runBoundedCli(["init", "--from", releaseDir, "--host", "pi"], root)).exitCode).toBe(0);
    expect(Object.keys(manifestOf(root).devDependencies ?? {}).sort()).toEqual(["bounded", "bounded-cli", "bounded-pi"]);
  });

  test("refuses when no host is found and none is named, saying how to name one", async () => {
    const root = project([]);
    const ran = await runBoundedCli(["init", "--from", releaseDir], root);
    expect(ran.exitCode).toBe(1);
    expect(ran.stderr).toContain("--host");
    expect(manifestOf(root)).toEqual(FRESH as never);
  });

  test("refuses a host name that is not one, and a host with no tarball", async () => {
    const root = project([]);
    const bad = await runBoundedCli(["init", "--from", releaseDir, "--host", "../evil"], root);
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain("../evil");
    const missing = await runBoundedCli(["init", "--from", releaseDir, "--host", "zed"], root);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("bounded-zed");
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
