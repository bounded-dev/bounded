// The `bounded` command: `bounded init` and `bounded update`, wired to the
// core's file-system and node_modules adapters. Its source is this app,
// apps/cli; it ships inside the `bounded` package as its bin, dist/cli.js,
// bundled by bounded's prepack (ADR 2026-016).
//
// Both install packages, then hand over to the bounded they just installed,
// so the rest is always the installed version's own work:
// - `bounded init` (run through `npx bounded init` before the project has
//   any bounded package) adds bounded and the hosts' adapter packages at
//   this CLI's own version, from the npm registry or with
//   `--from <dir>` from local tarballs, then runs the installed
//   `bounded init --no-install`, which sets the project up;
// - `bounded update` upgrades them, to their latest from the registry or
//   from the tarballs in `--from <dir>`, then runs the installed
//   `bounded update --no-upgrade`, which refreshes the hooks.
// Those two hand-offs are the contract between versions: every version
// accepts `bounded init --no-install` and `bounded update --no-upgrade`.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FileSystemProjectSetupFiles } from "bounded/adapters/file-system";
import { NodeModulesHostInstallerSource } from "bounded/adapters/system";
import { InitProjectHandler, type ProjectSetupFiles, requireInitialised, type SetupReport, UpdateProjectHandler } from "bounded/application";
import type { Result } from "bounded/domain";
import {
  compareVersions,
  installCommand,
  LOCKFILE_NAMES,
  type PackageManager,
  type PackageToUpgrade,
  packageManagerOf,
  tarballFor,
  tarballVersion,
  upgradeToLatestCommands,
  withBoundedOverride,
  withUpgradedSpecs,
} from "./package-upgrade.ts";

/** What a run of the CLI printed, and its exit code: 0 done, 1 refused, 2 not understood. */
export interface CliRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** What running a command gave: its exit status (null when it could not start), its output, and why it could not start. */
export interface CommandRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
}

/** Runs a command in a directory: a package manager, or the installed bounded's bin. Tests give a stub. */
export type CommandRunner = (command: readonly string[], cwd: string) => CommandRun;

const spawnRunner: CommandRunner = (command, cwd) => {
  const [program = "", ...args] = command;
  const ran = spawnSync(program, args, { cwd, encoding: "utf8" });
  return { status: ran.status, stdout: ran.stdout ?? "", stderr: ran.stderr ?? "", ...(ran.error === undefined ? {} : { error: ran.error.message }) };
};

export const USAGE = `Usage:
  bounded init [--host <host>]... [--from <dir>]   first install: add bounded and each host's adapter package
                                                   (bounded-<host>; by default the hosts whose directory exists: .claude/, .pi/)
                                                   at this CLI's version from the npm registry, or from the tarballs in <dir>,
                                                   then set bounded up
  bounded init --no-install                        set bounded up: a configuration selecting the core pack, and every host's hooks
  bounded update [--from <dir>]                    upgrade the bounded packages to their latest from the npm registry, or from
                                                   the tarballs in <dir>, then refresh every host's hooks
  bounded update --no-upgrade                      refresh every host's hooks to point at the installed version
`;

/** The hosts `bounded init` finds by their directory in the project, and the adapter package each is installed with (bounded-<host>). */
const HOST_DIRECTORIES: readonly (readonly [string, string])[] = [
  [".claude", "claude-code"],
  [".pi", "pi"],
];

type Json = Readonly<Record<string, unknown>>;
const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

function readJson(path: string): Json {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) throw new Error(`${path} is not a JSON object`);
  return parsed;
}

/** This CLI's version: from bounded's package.json when bundled (dist/cli.js), from apps/cli's in source; they are released in lockstep. */
function ownVersion(): string {
  const version = readJson(fileURLToPath(new URL("../package.json", import.meta.url))).version;
  return typeof version === "string" ? version : "(unknown version)";
}

const RESTART = "Restart each agent host's session in this project (start a new session) so it loads the hooks.";

const message = (thrown: unknown): string => (thrown instanceof Error ? thrown.message : String(thrown));

function reportText(report: SetupReport): string {
  const lines = [`bounded ${ownVersion()}`];
  if (report.configWritten !== null) lines.push(`Wrote ${report.configWritten}: it selects the core pack only; add packs there to guard this project.`);
  for (const host of report.hosts) {
    if (host.skippedBecause !== null) lines.push(`${host.host}: skipped (${host.skippedBecause})`);
    else if (host.changedPaths.length > 0) lines.push(`${host.host}: updated ${host.changedPaths.join(", ")}`);
    else lines.push(`${host.host}: up to date`);
  }
  lines.push(RESTART);
  return `${lines.join("\n")}\n`;
}

