// The `bounded` command (package bounded-cli): `bounded init` and `bounded
// update`, wired to the core's file-system and node_modules adapters.
//
// Both can install packages, then hand over to the bounded-cli they just
// installed, so the rest is always the installed version's own work:
// - `bounded init --from <dir>`, the first install (run through npx before
//   the project has any bounded package), adds bounded, bounded-cli and the
//   hosts' adapter packages, then runs the installed `bounded init`;
// - `bounded update --from <dir>` upgrades them, then runs the installed
//   `bounded update --no-upgrade`.
// Those two hand-offs are the contract between versions: every version
// accepts `bounded init` and `bounded update --no-upgrade`.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FileSystemProjectSetupFiles } from "bounded/adapters/file-system";
import { NodeModulesHostInstallerSource } from "bounded/adapters/system";
import { InitProjectHandler, type ProjectSetupFiles, requireInitialised, type SetupReport, UpdateProjectHandler } from "bounded/application";
import type { Result } from "bounded/domain";
import { type PackageToUpgrade, packageManagerOf, tarballFor, tarballVersion, upgradeCommands, withBoundedOverride, withUpgradedSpecs } from "./package-upgrade.ts";

/** What a run of the CLI printed, and its exit code: 0 done, 1 refused, 2 not understood. */
export interface CliRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export const USAGE = `Usage:
  bounded init --from <dir> [--host <host>]...   first install: add bounded, bounded-cli and each host's adapter package
                                                 (bounded-<host>; by default the hosts whose directory exists: .claude/, .pi/)
                                                 from the tarballs in <dir>, then set bounded up
  bounded init                                   set bounded up: a configuration selecting the core pack, and every host's hooks
  bounded update --from <dir>                    upgrade the bounded packages from the tarballs in <dir>, then refresh every host's hooks
  bounded update --no-upgrade                    refresh every host's hooks to point at the installed version
`;

/** The hosts `bounded init --from` finds by their directory in the project, and the adapter package each is installed with (bounded-<host>). */
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

/** This copy of bounded-cli's version, from its own package.json. */
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

/** The bounded packages the project depends on: bounded, bounded-cli, and every package offering a host installer. */
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
    const chosen = new Set(names.filter((name) => name === "bounded" || name === "bounded-cli" || offersInstaller(name)));
    chosen.add("bounded");
    chosen.add("bounded-cli");
    return { ok: true, value: [...chosen].sort().map((name) => ({ name, dev: dev.has(name) })) };
  } catch (thrown) {
    return { ok: false, error: `the project's packages cannot be read: ${message(thrown)}` };
  }
}

/**
 * Installs `packages` from the tarballs in `from`, checks each installed
 * version is its tarball's, then runs the installed bounded-cli with
 * `handOverArgs`. Any failure before the hand-off restores package.json.
 * `addOverride` makes package.json override `bounded` with its tarball (the
 * first install); otherwise an existing override follows the upgrade.
 */
