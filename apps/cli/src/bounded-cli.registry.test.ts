// `bounded init` and `bounded update` from the npm registry, with a stub
// command runner: the commands built for each package manager are checked,
// and the stub plays the install by writing node_modules, so no test touches
// the network.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type CommandRun, runBoundedCli } from "./bounded-cli.ts";

/** The running CLI's own version: registry init installs exactly this. */
const OWN = (JSON.parse(readFileSync(resolve(import.meta.dir, "../package.json"), "utf8")) as { version: string }).version;
const MANAGERS = ["bun", "npm", "pnpm", "yarn"] as const;
type Manager = (typeof MANAGERS)[number];
const LOCKFILE: Record<Manager, string> = { bun: "bun.lock", npm: "package-lock.json", pnpm: "pnpm-lock.yaml", yarn: "yarn.lock" };
const BIN = "src/main.ts";

/** Writes an installed package into the project's node_modules: bounded-cli with its bin, a host adapter with its installer export. */
function installed(root: string, name: string, version: string): void {
  const dir = join(root, "node_modules", name);
  mkdirSync(dir, { recursive: true });
  const manifest: Record<string, unknown> = { name, version };
  if (name === "bounded-cli") manifest.bin = { bounded: `./${BIN}` };
  if (name.startsWith("bounded-") && name !== "bounded-cli") manifest.exports = { "./host-installer": "./src/host-installer.ts" };
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
}

/**
 * A stub runner: it records every command; a package manager's command
 * "installs" by calling `onInstall`, and answers `installStatus`; the
 * hand-off to the installed CLI answers what it was asked.
 */
function stub(root: string, onInstall: (command: readonly string[]) => void, installStatus = 0): { commands: string[][]; run: (command: readonly string[], cwd: string) => CommandRun } {
  const commands: string[][] = [];
  return {
    commands,
    run: (command, cwd) => {
      commands.push([...command]);
      expect(cwd).toBe(root);
      if (command[0] === process.execPath) return { status: 0, stdout: `handed over: ${command.slice(2).join(" ")}\n`, stderr: "" };
      if (installStatus === 0) onInstall(command);
      return { status: installStatus, stdout: "", stderr: installStatus === 0 ? "" : "network down" };
    },
  };
}

const json = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const handOver = (root: string, ...args: string[]): string[] => [process.execPath, join(root, "node_modules", "bounded-cli", BIN), ...args];