const done = (outcome: Result<SetupReport>): CliRun => (outcome.ok ? { exitCode: 0, stdout: reportText(outcome.value), stderr: "" } : refused(outcome.error));
const refused = (error: string, stdout = ""): CliRun => ({ exitCode: 1, stdout, stderr: `bounded: ${error}\n` });
const usage = (): CliRun => ({ exitCode: 2, stdout: "", stderr: USAGE });

/** The bounded packages the project depends on: bounded, and every package offering a host installer. */
function boundedPackages(projectRoot: string): Result<readonly { name: string; dev: boolean }[]> {
  try {
    const manifest = readJson(join(projectRoot, "package.json"));
    const groups = (field: string): string[] => {
      const group = manifest[field];
      return isRecord(group) ? Object.keys(group) : [];
    };
    const dev = new Set(groups("devDependencies"));
    const names = [...new Set([...groups("dependencies"), ...dev])].sort();
    const offersInstaller = (name: string): boolean => {
      const exports = readJson(join(projectRoot, "node_modules", name, "package.json")).exports;
      return isRecord(exports) && exports["./host-installer"] !== undefined;
    };
    const chosen = new Set(names.filter((name) => name === "bounded" || offersInstaller(name)));
    chosen.add("bounded");
    return { ok: true, value: [...chosen].sort().map((name) => ({ name, dev: dev.has(name) })) };
  } catch (thrown) {
    return { ok: false, error: `the project's packages cannot be read: ${message(thrown)}` };
  }
}

/** The version of `name` installed in the project, or the reason it cannot be read. */
function installedVersion(projectRoot: string, name: string): Result<string> {
  try {
    const version = readJson(join(projectRoot, "node_modules", name, "package.json")).version;
    return typeof version === "string" ? { ok: true, value: version } : { ok: false, error: `${name}'s package.json names no version` };
  } catch (thrown) {
    return { ok: false, error: `${name} is not installed (${message(thrown)})` };
  }
}

/** One install: the manifest to write first (or none: the manager writes it), the commands, and the check of what they installed. */
interface Installation {
  readonly manifest: Json | null;
  readonly commands: readonly (readonly string[])[];
  /** After the commands: what was installed, for the log, or why it is not what was asked for. */
  readonly check: () => Result<string>;
}

/**
 * Runs `installation` with the project's package manager, then the
 * installed bounded's bin with `handOverArgs`. Any failure before the
 * hand-off restores package.json and the lockfiles.
 */
function installThenHandOver(projectRoot: string, manager: PackageManager, installation: Installation, handOverArgs: readonly string[], run: CommandRunner): CliRun {
  // package.json and every lockfile as they were (undefined: absent), so a failed install can be undone.
  const saved = new Map<string, string | undefined>(
    ["package.json", ...LOCKFILE_NAMES].map((name) => [name, existsSync(join(projectRoot, name)) ? readFileSync(join(projectRoot, name), "utf8") : undefined]),
  );
  /** Puts package.json and the lockfiles back as they were, so a failed install leaves the project's manifest and lock unchanged. */
  const restored = (error: string): CliRun => {
    const lockfiles: string[] = [];
    for (const [name, text] of saved) {
      const path = join(projectRoot, name);
      if (text !== undefined) {
        writeFileSync(path, text);
        if (name !== "package.json") lockfiles.push(name);
      } else if (existsSync(path)) {
        rmSync(path);
        lockfiles.push(`${name} (removed: it did not exist before)`);
      }
    }
    const withLockfiles = lockfiles.length === 0 ? "" : `, with ${lockfiles.join(", ")},`;
    return refused(`${error}\npackage.json was restored${withLockfiles} and the hooks were not changed; if node_modules changed, run your package manager's install to return to the previous versions`);
  };
  if (installation.manifest !== null) writeFileSync(join(projectRoot, "package.json"), `${JSON.stringify(installation.manifest, null, 2)}\n`);
  for (const command of installation.commands) {
    const ran = run(command, projectRoot);
    if (ran.status !== 0) return restored(`${command.join(" ")} failed${ran.error === undefined ? "" : ` (${ran.error})`}:\n${ran.stdout}${ran.stderr}`);
  }
  const installed = installation.check();
  if (!installed.ok) return restored(installed.error);
  const log = `Upgraded ${installed.value} with ${manager}; handing over to the installed bounded.\n`;
  const retry = `bounded ${handOverArgs.join(" ")}`;
  let installedBin: string;
  try {
    const bounded = readJson(join(projectRoot, "node_modules", "bounded", "package.json"));
    const bin = typeof bounded.bin === "string" ? bounded.bin : isRecord(bounded.bin) ? bounded.bin.bounded : undefined;
    if (typeof bin !== "string") throw new Error("it has no bounded bin");
    installedBin = join(projectRoot, "node_modules", "bounded", bin);
  } catch (thrown) {
    return refused(`the installed bounded cannot be run (${message(thrown)}), so the hooks were not set: run \`${retry}\` with it yourself`, log);
  }
  const handedOver = run([process.execPath, installedBin, ...handOverArgs], projectRoot);
  const startError = handedOver.error === undefined ? "" : `bounded: the installed bounded could not be started (${handedOver.error}): run \`${retry}\` yourself\n`;
  return { exitCode: handedOver.status ?? 1, stdout: `${log}${handedOver.stdout}`, stderr: `${handedOver.stderr}${startError}` };
}

