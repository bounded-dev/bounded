// The `bounded` command: `bounded init` and `bounded update`, wired to the
// file-system and node_modules adapters.
//
// `bounded update` upgrades the project's bounded packages, then hands over
// to the CLI it just installed, running `bounded update --no-upgrade`, so the
// refresh is always the new version's own. That hand-off is the contract
// between versions: every version accepts `bounded update --no-upgrade`.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InitProjectHandler, requireInitialised, type SetupReport, UpdateProjectHandler } from "bounded/application";
import { FileSystemProjectSetupFiles } from "bounded/adapters/file-system";
import { NodeModulesHostInstallerSource } from "bounded/adapters/system";
import type { Result } from "bounded/domain";
import { type PackageToUpgrade, packageManagerFor, tarballFor, upgradeCommands, withUpgradedSpecs } from "./package-upgrade.ts";

/** What a run of the CLI printed, and its exit code: 0 done, 1 refused, 2 not understood. */
export interface CliRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export const USAGE = `Usage:
  bounded init                      set bounded up in this project: a configuration selecting the core pack, and every host's hooks
  bounded update --from <dir>       upgrade the bounded packages from the tarballs in <dir>, then refresh every host's hooks
  bounded update --no-upgrade       refresh every host's hooks to point at the installed version
`;

type Json = Readonly<Record<string, unknown>>;
const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

function readJson(path: string): Json {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) throw new Error(`${path} is not a JSON object`);
  return parsed;
}

/** This copy of bounded's version, from its own package.json. */
function ownVersion(): string {
  const version = readJson(fileURLToPath(new URL("../../package.json", import.meta.url))).version;
  return typeof version === "string" ? version : "(unknown version)";
}

const RESTART = "Restart each agent host's session in this project (start a new session) so it loads the hooks.";

function describe(report: SetupReport): string {
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

const done = (outcome: Result<SetupReport>): CliRun => (outcome.ok ? { exitCode: 0, stdout: describe(outcome.value), stderr: "" } : refused(outcome.error));
const refused = (error: string, stdout = ""): CliRun => ({ exitCode: 1, stdout, stderr: `bounded: ${error}\n` });

/** The bounded packages the project depends on: bounded itself, and every package offering a host installer. */
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
    const chosen = names.filter((name) => name === "bounded" || offersInstaller(name));
    if (!chosen.includes("bounded")) chosen.unshift("bounded");
    return { ok: true, value: chosen.map((name) => ({ name, dev: dev.has(name) })) };
  } catch (thrown) {
    return { ok: false, error: `the project's packages cannot be read: ${thrown instanceof Error ? thrown.message : String(thrown)}` };
  }
}

/** Upgrades the bounded packages from the tarballs in `from`, then runs the newly installed CLI's `update --no-upgrade`. */
function upgradeThenHandOver(projectRoot: string, from: string): CliRun {
  const packages = boundedPackages(projectRoot);
  if (!packages.ok) return refused(packages.error);
  let tarballs: string[];
  try {
    tarballs = readdirSync(from);
  } catch {
    return refused(`${from} cannot be read: pass --from a directory holding the packed tarballs (bun pm pack) of ${packages.value.map(({ name }) => name).join(", ")}`);
  }
  const toUpgrade: PackageToUpgrade[] = [];
  for (const { name, dev } of packages.value) {
    const tarball = tarballFor(name, tarballs);
    if (!tarball.ok) return refused(`${from}: ${tarball.error}`);
    toUpgrade.push({ name, dev, spec: join(from, tarball.value) });
  }
  const manager = packageManagerFor(readdirSync(projectRoot));
  const log: string[] = [];
  let commands = upgradeCommands(manager, toUpgrade);
  if (manager === "bun") {
    // bun's `add` cannot replace one tarball dependency with another; install from the rewritten manifest (package-upgrade.ts).
    const manifestPath = join(projectRoot, "package.json");
    writeFileSync(manifestPath, `${JSON.stringify(withUpgradedSpecs(readJson(manifestPath), toUpgrade), null, 2)}\n`);
    commands = [["bun", "install"]];
  }
  for (const command of commands) {
    const [program = manager, ...args] = command;
    const ran = spawnSync(program, args, { cwd: projectRoot, encoding: "utf8" });
    if (ran.status !== 0) return refused(`${command.join(" ")} failed${ran.error === undefined ? "" : ` (${ran.error.message})`}; the hooks were not changed:\n${ran.stdout ?? ""}${ran.stderr ?? ""}`, log.join(""));
  }
  log.push(`Upgraded ${toUpgrade.map(({ name }) => name).join(", ")} with ${manager}; handing over to the installed bounded.\n`);
  let installedBin: string;
  try {
    const installed = readJson(join(projectRoot, "node_modules", "bounded", "package.json"));
    const bin = typeof installed.bin === "string" ? installed.bin : isRecord(installed.bin) ? installed.bin.bounded : undefined;
    if (typeof bin !== "string") throw new Error("it has no bounded bin");
    installedBin = join(projectRoot, "node_modules", "bounded", bin);
  } catch (thrown) {
    return refused(`the installed bounded cannot be run (${thrown instanceof Error ? thrown.message : String(thrown)}): run \`bounded update --no-upgrade\` with it yourself`, log.join(""));
  }
  const handedOver = spawnSync(process.execPath, [installedBin, "update", "--no-upgrade"], { cwd: projectRoot, encoding: "utf8" });
  return { exitCode: handedOver.status ?? 1, stdout: `${log.join("")}${handedOver.stdout ?? ""}`, stderr: handedOver.stderr ?? (handedOver.error === undefined ? "" : `bounded: ${handedOver.error.message}\n`) };
}

/** Runs `bounded <args>` in the project at `projectRoot`. Never throws. */
export async function runBoundedCli(args: readonly string[], projectRoot: string): Promise<CliRun> {
  try {
    const files = new FileSystemProjectSetupFiles();
    const installers = new NodeModulesHostInstallerSource();
    const [command, ...options] = args;
    if (command === "init" && options.length === 0) return done(await new InitProjectHandler(files, installers).execute(projectRoot));
    if (command !== "update") return { exitCode: 2, stdout: "", stderr: USAGE };
    const refreshOnly = options.length === 1 && options[0] === "--no-upgrade";
    const fromDir = options.length === 2 && options[0] === "--from" ? options[1] : undefined;
    if (!refreshOnly && fromDir === undefined && options.length > 0) return { exitCode: 2, stdout: "", stderr: USAGE };
    const initialised = await requireInitialised(files, projectRoot);
    if (!initialised.ok) return refused(initialised.error);
    if (refreshOnly) return done(await new UpdateProjectHandler(files, installers).execute(projectRoot));
    if (fromDir === undefined) {
      return refused(
        "the bounded packages are not published to the npm registry yet (the name `bounded` there belongs to another package), so update cannot fetch a newer version by itself. Pass --from <directory> holding the packed tarballs, or run `bounded update --no-upgrade` to refresh the hooks from the installed version",
      );
    }
    return upgradeThenHandOver(projectRoot, resolve(projectRoot, fromDir));
  } catch (thrown) {
    return refused(`failed: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
  }
}
