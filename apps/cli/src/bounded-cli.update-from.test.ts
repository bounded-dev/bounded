// `bounded update --from <dir>`: each way the upgrade can be refused, and the
// override following the upgrade. The packages are small stand-ins packed
// here, so bun installs them without the network.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBoundedCli } from "./bounded-cli.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "bounded-update-from-")));

const INSTALLER = `export const hostInstaller = { host: "fake", install: async () => ({ ok: true, value: { host: "fake", changedPaths: [], skippedBecause: null } }) };\n`;

/** Packs a stand-in package into `into` (made if missing); `bin` gives it a `bounded` bin that prints that it was handed over to, and its arguments. */
function pack(into: string, name: string, version: string, options: { bin?: boolean } = {}): string {
  const dir = join(scratch, "sources", `${name}-${version}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(into, { recursive: true });
  const manifest: Record<string, unknown> = { name, version, type: "module" };
  if (name === "fake-host") {
    manifest.exports = { "./host-installer": "./host-installer.js" };
    writeFileSync(join(dir, "host-installer.js"), INSTALLER);
  }
  if (options.bin === true) {
    manifest.bin = { bounded: "./cli.js" };
    writeFileSync(join(dir, "cli.js"), `process.stdout.write("handed over to ${name} ${version}: " + process.argv.slice(2).join(" ") + "\\n");\n`);
  }
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  const ran = Bun.spawnSync(["bun", "pm", "pack", "--destination", into, "--quiet"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  if (ran.exitCode !== 0) throw new Error(ran.stderr.toString());
  return join(into, `${name}-${version}.tgz`);
}

/** A release in `into`: bounded, bounded-cli (with the bin unless `cliBin` is false) and the fake host adapter. */
function release(into: string, version: string, cliBin = true): { bounded: string } {
  const bounded = pack(into, "bounded", version);
  pack(into, "bounded-cli", version, { bin: cliBin });
  pack(into, "fake-host", version);
  return { bounded };
}

const release1 = join(scratch, "release-1");
const { bounded: bounded1 } = release(release1, "1.0.0");

/** An initialised project that installed release 1 with bun as devDependencies, overriding `bounded` with its tarball. */
function project(): string {
  const root = mkdtempSync(join(scratch, "project-"));
  const devDependencies = Object.fromEntries(["bounded", "bounded-cli", "fake-host"].map((name) => [name, join(release1, `${name}-1.0.0.tgz`)]));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demo", private: true, overrides: { bounded: `file:${bounded1}` }, devDependencies }, null, 2));
  writeFileSync(join(root, "bounded.config.ts"), "// mine\n");
  const ran = Bun.spawnSync(["bun", "install"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (ran.exitCode !== 0) throw new Error(ran.stderr.toString());
  return root;
}

const manifestOf = (root: string): string => readFileSync(join(root, "package.json"), "utf8");
const versionOf = (root: string, name: string): unknown => (JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8")) as { version: unknown }).version;

describe("bounded-cli — bounded update --from", () => {
  test("upgrades, points the override of bounded at the new tarball, checks the versions and hands over to the new CLI", async () => {
    const root = project();
    const release2 = join(scratch, "release-2-ok");
    const { bounded: bounded2 } = release(release2, "2.0.0");
    const ran = await runBoundedCli(["update", "--from", release2], root);
    expect(ran.stderr).toBe("");
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout).toContain("Upgraded bounded 2.0.0, bounded-cli 2.0.0, fake-host 2.0.0 with bun");
    expect(ran.stdout).toContain("handed over to bounded-cli 2.0.0: update --no-upgrade");
    expect(versionOf(root, "bounded")).toBe("2.0.0");
    expect(versionOf(root, "bounded-cli")).toBe("2.0.0");
    expect(versionOf(root, "fake-host")).toBe("2.0.0");
    const manifest = JSON.parse(manifestOf(root)) as { overrides: { bounded: string }; devDependencies: Record<string, string>; dependencies?: unknown };
    expect(manifest.overrides.bounded).toBe(`file:${bounded2}`);
    expect(Object.keys(manifest.devDependencies).sort()).toEqual(["bounded", "bounded-cli", "fake-host"]);
    expect(manifest.dependencies ?? {}).toEqual({});
    expect(readFileSync(join(root, "bounded.config.ts"), "utf8")).toBe("// mine\n");
  });

  test("refuses a directory that cannot be read", async () => {
    const root = project();
    const ran = await runBoundedCli(["update", "--from", join(scratch, "no-such-directory")], root);
    expect(ran.exitCode).toBe(1);
    expect(ran.stderr).toContain("cannot be read");
  });

  test("refuses when a package's tarball is missing, naming it, and changes nothing", async () => {
    const root = project();
    const before = manifestOf(root);
    const dir = join(scratch, "release-missing");
    pack(dir, "bounded", "2.0.0");
    pack(dir, "bounded-cli", "2.0.0", { bin: true });
    const ran = await runBoundedCli(["update", "--from", dir], root);
    expect(ran.exitCode).toBe(1);
    expect(ran.stderr).toContain("no fake-host-<version>.tgz");
    expect(manifestOf(root)).toBe(before);
  });

  test("refuses two tarballs of one package, naming both", async () => {
    const root = project();
    const dir = join(scratch, "release-two");
    release(dir, "2.0.0");
    pack(dir, "bounded", "2.1.0");
    const ran = await runBoundedCli(["update", "--from", dir], root);
    expect(ran.exitCode).toBe(1);
    expect(ran.stderr).toContain("bounded-2.0.0.tgz, bounded-2.1.0.tgz");
  });

  test("when the package manager fails, package.json is restored and the message says so", async () => {
    const root = project();
    const before = manifestOf(root);
    const dir = join(scratch, "release-broken");
    mkdirSync(dir, { recursive: true });
    for (const name of ["bounded", "bounded-cli", "fake-host"]) writeFileSync(join(dir, `${name}-2.0.0.tgz`), "not a tarball");
    const ran = await runBoundedCli(["update", "--from", dir], root);
    expect(ran.exitCode).toBe(1);
    expect(ran.stderr).toContain("bun install failed");
    expect(ran.stderr).toContain("package.json was restored");
    expect(manifestOf(root)).toBe(before);
  });

  test("refuses when the installed version is not the tarball's, restoring package.json", async () => {
    const root = project();
    const before = manifestOf(root);
    const lockfileBefore = readFileSync(join(root, "bun.lock"), "utf8");
    const dir = join(scratch, "release-mislabelled");
    const packed = pack(dir, "bounded", "1.5.0");
    renameSync(packed, join(dir, "bounded-2.0.0.tgz"));
    pack(dir, "bounded-cli", "2.0.0", { bin: true });
    pack(dir, "fake-host", "2.0.0");
    const ran = await runBoundedCli(["update", "--from", dir], root);
    expect(ran.exitCode).toBe(1);
    expect(ran.stderr).toContain("bounded is version 1.5.0, not 2.0.0");
    expect(manifestOf(root)).toBe(before);
    // The install succeeded and rewrote the lockfile: it is put back with package.json.
    expect(readFileSync(join(root, "bun.lock"), "utf8")).toBe(lockfileBefore);
    expect(ran.stderr).toContain("bun.lock");
  });

  test("when the new bounded-cli cannot be run, the upgrade stands and the message says to refresh the hooks", async () => {
    const root = project();
    release(join(scratch, "release-no-bin"), "2.0.0", false);
    const ran = await runBoundedCli(["update", "--from", join(scratch, "release-no-bin")], root);
    expect(ran.exitCode).toBe(1);
    expect(ran.stdout).toContain("Upgraded bounded 2.0.0");
    expect(ran.stderr).toContain("bounded update --no-upgrade");
    expect(versionOf(root, "bounded-cli")).toBe("2.0.0");
  });
});