/** Each package to install, with the version it must end up at. */
type Wanted = PackageToUpgrade & { readonly version: string };

/** Checks each package is installed at the version wanted, naming them for the log. */
const exactly = (projectRoot: string, wanted: readonly Wanted[], from: string) => (): Result<string> => {
  for (const { name, version } of wanted) {
    const installed = installedVersion(projectRoot, name);
    if (!installed.ok) return installed;
    if (installed.value !== version) return { ok: false, error: `after the install ${name} is version ${installed.value}, not ${version} ${from}` };
  }
  return { ok: true, value: wanted.map(({ name, version }) => `${name} ${version}`).join(", ") };
};

/** The packages to install from the tarballs in `from`, each with its tarball's version. */
function fromTarballs(from: string, packages: readonly { name: string; dev: boolean }[]): Result<readonly Wanted[]> {
  let tarballs: string[];
  try {
    tarballs = readdirSync(from);
  } catch {
    return { ok: false, error: `${from} cannot be read: pass --from a directory holding the packed tarballs (bun pm pack) of ${packages.map(({ name }) => name).join(", ")}` };
  }
  const wanted: Wanted[] = [];
  for (const { name, dev } of packages) {
    const tarball = tarballFor(name, tarballs);
    if (!tarball.ok) return { ok: false, error: `${from}: ${tarball.error}` };
    wanted.push({ name, dev, spec: join(from, tarball.value), version: tarballVersion(name, tarball.value) });
  }
  return { ok: true, value: wanted };
}

/**
 * The installation of `wanted` from local tarballs: the specs and the
 * manager's own override of `bounded` written into package.json (while the
 * npm package `bounded` is the legacy 2.x, a tarball install overrides it),
 * then the manager's plain install.
 */
function tarballInstallation(projectRoot: string, manager: PackageManager, manifest: Json, wanted: readonly Wanted[]): Installation {
  const bounded = wanted.find(({ name }) => name === "bounded");
  const withOverride = bounded === undefined ? manifest : withBoundedOverride(manifest, manager, bounded.spec);
  return { manifest: withUpgradedSpecs(withOverride, wanted), commands: [installCommand(manager)], check: exactly(projectRoot, wanted, "from its tarball") };
}

/** `bounded init [--host <host>]... [--from <dir>]`: add the packages, then hand over to the installed `bounded init --no-install`. */
async function initInstalling(projectRoot: string, from: string | undefined, namedHosts: readonly string[], files: ProjectSetupFiles, run: CommandRunner): Promise<CliRun> {
  const manifestPath = join(projectRoot, "package.json");
  if (!existsSync(manifestPath)) return refused(`${projectRoot} has no package.json: create one (\`npm init -y\`, or your package manager's own), then run this again`);
  const present = await files.configFileNames(projectRoot);
  if (!present.ok) return refused(present.error);
  if (present.value.length > 0) return refused(`${projectRoot} already has ${present.value.join(", ")}: init never overwrites a configuration. Run \`bounded update\` to bring its hooks up to date`);
  const invalid = namedHosts.find((host) => !/^[a-z0-9][a-z0-9-]*$/.test(host));
  if (invalid !== undefined) return refused(`"${invalid}" is not a host name: a host is named by its adapter package without "bounded-", such as claude-code`);
  const hosts = namedHosts.length > 0 ? namedHosts : HOST_DIRECTORIES.filter(([dir]) => existsSync(join(projectRoot, dir))).map(([, host]) => host);
  if (hosts.length === 0) {
    return refused(`no agent host found in ${projectRoot} (${HOST_DIRECTORIES.map(([dir]) => `${dir}/`).join(", ")}): name the hosts you use with --host, such as --host claude-code`);
  }
  const packages = ["bounded", ...new Set(hosts.map((host) => `bounded-${host}`))].map((name) => ({ name, dev: true }));
  const manifest = readJson(manifestPath);
  const manager = packageManagerOf(readdirSync(projectRoot), manifest, process.env.npm_config_user_agent);
  let installation: Installation;
  if (from !== undefined) {
    const wanted = fromTarballs(from, packages);
    if (!wanted.ok) return refused(wanted.error);
    installation = tarballInstallation(projectRoot, manager, manifest, wanted.value);
  } else {
    // From the registry: every package at exactly this CLI's version, so the set is one release.
    const version = ownVersion();
    const wanted = packages.map(({ name, dev }) => ({ name, dev, spec: version, version }));
    installation = { manifest: withUpgradedSpecs(manifest, wanted), commands: [installCommand(manager)], check: exactly(projectRoot, wanted, "this CLI's own") };
  }
  return installThenHandOver(projectRoot, manager, installation, ["init", "--no-install"], run);
}

