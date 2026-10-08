// `bounded init` and `bounded update` from the npm registry, with a stub
// command runner: the commands built for each package manager are checked,
// and the stub plays the install by writing node_modules, so no test touches
// the network. One package is installed, `bounded`: it carries the CLI (its
// bin, dist/cli.js) and the host adapters, bundled at pack time.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type CommandRun, runBoundedCli } from "./bounded-cli.ts";

/** The running CLI's own version: registry init installs exactly this. */
const OWN = (JSON.parse(readFileSync(resolve(import.meta.dir, "../package.json"), "utf8")) as { version: string }).version;
const MANAGERS = ["bun", "npm", "pnpm", "yarn"] as const;
type Manager = (typeof MANAGERS)[number];
const LOCKFILE: Record<Manager, string> = { bun: "bun.lock", npm: "package-lock.json", pnpm: "pnpm-lock.yaml", yarn: "yarn.lock" };
const BIN = "dist/cli.js";

/** Writes an installed package into the project's node_modules: bounded with its bin, any other as a third-party host adapter. */
function installed(root: string, name: string, version: string): void {
  const dir = join(root, "node_modules", name);
  mkdirSync(dir, { recursive: true });
  const manifest: Record<string, unknown> = { name, version };
  if (name === "bounded") manifest.bin = { bounded: BIN };
  else manifest.exports = { "./host-installer": "./host-installer.js" };
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
      if (cwd !== root) throw new Error(`ran in ${cwd}, not the project ${root}`);
      if (command[0] === process.execPath) return { status: 0, stdout: `handed over: ${command.slice(2).join(" ")}\n`, stderr: "" };
      if (installStatus === 0) onInstall(command);
      return { status: installStatus, stdout: "", stderr: installStatus === 0 ? "" : "network down" };
    },
  };
}

const json = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const handOver = (root: string, ...args: string[]): string[] => [process.execPath, join(root, "node_modules", "bounded", BIN), ...args];

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