function installThenHandOver(projectRoot: string, from: string, packages: readonly { name: string; dev: boolean }[], handOverArgs: readonly string[], addOverride: boolean): CliRun {
  let tarballs: string[];
  try {
    tarballs = readdirSync(from);
  } catch {
    return refused(`${from} cannot be read: pass --from a directory holding the packed tarballs (bun pm pack) of ${packages.map(({ name }) => name).join(", ")}`);
  }
  const toInstall: (PackageToUpgrade & { version: string })[] = [];
  for (const { name, dev } of packages) {
    const tarball = tarballFor(name, tarballs);
    if (!tarball.ok) return refused(`${from}: ${tarball.error}`);
    toInstall.push({ name, dev, spec: join(from, tarball.value), version: tarballVersion(name, tarball.value) });
  }
  const manifestPath = join(projectRoot, "package.json");
  const manifestText = readFileSync(manifestPath, "utf8");
  const original = readJson(manifestPath);
  const manager = packageManagerOf(readdirSync(projectRoot), original, process.env.npm_config_user_agent);
  /** Puts package.json back as it was, so a failed install leaves the project's manifest unchanged. */
  const restored = (error: string): CliRun => {
    writeFileSync(manifestPath, manifestText);
    return refused(`${error}\npackage.json was restored and the hooks were not changed; if node_modules changed, run your package manager's install to return to the previous versions`);
  };
  const bounded = toInstall.find(({ name }) => name === "bounded");
  const boundedSpec = bounded === undefined ? null : `file:${bounded.spec}`;
  // While the npm package `bounded` is the legacy 2.x, a project installing from tarballs overrides it with the local one.
  const withOverride = addOverride && boundedSpec !== null ? { ...original, overrides: { ...(isRecord(original.overrides) ? original.overrides : {}), bounded: boundedSpec } } : original;
  let manifest = withBoundedOverride(withOverride, boundedSpec);
  let commands = upgradeCommands(manager, toInstall);
  if (manager === "bun") {
    // bun's `add` cannot replace one tarball dependency with another; install from the rewritten manifest (package-upgrade.ts).
    manifest = withUpgradedSpecs(manifest, toInstall);
    commands = [["bun", "install"]];
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  for (const command of commands) {
    const [program = manager, ...args] = command;
    const ran = spawnSync(program, args, { cwd: projectRoot, encoding: "utf8" });
    if (ran.status !== 0) return restored(`${command.join(" ")} failed${ran.error === undefined ? "" : ` (${ran.error.message})`}:\n${ran.stdout ?? ""}${ran.stderr ?? ""}`);
  }
  for (const { name, version } of toInstall) {
    let installed: unknown;
    try {
      installed = readJson(join(projectRoot, "node_modules", name, "package.json")).version;
    } catch (thrown) {
      return restored(`${name} is not installed after the upgrade (${message(thrown)})`);
    }
    if (installed !== version) return restored(`after the upgrade ${name} is version ${String(installed)}, not ${version} from its tarball`);
  }
  const log = `Upgraded ${toInstall.map(({ name, version }) => `${name} ${version}`).join(", ")} with ${manager}; handing over to the installed bounded-cli.\n`;
  const retry = `bounded ${handOverArgs.join(" ")}`;
  let installedBin: string;
  try {
    const installed = readJson(join(projectRoot, "node_modules", "bounded-cli", "package.json"));
    const bin = typeof installed.bin === "string" ? installed.bin : isRecord(installed.bin) ? installed.bin.bounded : undefined;
    if (typeof bin !== "string") throw new Error("it has no bounded bin");
    installedBin = join(projectRoot, "node_modules", "bounded-cli", bin);
  } catch (thrown) {
    return refused(`the installed bounded-cli cannot be run (${message(thrown)}), so the hooks were not set: run \`${retry}\` with it yourself`, log);
  }
  const handedOver = spawnSync(process.execPath, [installedBin, ...handOverArgs], { cwd: projectRoot, encoding: "utf8" });
  const spawnError = handedOver.error === undefined ? "" : `bounded: the installed bounded-cli could not be started (${handedOver.error.message}): run \`${retry}\` yourself\n`;
  return { exitCode: handedOver.status ?? 1, stdout: `${log}${handedOver.stdout ?? ""}`, stderr: `${handedOver.stderr ?? ""}${spawnError}` };
}

/** `bounded init --from <dir> [--host <host>]...`: add the packages, then hand over to the installed `bounded init`. */
async function initFrom(projectRoot: string, from: string, namedHosts: readonly string[], files: ProjectSetupFiles): Promise<CliRun> {
  if (!existsSync(join(projectRoot, "package.json"))) return refused(`${projectRoot} has no package.json: create one (\`npm init -y\`, or your package manager's own), then run this again`);
  const present = await files.configFileNames(projectRoot);
  if (!present.ok) return refused(present.error);
  if (present.value.length > 0) return refused(`${projectRoot} already has ${present.value.join(", ")}: init never overwrites a configuration. Run \`bounded update\` to bring its hooks up to date`);
  const invalid = namedHosts.find((host) => !/^[a-z0-9][a-z0-9-]*$/.test(host));
  if (invalid !== undefined) return refused(`"${invalid}" is not a host name: a host is named by its adapter package without "bounded-", such as claude-code`);
  const hosts = namedHosts.length > 0 ? namedHosts : HOST_DIRECTORIES.filter(([dir]) => existsSync(join(projectRoot, dir))).map(([, host]) => host);
  if (hosts.length === 0) {
    return refused(`no agent host found in ${projectRoot} (${HOST_DIRECTORIES.map(([dir]) => `${dir}/`).join(", ")}): name the hosts you use with --host, such as --host claude-code`);
  }
  const packages = ["bounded", "bounded-cli", ...new Set(hosts.map((host) => `bounded-${host}`))].map((name) => ({ name, dev: true }));
  return installThenHandOver(projectRoot, from, packages, ["init"], true);
}

/** Runs `bounded <args>` in the project at `projectRoot`. Never throws. */
export async function runBoundedCli(args: readonly string[], projectRoot: string): Promise<CliRun> {
  try {
    const files = new FileSystemProjectSetupFiles();
    const hostInstallerSource = new NodeModulesHostInstallerSource();
    const [command, ...options] = args;
    if (command === "init") {
      if (options.length === 0) return done(await new InitProjectHandler(files, hostInstallerSource).execute(projectRoot));
      const [flag, from, ...rest] = options;
      if (flag !== "--from" || from === undefined || rest.length % 2 !== 0) return usage();
      const hosts: string[] = [];
      for (let at = 0; at < rest.length; at += 2) {
        const [name, value] = [rest[at], rest[at + 1]];
        if (name !== "--host" || value === undefined) return usage();
        hosts.push(value);
      }
      return await initFrom(projectRoot, resolve(projectRoot, from), hosts, files);
    }
    if (command !== "update") return usage();
    const refreshOnly = options.length === 1 && options[0] === "--no-upgrade";
    const fromDir = options.length === 2 && options[0] === "--from" ? options[1] : undefined;
    if (!refreshOnly && fromDir === undefined && options.length > 0) return usage();
    const initialised = await requireInitialised(files, projectRoot);
    if (!initialised.ok) return refused(initialised.error);
    if (refreshOnly) return done(await new UpdateProjectHandler(files, hostInstallerSource).execute(projectRoot));
    if (fromDir === undefined) {
      return refused(
        "the bounded packages are not published to the npm registry yet (`bounded` there is still the legacy harness, 2.x; ADR 2026-014), so update cannot fetch a newer version by itself. Pass --from <directory> holding the packed tarballs, or run `bounded update --no-upgrade` to refresh the hooks from the installed version",
      );
    }
    const packages = boundedPackages(projectRoot);
    if (!packages.ok) return refused(packages.error);
    return installThenHandOver(projectRoot, resolve(projectRoot, fromDir), packages.value, ["update", "--no-upgrade"], false);
  } catch (thrown) {
    return refused(`failed: ${message(thrown)}`);
  }
}