/**
 * `bounded update` from the registry: the manager upgrades the bounded
 * packages to their latest; afterwards they must be at one version (a
 * release is published in lockstep) and none older than before.
 */
function registryUpgrade(projectRoot: string, manager: PackageManager, packages: readonly { name: string; dev: boolean }[]): Result<Installation> {
  const before = new Map<string, string>();
  for (const { name } of packages) {
    const version = installedVersion(projectRoot, name);
    if (!version.ok) return { ok: false, error: `${version.error}: install the project's dependencies, then run this again` };
    before.set(name, version.value);
  }
  const check = (): Result<string> => {
    const after = new Map<string, string>();
    for (const { name } of packages) {
      const version = installedVersion(projectRoot, name);
      if (!version.ok) return version;
      after.set(name, version.value);
      const previous = before.get(name) ?? version.value;
      if (compareVersions(version.value, previous) < 0) return { ok: false, error: `after the upgrade ${name} is version ${version.value}, older than ${previous}` };
    }
    const versions = new Set(after.values());
    if (versions.size > 1) return { ok: false, error: `after the upgrade the bounded packages are not all at one version (${[...after].map(([name, version]) => `${name} ${version}`).join(", ")}): a release is published in lockstep` };
    return { ok: true, value: [...after].map(([name, version]) => `${name} ${version}`).join(", ") };
  };
  return { ok: true, value: { manifest: null, commands: upgradeToLatestCommands(manager, packages), check } };
}

/** Runs `bounded <args>` in the project at `projectRoot`, running package managers and the installed CLI with `run`. Never throws. */
export async function runBoundedCli(args: readonly string[], projectRoot: string, run: CommandRunner = spawnRunner): Promise<CliRun> {
  try {
    const files = new FileSystemProjectSetupFiles();
    const hostInstallerSource = new NodeModulesHostInstallerSource();
    const [command, ...options] = args;
    if (command === "init") {
      if (options.length === 1 && options[0] === "--no-install") return done(await new InitProjectHandler(files, hostInstallerSource).execute(projectRoot));
      if (options.length % 2 !== 0) return usage();
      const hosts: string[] = [];
      let from: string | undefined;
      for (let at = 0; at < options.length; at += 2) {
        const [name, value] = [options[at], options[at + 1]];
        if (value === undefined) return usage();
        if (name === "--host") hosts.push(value);
        else if (name === "--from" && from === undefined) from = resolve(projectRoot, value);
        else return usage();
      }
      return await initInstalling(projectRoot, from, hosts, files, run);
    }
    if (command !== "update") return usage();
    const refreshOnly = options.length === 1 && options[0] === "--no-upgrade";
    const fromDir = options.length === 2 && options[0] === "--from" ? options[1] : undefined;
    if (!refreshOnly && fromDir === undefined && options.length > 0) return usage();
    const initialised = await requireInitialised(files, projectRoot);
    if (!initialised.ok) return refused(initialised.error);
    if (refreshOnly) return done(await new UpdateProjectHandler(files, hostInstallerSource).execute(projectRoot));
    const packages = boundedPackages(projectRoot);
    if (!packages.ok) return refused(packages.error);
    const manifest = readJson(join(projectRoot, "package.json"));
    const manager = packageManagerOf(readdirSync(projectRoot), manifest, process.env.npm_config_user_agent);
    let installation: Installation;
    if (fromDir !== undefined) {
      const wanted = fromTarballs(resolve(projectRoot, fromDir), packages.value);
      if (!wanted.ok) return refused(wanted.error);
      installation = tarballInstallation(projectRoot, manager, manifest, wanted.value);
    } else {
      const upgrade = registryUpgrade(projectRoot, manager, packages.value);
      if (!upgrade.ok) return refused(upgrade.error);
      installation = upgrade.value;
    }
    return installThenHandOver(projectRoot, manager, installation, ["update", "--no-upgrade"], run);
  } catch (thrown) {
    return refused(`failed: ${message(thrown)}`);
  }
}