describe("bounded init from the registry: the one bounded package", () => {
  test("with each of bun, npm, pnpm and yarn: adds bounded alone at exactly this CLI's version, with no override, installs, and hands over with the hosts found", async () => {
    for (const manager of MANAGERS) {
      const root = fresh(manager);
      const runner = stub(root, installManifest(root));
      const ran = await runBoundedCli(["init"], root, runner.run);
      expect(ran.stderr).toBe("");
      expect(ran.exitCode).toBe(0);
      expect(runner.commands).toEqual([[manager, "install"], handOver(root, "init", "--no-install", "--host", "claude-code")]);
      const manifest = json<Record<string, unknown>>(join(root, "package.json"));
      expect(manifest.devDependencies).toEqual({ bounded: OWN });
      expect(manifest.dependencies ?? {}).toEqual({});
      expect(manifest.overrides).toBeUndefined();
      expect(manifest.resolutions).toBeUndefined();
      expect(manifest.pnpm).toBeUndefined();
      expect(ran.stdout).toContain("handed over: init --no-install --host claude-code");
      expect(JSON.stringify(manifest)).not.toMatch(/bounded-(cli|claude-code|pi)/);
    }
  });

  test("hands over every host found or named, installing bounded alone", async () => {
    const both = fresh("bun", [".claude", ".pi"]);
    const bothRunner = stub(both, installManifest(both));
    await runBoundedCli(["init"], both, bothRunner.run);
    expect(bothRunner.commands[1]).toEqual(handOver(both, "init", "--no-install", "--host", "claude-code", "--host", "pi"));
    expect(Object.keys(json<{ devDependencies: object }>(join(both, "package.json")).devDependencies)).toEqual(["bounded"]);
    const named = fresh("bun", []);
    const namedRunner = stub(named, installManifest(named));
    await runBoundedCli(["init", "--host", "pi"], named, namedRunner.run);
    expect(namedRunner.commands[1]).toEqual(handOver(named, "init", "--no-install", "--host", "pi"));
    expect(Object.keys(json<{ devDependencies: object }>(join(named, "package.json")).devDependencies)).toEqual(["bounded"]);
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

  test("refuses an installed bounded that is not this CLI's version, restoring package.json", async () => {
    const root = fresh("bun");
    const before = readFileSync(join(root, "package.json"), "utf8");
    const runner = stub(root, () => installed(root, "bounded", "2.0.2"));
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

/** An initialised project using `manager`, with bounded installed at 3.0.0 (in devDependencies, or dependencies) and a third-party host adapter. */
function initialised(manager: Manager, devDependencies = true): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `bounded-registry-update-${manager}-`)));
  const group = devDependencies ? "devDependencies" : "dependencies";
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "demo", private: true, [group]: { bounded: "3.0.0", "third-party-host": "1.0.0" } }, null, 2)}\n`);
  writeFileSync(join(root, LOCKFILE[manager]), "lock before\n");
  writeFileSync(join(root, "bounded.config.ts"), "// mine\n");
  installed(root, "bounded", "3.0.0");
  installed(root, "third-party-host", "1.0.0");
  return root;
}

/** The stub upgrade: bounded to `version`, and the lockfile rewritten. */
const upgradeTo = (root: string, manager: Manager, version: string) => () => {
  installed(root, "bounded", version);
  writeFileSync(join(root, LOCKFILE[manager]), "lock after\n");
};

const UPGRADE: Record<Manager, string[]> = {
  bun: ["bun", "add", "--dev", "bounded@latest"],
  npm: ["npm", "install", "--save-dev", "bounded@latest"],
  pnpm: ["pnpm", "add", "--save-dev", "bounded@latest"],
  yarn: ["yarn", "add", "--dev", "bounded@latest"],
};

describe("bounded update from the registry: the one bounded package", () => {
  test("with each of bun, npm, pnpm and yarn: upgrades bounded alone to its latest, leaving other packages, checks it, and hands over", async () => {
    for (const manager of MANAGERS) {
      const root = initialised(manager);
      const runner = stub(root, upgradeTo(root, manager, "3.1.0"));
      const ran = await runBoundedCli(["update"], root, runner.run);
      expect(ran.stderr).toBe("");
      expect(ran.exitCode).toBe(0);
      expect(runner.commands).toEqual([UPGRADE[manager], handOver(root, "update", "--no-upgrade")]);
      expect(ran.stdout).toContain("bounded 3.1.0");
      expect(ran.stdout).toContain("handed over: update --no-upgrade");
      expect(readFileSync(join(root, "bounded.config.ts"), "utf8")).toBe("// mine\n");
    }
  });

  test("hands the version bounded was before the upgrade to a bounded that accepts it (3.1.1 or later), so its restart notice knows whether the version changed", async () => {
    const root = initialised("bun");
    const runner = stub(root, upgradeTo(root, "bun", "9.0.0"));
    const ran = await runBoundedCli(["update"], root, runner.run);
    expect(ran.stderr).toBe("");
    expect(ran.exitCode).toBe(0);
    expect(runner.commands).toEqual([UPGRADE.bun, handOver(root, "update", "--no-upgrade", "--previous-version", "3.0.0")]);
    // A bounded older than 3.1.1 does not understand --previous-version: it is handed `update --no-upgrade` alone.
    const older = initialised("bun");
    const olderRunner = stub(older, upgradeTo(older, "bun", "3.1.0"));
    expect((await runBoundedCli(["update"], older, olderRunner.run)).exitCode).toBe(0);
    expect(olderRunner.commands[1]).toEqual(handOver(older, "update", "--no-upgrade"));
  });

  test("upgrades bounded where the project lists it: in dependencies", async () => {
    const root = initialised("npm", false);
    const runner = stub(root, upgradeTo(root, "npm", "3.1.0"));
    expect((await runBoundedCli(["update"], root, runner.run)).exitCode).toBe(0);
    expect(runner.commands[0]).toEqual(["npm", "install", "bounded@latest"]);
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

  test("refuses bounded moved to an older version, restoring the lockfile", async () => {
    const root = initialised("yarn");
    const runner = stub(root, upgradeTo(root, "yarn", "2.0.2"));
    const ran = await runBoundedCli(["update"], root, runner.run);
    expect(ran.exitCode).toBe(1);
    expect(ran.stderr).toContain("older than 3.0.0");
    expect(readFileSync(join(root, "yarn.lock"), "utf8")).toBe("lock before\n");
    expect(runner.commands).toHaveLength(1);
  });

  test("a failed update leaves a binary lockfile byte for byte, and rewrites no file whose bytes did not change", async () => {
    const root = initialised("bun");
    rmSync(join(root, "bun.lock"));
    const binary = Buffer.from([0x23, 0xff, 0xfe, 0x00, 0x80]);
    writeFileSync(join(root, "bun.lockb"), binary);
    const manifestModified = statSync(join(root, "package.json")).mtimeMs;
    const runner = stub(root, () => {}, 1);
    const ran = await runBoundedCli(["update"], root, runner.run);
    expect(ran.exitCode).toBe(1);
    expect(Buffer.compare(readFileSync(join(root, "bun.lockb")), binary)).toBe(0);
    expect(statSync(join(root, "package.json")).mtimeMs).toBe(manifestModified);
  });

  test("drops an override of bounded a --from install left, so the registry's latest is installed; refuses a bounded older than the version the package manager resolved", async () => {
    const pinned = initialised("bun");
    const manifestPath = join(pinned, "package.json");
    writeFileSync(manifestPath, `${JSON.stringify({ ...json<object>(manifestPath), overrides: { bounded: "file:/old/bounded-3.0.0.tgz" } }, null, 2)}\n`);
    const before = readFileSync(manifestPath, "utf8");
    const overridesAtInstall: unknown[] = [];
    // The manager resolves the latest, 3.2.0, into package.json, but installs 3.0.0, as a pin would.
    const resolvesLatest = (version: string) => () => {
      const manifest = json<Record<string, unknown> & { devDependencies: Record<string, string> }>(manifestPath);
      overridesAtInstall.push(manifest.overrides);
      writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, devDependencies: { ...manifest.devDependencies, bounded: "^3.2.0" } }, null, 2)}\n`);
      installed(pinned, "bounded", version);
    };
    const refused = await runBoundedCli(["update"], pinned, stub(pinned, resolvesLatest("3.0.0")).run);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("3.2.0");
    expect(readFileSync(manifestPath, "utf8")).toBe(before);
    expect(overridesAtInstall).toEqual([{}]);

    const upgraded = await runBoundedCli(["update"], pinned, stub(pinned, resolvesLatest("3.2.0")).run);
    expect(upgraded.stderr).toBe("");
    expect(upgraded.exitCode).toBe(0);
    expect(json<{ overrides?: Record<string, string> }>(manifestPath).overrides?.bounded).toBeUndefined();
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