/** A fresh project using `manager`, with the given host directories. */
function fresh(manager: Manager, dirs: readonly string[] = [".claude"]): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `bounded-registry-init-${manager}-`)));
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "demo", private: true, packageManager: `${manager}@1.0.0` }, null, 2)}\n`);
  for (const dir of dirs) mkdirSync(join(root, dir));
  return root;
}

/** The stub install of `init`: every devDependency the manifest names, at the spec it names. */
const installManifest = (root: string) => () => {
  const manifest = json<{ devDependencies: Record<string, string> }>(join(root, "package.json"));
  for (const [name, spec] of Object.entries(manifest.devDependencies)) installed(root, name, spec);
};

describe("bounded-cli — bounded init from the registry", () => {
  for (const manager of MANAGERS) {
    test(`with ${manager}: adds bounded, bounded-cli and the host's adapter at exactly this CLI's version, with no override, installs, and hands over`, async () => {
      const root = fresh(manager);
      const runner = stub(root, installManifest(root));
      const ran = await runBoundedCli(["init"], root, runner.run);
      expect(ran.stderr).toBe("");
      expect(ran.exitCode).toBe(0);
      expect(runner.commands).toEqual([[manager, "install"], handOver(root, "init", "--no-install")]);
      const manifest = json<Record<string, unknown>>(join(root, "package.json"));
      expect(manifest.devDependencies).toEqual({ bounded: OWN, "bounded-claude-code": OWN, "bounded-cli": OWN });
      expect(manifest.dependencies ?? {}).toEqual({});
      expect(manifest.overrides).toBeUndefined();
      expect(manifest.resolutions).toBeUndefined();
      expect(manifest.pnpm).toBeUndefined();
      expect(ran.stdout).toContain("handed over: init --no-install");
    });
  }

  test("adds every host found or named", async () => {
    const both = fresh("bun", [".claude", ".pi"]);
    await runBoundedCli(["init"], both, stub(both, installManifest(both)).run);
    expect(Object.keys(json<{ devDependencies: object }>(join(both, "package.json")).devDependencies).sort()).toEqual(["bounded", "bounded-claude-code", "bounded-cli", "bounded-pi"]);
    const named = fresh("bun", []);
    await runBoundedCli(["init", "--host", "pi"], named, stub(named, installManifest(named)).run);
    expect(Object.keys(json<{ devDependencies: object }>(join(named, "package.json")).devDependencies).sort()).toEqual(["bounded", "bounded-cli", "bounded-pi"]);
  });

  test("when the install fails, package.json and the lockfile are restored and nothing is handed over", async () => {
    const root = fresh("npm");
    writeFileSync(join(root, "package-lock.json"), "lock before\n");
    const before = readFileSync(join(root, "package.json"), "utf8");
    const runner = stub(root, () => writeFileSync(join(root, "package-lock.json"), "lock after\n"), 1);
    const ran = await runBoundedCli(["init"], root, runner.run);
    expect(ran.exitCode).toBe(1);
    expect(ran.stderr).toContain("npm install failed");
    expect(ran.stderr).toContain("package.json was restored");
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(before);
    expect(readFileSync(join(root, "package-lock.json"), "utf8")).toBe("lock before\n");
    expect(runner.commands).toEqual([["npm", "install"]]);
  });

  test("refuses an installed version that is not this CLI's, restoring package.json", async () => {
    const root = fresh("bun");
    const before = readFileSync(join(root, "package.json"), "utf8");
    const runner = stub(root, () => {
      for (const name of ["bounded", "bounded-cli", "bounded-claude-code"]) installed(root, name, "2.0.2");
    });
    const ran = await runBoundedCli(["init"], root, runner.run);
    expect(ran.exitCode).toBe(1);
    expect(ran.stderr).toContain(`is version 2.0.2, not ${OWN}`);
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(before);
    expect(runner.commands).toHaveLength(1);
  });

  test("refuses, running nothing, a project with a configuration, with no host, or with no package.json", async () => {
    const configured = fresh("bun");
    writeFileSync(join(configured, "bounded.config.ts"), "// mine\n");
    const hostless = fresh("bun", []);
    const bare = realpathSync(mkdtempSync(join(tmpdir(), "bounded-registry-bare-")));
    for (const [root, says] of [
      [configured, "bounded update"],
      [hostless, "--host"],
      [bare, "package.json"],
    ] as const) {
      const runner = stub(root, () => {});
      const ran = await runBoundedCli(["init"], root, runner.run);
      expect(ran.exitCode).toBe(1);
      expect(ran.stderr).toContain(says);
      expect(runner.commands).toEqual([]);
    }
  });
});

/** An initialised project using `manager`, with bounded, bounded-cli and bounded-claude-code installed at 3.0.0. */
function initialised(manager: Manager, devDependencies = true): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `bounded-registry-update-${manager}-`)));
  const names = { bounded: "3.0.0", "bounded-cli": "3.0.0", "bounded-claude-code": "3.0.0" };
  const manifest = devDependencies ? { name: "demo", private: true, devDependencies: names } : { name: "demo", private: true, dependencies: { bounded: "3.0.0" }, devDependencies: { "bounded-cli": "3.0.0", "bounded-claude-code": "3.0.0" } };
  writeFileSync(join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(root, LOCKFILE[manager]), "lock before\n");
  writeFileSync(join(root, "bounded.config.ts"), "// mine\n");
  for (const name of Object.keys(names)) installed(root, name, "3.0.0");
  return root;
}

/** The stub upgrade: every bounded package to `versions` (one for all, or one each), and the lockfile rewritten. */
const upgradeTo = (root: string, manager: Manager, versions: string | Record<string, string>) => () => {
  for (const name of ["bounded", "bounded-cli", "bounded-claude-code"]) installed(root, name, typeof versions === "string" ? versions : (versions[name] ?? "3.0.0"));
  writeFileSync(join(root, LOCKFILE[manager]), "lock after\n");
};

const LATEST = ["bounded@latest", "bounded-claude-code@latest", "bounded-cli@latest"];
const UPGRADE: Record<Manager, string[]> = {
  bun: ["bun", "add", "--dev", ...LATEST],
  npm: ["npm", "install", "--save-dev", ...LATEST],
  pnpm: ["pnpm", "add", "--save-dev", ...LATEST],
  yarn: ["yarn", "add", "--dev", ...LATEST],
};

describe("bounded-cli — bounded update from the registry", () => {
  for (const manager of MANAGERS) {
    test(`with ${manager}: upgrades the bounded packages present to their latest, checks them, and hands over`, async () => {
      const root = initialised(manager);
      const runner = stub(root, upgradeTo(root, manager, "3.1.0"));
      const ran = await runBoundedCli(["update"], root, runner.run);
      expect(ran.stderr).toBe("");
      expect(ran.exitCode).toBe(0);
      expect(runner.commands).toEqual([UPGRADE[manager], handOver(root, "update", "--no-upgrade")]);
      expect(ran.stdout).toContain("bounded 3.1.0");
      expect(ran.stdout).toContain("handed over: update --no-upgrade");
      expect(readFileSync(join(root, "bounded.config.ts"), "utf8")).toBe("// mine\n");
    });
  }

  test("upgrades dependencies and devDependencies each where they are", async () => {
    const root = initialised("npm", false);
    const runner = stub(root, upgradeTo(root, "npm", "3.1.0"));
    expect((await runBoundedCli(["update"], root, runner.run)).exitCode).toBe(0);
    expect(runner.commands.slice(0, 2)).toEqual([
      ["npm", "install", "bounded@latest"],
      ["npm", "install", "--save-dev", "bounded-claude-code@latest", "bounded-cli@latest"],
    ]);
  });

  test("when the upgrade fails, package.json and the lockfile are restored and nothing is handed over", async () => {
    const root = initialised("pnpm");
    const before = readFileSync(join(root, "package.json"), "utf8");
    const runner = stub(root, () => {}, 1);
    const ran = await runBoundedCli(["update"], root, runner.run);
    expect(ran.exitCode).toBe(1);
    expect(ran.stderr).toContain("package.json was restored");
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(before);
    expect(readFileSync(join(root, "pnpm-lock.yaml"), "utf8")).toBe("lock before\n");
    expect(runner.commands).toHaveLength(1);
  });

  test("refuses packages left out of lockstep, or moved to an older version, restoring the lockfile", async () => {
    for (const versions of [{ bounded: "3.1.0", "bounded-cli": "3.0.5", "bounded-claude-code": "3.1.0" }, "2.0.2"]) {
      const root = initialised("yarn");
      const runner = stub(root, upgradeTo(root, "yarn", versions));
      const ran = await runBoundedCli(["update"], root, runner.run);
      expect(ran.exitCode).toBe(1);
      expect(ran.stderr).toMatch(/not all at one version|older than/);
      expect(readFileSync(join(root, "yarn.lock"), "utf8")).toBe("lock before\n");
      expect(runner.commands).toHaveLength(1);
    }
  });

  test("refuses a project that was never initialised, running nothing", async () => {
    const root = initialised("bun");
    const runner = stub(root, () => {});
    rmSync(join(root, "bounded.config.ts"));
    const ran = await runBoundedCli(["update"], root, runner.run);
    expect(ran.exitCode).toBe(1);
    expect(ran.stderr).toContain("bounded init");
    expect(runner.commands).toEqual([]);
  });
});
