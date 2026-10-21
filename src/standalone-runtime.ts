import * as domain from "bounded/domain";
import * as application from "bounded/application";
import type { HostInstallReport } from "bounded/application";
import type { Result } from "bounded/domain";
import * as adapters from "bounded/adapters";
import * as project from "bounded/open-project";
import * as prereqs from "bounded/prereqs";
import * as prereqsAdapters from "bounded/prereqs/adapters";
import * as protectedPaths from "bounded/protected-paths";
import * as protectedPathsAdapters from "bounded/protected-paths/adapters";
import { shellCommandReader } from "./cli/standalone-shell-command-reader.ts";
import { acquireManagedPackWriter, addManagedPackWithProjection, captureManagedPackRuntimeGraph,
  prepareManagedPackTargetProjectionUnderWriter, verifyManagedPackUpdateProjectionSnapshot,
  type ManagedPackReleaseTypes, type ManagedPackRuntimeGraph, type ManagedPackWriter, type ProjectionInput } from "./cli/managed-pack-installer.ts";
import { locateInstalledRelease, userDataRoot } from "./standalone-installed-release.ts";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { buildStandaloneConfigModule } from "./hosts/claude-code/standalone-config-as-module.ts";
import { prepareStandaloneProjectSnapshot, disposeStandaloneProjectSnapshot, standaloneManagedConfigSource, checkStandaloneProjectSnapshot } from "bounded/adapters";
import { validateProjectWiring } from "bounded/application";
import { protectedPathsPortProvisions } from "bounded/protected-paths/adapters";
import { prereqsPortProvisions, prereqsStatusSnapshotPortProvisions } from "bounded/prereqs/adapters";
import { verifiedStandaloneTypeEnvironment } from "./cli/standalone-type-environment.ts";
import { prepareStandaloneClaudeHooks, verifyStandaloneClaudeHookTransition } from "./hosts/claude-code/standalone-install.ts";
import { prepareStandalonePiExtension } from "./hosts/pi/standalone-install.ts";
import { standalonePiLoader } from "./hosts/pi/standalone-install.ts";
import { piLoader } from "./hosts/pi/install.ts";
import { isBoundedHook } from "./hosts/claude-code/install.ts";
import { runStandalonePiWorker } from "./hosts/pi/standalone-worker.ts";
import { INITIAL_CONFIG } from "./cli/initial-config.ts";
import { acquireStandaloneUpdateWriter } from "./standalone-update-writer.ts";
import { captureInstalledNpmClosure, reverifyInstalledNpmClosure, type NpmClosureSnapshot } from "./standalone-npm-closure.ts";
import { captureStandaloneUpdateFile, createStandaloneRollbackJournal, createStandaloneUpdateJournal,
  publishStandaloneUpdate, readStandaloneRollbackRecord, recoverStandaloneUpdate,
  type StandaloneUpdateFile, type StandaloneUpdateJournal, type StandaloneUpdateVerifiers } from "./standalone-update-transaction.ts";

const commandRoutes = {
  hook: "host-hook",
  init: "project-setup",
  update: "unavailable",
  check: "project-check",
  host: "unavailable",
  catalog: "unavailable",
  add: "managed-add",
} as const;

const standaloneRuntimeExports = Object.freeze({
  "bounded/domain": domain,
  "bounded/application": application,
  "bounded/adapters": adapters,
  "bounded/open-project": project,
  "bounded/prereqs": prereqs,
  "bounded/prereqs/adapters": prereqsAdapters,
  "bounded/protected-paths": protectedPaths,
  "bounded/protected-paths/adapters": protectedPathsAdapters,
  "bounded/shell-command-reader": shellCommandReader,
});

function refusal(reason: string): void {
  process.stderr.write(`bounded: ${reason}\n`);
  process.exitCode = 2;
}

function releaseIdentity(version: string): boolean {
  const path = join(dirname(process.execPath), "..", "release.json");
  try {
    const details = lstatSync(path);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error("not a regular file");
    const identity: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof identity !== "object" || identity === null || Array.isArray(identity)) throw new Error("not an object");
    const fields = identity as Record<string, unknown>;
    if (Object.keys(fields).sort().join() !== ["version", "target", "sourceCommit", "protocolVersion"].sort().join()
      || fields.version !== version || typeof fields.target !== "string"
      || !/^(darwin|windows)-(x64|arm64)$|^linux-(x64|arm64)-(gnu|musl)$/.test(fields.target)
      || typeof fields.sourceCommit !== "string" || !/^[a-f0-9]{16,40}$/.test(fields.sourceCommit)
      || fields.protocolVersion !== 1) throw new Error("invalid identity");
    return true;
  } catch {
    refusal(`the standalone release.json beside this executable is missing or malformed; reinstall Bounded ${version}`);
    return false;
  }
}

function requestedHosts(args: readonly string[]): string[] | null {
  const named: string[] = [];
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const host = args[index + 1];
    if (flag !== "--host" || host === undefined || !/^[a-z0-9][a-z0-9-]*$/.test(host)) {
      refusal(`unsupported standalone init option ${flag ?? "(missing)"}; use --host <host>`);
      return null;
    }
    named.push(host);
  }
  return [...new Set(named)];
}

export interface PreparedStandaloneHostStep {
  readonly host: string;
  readonly install: () => Promise<Result<HostInstallReport>>;
  readonly restore: () => Promise<void>;
}

export interface InstalledStandaloneHostStep extends PreparedStandaloneHostStep {
  readonly report: HostInstallReport;
}

export async function restoreInstalledStandaloneHosts(installedHosts: readonly Pick<InstalledStandaloneHostStep, "host" | "restore">[]): Promise<readonly string[]> {
  const failures: string[] = [];
  for (const host of [...installedHosts].reverse()) {
    try { await host.restore(); }
    catch (error) {
      failures.push(`${host.host}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failures;
}

/** Commit prepared host wiring, restoring only state this attempt owns on failure. */
export async function installPreparedStandaloneHosts(preparedHosts: readonly PreparedStandaloneHostStep[]): Promise<Result<readonly InstalledStandaloneHostStep[]>> {
  const installedHosts: InstalledStandaloneHostStep[] = [];
  for (const prepared of preparedHosts) {
    const installed = await prepared.install();
    if (!installed.ok) {
      const failures = await restoreInstalledStandaloneHosts(installedHosts);
      return failures.length === 0 ? installed
        : { ok: false, error: `${installed.error}; host rollback failed: ${failures.join("; ")}` };
    }
    installedHosts.push({ ...prepared, report: installed.value });
  }
  return { ok: true, value: installedHosts };
}

async function initStandalone(args: readonly string[], version: string): Promise<void> {
  if (!releaseIdentity(version)) return;
  const hosts = requestedHosts(args);
  if (hosts === null) return;
  const projectRoot = process.cwd();
  const selectedHosts = hosts.length > 0 ? hosts : (() => {
    const found: string[] = [];
    for (const [directory, host] of [[".claude", "claude-code"], [".pi", "pi"]] as const) {
      try { if (lstatSync(join(projectRoot, directory)).isDirectory()) found.push(host); }
      catch { /* The named host installer reports an explicit request's missing directory. */ }
    }
    return found;
  })();
  if (selectedHosts.length === 0 || selectedHosts.some((host) => host !== "claude-code" && host !== "pi")) {
    refusal(selectedHosts.length > 0
      ? `${selectedHosts.join(", ")} host installer is unavailable in this standalone release; install a release carrying that host before init`
      : "no host installer is available in this standalone release; install a release carrying your host before init");
    return;
  }
  const { FileSystemProjectSetupFiles } = adapters;
  const { InitProjectHandler } = application;
  const files = new FileSystemProjectSetupFiles();
  const existing = await files.configFileNames(projectRoot);
  if (!existing.ok) { refusal(existing.error); return; }
  if (existing.value.length > 0) {
    refusal(`${projectRoot} already has ${existing.value.join(", ")}: init never overwrites a configuration. Run bounded update to refresh its hooks`);
    return;
  }
  const pinPath = join(projectRoot, ".bounded", "version.json");
  try { lstatSync(pinPath); refusal(`${pinPath} already exists; init will not replace its version pin`); return; }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) { refusal(`${pinPath} cannot be inspected`); return; } }
  const preparedHosts: PreparedStandaloneHostStep[] = [];
  // Prepare every host before writing either one, so a user-owned file on the
  // second host cannot leave a half-installed first host.
  for (const host of selectedHosts) {
    const prepared = host === "claude-code"
      ? await prepareStandaloneClaudeHooks(projectRoot, process.execPath)
      : await prepareStandalonePiExtension(projectRoot, process.execPath);
    if (!prepared.ok) { refusal(prepared.error); return; }
    preparedHosts.push({ host, install: prepared.value.install, restore: prepared.value.restore });
  }
  const installed = await installPreparedStandaloneHosts(preparedHosts);
  if (!installed.ok) { refusal(installed.error); return; }
  const installedHosts = installed.value;
  const restoreInstalled = async (): Promise<void> => {
    const failures = await restoreInstalledStandaloneHosts(installedHosts);
    if (failures.length > 0) throw new Error(failures.join("; "));
  };
  const setup = await new InitProjectHandler(files, { load: async () => ({ ok: true, value: installedHosts.map(({ host, report }) => ({ host, install: async () => ({ ok: true as const, value: report }) })) }) }, INITIAL_CONFIG).execute(projectRoot);
  if (!setup.ok) {
    try { await restoreInstalled(); }
    catch (error) { refusal(`${setup.error}; settings rollback failed: ${error instanceof Error ? error.message : String(error)}`); return; }
    refusal(setup.error);
    return;
  }
  const staged = join(projectRoot, ".bounded", `.version-${randomUUID()}.tmp`);
  try {
    await mkdir(dirname(pinPath), { recursive: true });
    await writeFile(staged, `${JSON.stringify({ schema: "bounded-project-version/1", version })}\n`, { flag: "wx" });
    await rename(staged, pinPath);
  } catch (error) {
    await rm(staged, { force: true });
    const reason = error instanceof Error ? error.message : String(error);
    const rollbackFailures: string[] = [];
    try { await rm(join(projectRoot, setup.value.configWritten ?? "bounded.config.ts")); }
    catch (rollbackError) { rollbackFailures.push(`configuration: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`); }
    rollbackFailures.push(...await restoreInstalledStandaloneHosts(installedHosts));
    if (rollbackFailures.length > 0) {
      refusal(`the project version pin could not be written: ${reason}; setup rollback failed: ${rollbackFailures.join("; ")}; installed hooks remain fail closed`);
      return;
    }
    refusal(`the project version pin could not be written: ${reason}; settings and configuration were restored`);
    return;
  }
  process.stdout.write(`Bounded ${version} initialized for ${selectedHosts.map((host) => host === "pi" ? "Pi" : "Claude Code").join(" and ")}\n`);
}

function embeddedWasmPath(name: "tree-sitter" | "tree-sitter-bash"): string {
  const pattern = name === "tree-sitter" ? /^tree-sitter-[a-z0-9]+\.wasm$/ : /^tree-sitter-bash-[a-z0-9]+\.wasm$/;
  const file = Bun.embeddedFiles.find((candidate) => pattern.test(Reflect.get(candidate, "name")));
  const filename: unknown = file === undefined ? undefined : Reflect.get(file, "name");
  if (typeof filename !== "string") throw new Error(`the standalone executable does not contain ${name}.wasm`);
  return join(import.meta.dir, filename);
}

function prepareStandaloneRuntime(version: string): void {
  Object.defineProperty(globalThis, "__boundedStandaloneReleaseIdentityLoader", {
    value: () => {
      const located = locateInstalledRelease(version);
      if (!located.ok) throw new Error(located.error);
      return located.manifestSha256;
    }, configurable: false, writable: false,
  });
  Object.defineProperty(globalThis, "__boundedStandaloneWasmPaths", {
    value: Object.freeze({ engine: embeddedWasmPath("tree-sitter"), grammar: embeddedWasmPath("tree-sitter-bash") }),
    configurable: false,
    writable: false,
  });
  Object.defineProperty(globalThis, "__boundedStandaloneConfigLoader", {
    value: buildStandaloneConfigModule,
    configurable: false,
    writable: false,
  });
  Object.defineProperty(globalThis, "__boundedStandaloneManagedGraphLoader", {
    value: async (projectRoot: string, selectedReleaseManifestSha256: string) => {
      const bounded = join(projectRoot, ".bounded");
      const has = (name: string): boolean => {
        try { lstatSync(join(bounded, name)); return true; }
        catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error; }
      };
      if (!["packs.lock.json", "types-receipt.json", "types-journal.json"].some(has)) return undefined;
      const located = locateInstalledRelease(version);
      if (!located.ok) throw new Error(located.error);
      if (located.manifestSha256 !== selectedReleaseManifestSha256)
        throw new Error("the installed Bounded release changed during snapshot selection; retry the hook");
      const releaseTypeFilesFromVerifiedManifest = Object.fromEntries(located.verifiedFiles
        .filter((file) => file.path.startsWith("share/types/") && file.path.endsWith(".d.ts"))
        .map((file) => [file.path.slice("share/types/".length), file.sha256]));
      const captured = await captureManagedPackRuntimeGraph({ projectRoot, boundedVersion: version,
        boundedExportPaths: Object.keys(standaloneRuntimeExports).map((specifier) => `.${specifier.slice("bounded".length)}`),
        storeRoot: join(userDataRoot(), "packs", "store"), releaseTypesRoot: join(located.releaseRoot, "share", "types"),
        releaseTypeFilesFromVerifiedManifest });
      if (!captured.ok) throw new Error(captured.error);
      return captured.value;
    }, configurable: false, writable: false,
  });
  // Runtime-built configs and local packs use these exact module objects, so
  // nominal brands and pack dependencies match the executable's own core.
  Object.defineProperty(globalThis, "__boundedStandaloneRuntimeExports", {
    value: standaloneRuntimeExports,
    configurable: false,
    writable: false,
  });
}

export async function runStandaloneRuntime(args: readonly string[], version: string, hostProjectRoot?: string): Promise<void> {
  const [command, host] = args;
  if (command === "hook" && host === "pi") {
    if (hostProjectRoot === undefined) { refusal("Pi hook requires an absolute project root"); return; }
    prepareStandaloneRuntime(version);
    await runStandalonePiWorker(hostProjectRoot, version, {
      capture: async () => {
        const located = locateInstalledRelease(version);
        if (!located.ok) throw new Error(located.error);
        const projectBounded = join(hostProjectRoot, ".bounded");
        const has = (name: string): boolean => {
          try { lstatSync(join(projectBounded, name)); return true; }
          catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error; }
        };
        const hasManagedState = ["packs.lock.json", "types-receipt.json", "types-journal.json"].some(has);
        const managedGraph = hasManagedState ? await captureManagedPackRuntimeGraph({
          projectRoot: hostProjectRoot, boundedVersion: version,
          boundedExportPaths: Object.keys(standaloneRuntimeExports).map((specifier) => `.${specifier.slice("bounded".length)}`),
          storeRoot: join(userDataRoot(), "packs", "store"), releaseTypesRoot: join(located.releaseRoot, "share", "types"),
          releaseTypeFilesFromVerifiedManifest: Object.fromEntries(located.verifiedFiles
            .filter((file) => file.path.startsWith("share/types/") && file.path.endsWith(".d.ts"))
            .map((file) => [file.path.slice("share/types/".length), file.sha256])),
        }) : undefined;
        if (managedGraph !== undefined && !managedGraph.ok) throw new Error(managedGraph.error);
        const configFile = join(hostProjectRoot, "bounded.config.ts");
        const info = lstatSync(configFile);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error("bounded.config.ts is linked or not a file");
        return prepareStandaloneProjectSnapshot(configFile, hostProjectRoot, {
          verifiedReleaseManifestSha256: located.manifestSha256,
          boundedRuntimeExports: standaloneRuntimeExports,
          ...(managedGraph === undefined ? {} : { managedGraph: managedGraph.value }),
        });
      },
      configSource: (snapshot) => standaloneManagedConfigSource(async () => snapshot.modulePath),
      dispose: disposeStandaloneProjectSnapshot,
    });
    return;
  }
  if (command === "hook" && host === "claude-code") {
    prepareStandaloneRuntime(version);
    if (hostProjectRoot !== undefined) process.env.CLAUDE_PROJECT_DIR = hostProjectRoot;
    // The host entry owns the fail-closed wire response, including bootstrap failures.
    await import("./hosts/claude-code/main.ts");
    return;
  }
  if (command === "add") {
    await addStandalone(args, version);
    return;
  }
  if (command === "check") {
    await checkStandalone(args, version);
    return;
  }
  if (command === "update") {
    await updateStandalone(args, version);
    return;
  }
  const route = commandRoutes[command as keyof typeof commandRoutes];
  if (route === "project-setup") {
    await initStandalone(args, version);
    return;
  }
  refusal(`unsupported standalone command ${JSON.stringify(args.join(" ") || "(none)")}; this release has no handler for it`);
}

async function checkStandalone(args: readonly string[], version: string): Promise<void> {
  if (args.length !== 1) { refusal("Use bounded check from an initialized project"); return; }
  const projectRoot = process.cwd();
  const pinPath = join(projectRoot, ".bounded", "version.json");
  try {
    const pinInfo = lstatSync(pinPath);
    if (!pinInfo.isFile() || pinInfo.isSymbolicLink()) throw new Error("version pin is linked or not a file");
    const parsed: unknown = JSON.parse(readFileSync(pinPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
      || Reflect.get(parsed, "schema") !== "bounded-project-version/1" || Reflect.get(parsed, "version") !== version
      || Object.keys(parsed).sort().join() !== "schema,version") throw new Error("version pin differs from this executable");
  } catch (error) { refusal(`bounded check requires this project's exact .bounded/version.json pin; run bounded init or repair the pin: ${error instanceof Error ? error.message : String(error)}`); return; }
  if (!releaseIdentity(version)) return;
  const located = locateInstalledRelease(version);
  if (!located.ok) { refusal(located.error); return; }
  try {
    const hasHostDirectory = (name: string): boolean => {
      try {
        const info = lstatSync(join(projectRoot, name));
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${name} is linked or not a directory`);
        return true;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
      }
    };
    const hasClaudeHost = hasHostDirectory(".claude");
    const hasPiHost = hasHostDirectory(".pi");
    if (!hasClaudeHost && !hasPiHost) throw new Error("no installed Bounded host wiring was found; run bounded init --host <host>");
    if (hasClaudeHost) {
      const claudeHooks = await prepareStandaloneClaudeHooks(projectRoot, process.execPath);
      if (!claudeHooks.ok) throw new Error(`Claude Code host wiring cannot be inspected: ${claudeHooks.error}`);
      const claudeInstalled = claudeHooks.value.originalBytes !== null
        && JSON.stringify(JSON.parse(claudeHooks.value.originalBytes)) === JSON.stringify(JSON.parse(claudeHooks.value.nextBytes));
      if (!claudeInstalled) throw new Error("Claude Code host wiring differs from this release; run bounded update or repair its hooks");
    }
    if (hasPiHost) {
      const piExtension = await prepareStandalonePiExtension(projectRoot, process.execPath);
      if (!piExtension.ok) throw new Error(`Pi host wiring cannot be inspected: ${piExtension.error}`);
      if (piExtension.value.originalBytes === null || piExtension.value.originalBytes !== piExtension.value.nextBytes)
        throw new Error("Pi host loader differs from this release; run bounded update or repair its loader");
    }
    const declaredTypeEnvironment = located.verifiedFiles.find((file) => file.path === "share/typescript/type-environment.json");
    if (declaredTypeEnvironment === undefined) throw new Error("installed release lacks its TypeScript declaration manifest; reinstall Bounded");
    const environment = await verifiedStandaloneTypeEnvironment(located.releaseRoot, declaredTypeEnvironment.sha256);
    const boundedDeclarations: Record<string, Uint8Array> = {};
    for (const file of located.verifiedFiles) {
      if (!file.path.startsWith("share/types/") || !file.path.endsWith(".d.ts")) continue;
      const bytes = readFileSync(join(located.releaseRoot, file.path));
      if (bytes.byteLength !== file.size || createHash("sha256").update(bytes).digest("hex") !== file.sha256)
        throw new Error(`installed Bounded declaration ${file.path} changed after release verification; reinstall Bounded`);
      boundedDeclarations[file.path.slice("share/types/".length)] = bytes;
    }
    const bounded = join(projectRoot, ".bounded");
    const has = (name: string): boolean => {
      try { lstatSync(join(bounded, name)); return true; }
      catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error; }
    };
    const hasManagedState = ["packs.lock.json", "types-receipt.json", "types-journal.json"].some(has);
    const managedGraph = hasManagedState ? await captureManagedPackRuntimeGraph({ projectRoot, boundedVersion: version,
      boundedExportPaths: Object.keys(standaloneRuntimeExports).map((specifier) => `.${specifier.slice("bounded".length)}`),
      storeRoot: join(userDataRoot(), "packs", "store"), releaseTypesRoot: join(located.releaseRoot, "share", "types"),
      releaseTypeFilesFromVerifiedManifest: Object.fromEntries(located.verifiedFiles
        .filter((file) => file.path.startsWith("share/types/") && file.path.endsWith(".d.ts"))
        .map((file) => [file.path.slice("share/types/".length), file.sha256])) }) : undefined;
    if (managedGraph !== undefined && !managedGraph.ok) throw new Error(managedGraph.error);
    const configFile = join(projectRoot, "bounded.config.ts");
    let configInfo: ReturnType<typeof lstatSync>;
    try { configInfo = lstatSync(configFile); }
    catch { throw new Error("bounded.config.ts is missing or unreadable in this project"); }
    if (!configInfo.isFile() || configInfo.isSymbolicLink()) throw new Error("bounded.config.ts is missing, linked, or not a regular configuration file");
    const snapshot = await prepareStandaloneProjectSnapshot(configFile, projectRoot, {
      verifiedReleaseManifestSha256: located.manifestSha256, boundedRuntimeExports: standaloneRuntimeExports,
      ...(managedGraph === undefined ? {} : { managedGraph: managedGraph.value }),
    });
    try {
      const checked = await checkStandaloneProjectSnapshot(snapshot, { ...environment, boundedDeclarations });
      for (const diagnostic of checked.diagnostics) process.stderr.write(`${diagnostic}\n`);
      if (!checked.ok) { process.exitCode = 2; return; }
      const loaded = await standaloneManagedConfigSource(async () => snapshot.modulePath).load(projectRoot);
      if (!loaded.ok) { refusal(loaded.error); return; }
      const sharedPortProvisions = [...protectedPathsPortProvisions(), ...prereqsPortProvisions()];
      const installedHostProvisions = [
        ...(hasClaudeHost ? [{ host: "Claude Code", provisions: [...sharedPortProvisions, ...prereqsStatusSnapshotPortProvisions()] }] : []),
        ...(hasPiHost ? [{ host: "Pi", provisions: sharedPortProvisions }] : []),
      ];
      for (const { host, provisions } of installedHostProvisions) {
        const wired = validateProjectWiring(loaded.value, projectRoot, provisions);
        if (!wired.ok) { refusal(`${host}: ${wired.error}`); return; }
      }
      process.stdout.write(`Bounded configuration checked for ${[hasClaudeHost ? "Claude Code" : null, hasPiHost ? "Pi" : null].filter(Boolean).join(" and ")}\n`);
    } finally { disposeStandaloneProjectSnapshot(snapshot); }
  } catch (error) { refusal(`bounded check could not validate the project: ${error instanceof Error ? error.message : String(error)}`); }
}

/** Compile and execute one captured target-release configuration before update changes a host or pin. */
export async function preflightStandaloneUpdate(projectRoot: string, version: string, hasClaudeHost: boolean, hasPiHost: boolean,
  managedGraph?: ManagedPackRuntimeGraph): Promise<Result<Readonly<Record<string, Uint8Array>>>> {
  const located = locateInstalledRelease(version);
  if (!located.ok) return located;
  try {
    const declaredTypeEnvironment = located.verifiedFiles.find((file) => file.path === "share/typescript/type-environment.json");
    if (declaredTypeEnvironment === undefined) throw new Error("installed release lacks its TypeScript declaration manifest; reinstall Bounded");
    const environment = await verifiedStandaloneTypeEnvironment(located.releaseRoot, declaredTypeEnvironment.sha256);
    const boundedDeclarations: Record<string, Uint8Array> = {};
    for (const file of located.verifiedFiles) {
      if (!file.path.startsWith("share/types/") || !file.path.endsWith(".d.ts")) continue;
      const bytes = readFileSync(join(located.releaseRoot, file.path));
      if (bytes.byteLength !== file.size || createHash("sha256").update(bytes).digest("hex") !== file.sha256)
        throw new Error(`installed Bounded declaration ${file.path} changed after release verification; reinstall Bounded`);
      boundedDeclarations[file.path.slice("share/types/".length)] = bytes;
    }
    const configFile = join(projectRoot, "bounded.config.ts");
    const configInfo = lstatSync(configFile);
    if (!configInfo.isFile() || configInfo.isSymbolicLink()) throw new Error("bounded.config.ts is linked or not a regular configuration file");
    const snapshot = await prepareStandaloneProjectSnapshot(configFile, projectRoot, {
      verifiedReleaseManifestSha256: located.manifestSha256, boundedRuntimeExports: standaloneRuntimeExports,
      ...(managedGraph === undefined ? {} : { managedGraph }),
    });
    try {
      const checked = await checkStandaloneProjectSnapshot(snapshot, { ...environment, boundedDeclarations });
      if (!checked.ok) return { ok: false, error: checked.diagnostics.join("\n") };
      const loaded = await standaloneManagedConfigSource(async () => snapshot.modulePath).load(projectRoot);
      if (!loaded.ok) return loaded;
      const sharedPortProvisions = [...protectedPathsPortProvisions(), ...prereqsPortProvisions()];
      const installedHostProvisions = [
        ...(hasClaudeHost ? [{ host: "Claude Code", provisions: [...sharedPortProvisions, ...prereqsStatusSnapshotPortProvisions()] }] : []),
        ...(hasPiHost ? [{ host: "Pi", provisions: sharedPortProvisions }] : []),
      ];
      for (const { host, provisions } of installedHostProvisions) {
        const wired = validateProjectWiring(loaded.value, projectRoot, provisions);
        if (!wired.ok) return { ok: false, error: `${host}: ${wired.error}` };
      }
      return { ok: true, value: snapshot.sourceFiles };
    } finally { disposeStandaloneProjectSnapshot(snapshot); }
  } catch (error) { return { ok: false, error: `Cannot validate the target Bounded configuration: ${error instanceof Error ? error.message : String(error)}` }; }
}

function exactProjectPin(projectRoot: string): Result<string | null> {
  const path = join(projectRoot, ".bounded", "version.json");
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) return { ok: false, error: `${path} is linked or not a regular version pin` };
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
      || Reflect.get(parsed, "schema") !== "bounded-project-version/1"
      || typeof Reflect.get(parsed, "version") !== "string"
      || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(Reflect.get(parsed, "version") as string)
      || Object.keys(parsed).sort().join() !== "schema,version")
      return { ok: false, error: `${path} has a malformed version pin; repair it before updating` };
    return { ok: true, value: Reflect.get(parsed, "version") as string };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { ok: true, value: null };
    return { ok: false, error: `${path} cannot be read as a version pin: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function hasOwnedFile(path: string): Result<boolean> {
  try {
    const info = lstatSync(path);
    return info.isFile() && !info.isSymbolicLink()
      ? { ok: true, value: true } : { ok: false, error: `${path} is linked or not a regular file` };
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT"
      ? { ok: true, value: false }
      : { ok: false, error: `${path} cannot be inspected: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function hasClaudeBoundedHooks(path: string): Result<boolean> {
  const present = hasOwnedFile(path);
  if (!present.ok || !present.value) return present;
  try {
    const settings: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof settings !== "object" || settings === null || Array.isArray(settings))
      return { ok: false, error: `${path} is not a JSON settings object` };
    const hooks: unknown = Reflect.get(settings, "hooks");
    if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks))
      return { ok: false, error: `${path} has no valid hooks object` };
    for (const event of ["PreToolUse", "PostToolUse", "PostToolUseFailure", "SubagentStop"]) {
      const entries: unknown = Reflect.get(hooks, event);
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (typeof entry !== "object" || entry === null || !Array.isArray(Reflect.get(entry, "hooks"))) continue;
        for (const hook of Reflect.get(entry, "hooks") as unknown[]) {
          if (isBoundedHook(hook) || (typeof hook === "object" && hook !== null
            && typeof Reflect.get(hook, "command") === "string"
            && (Reflect.get(hook, "command") as string).includes("hook claude-code"))) return { ok: true, value: true };
        }
      }
    }
    return { ok: true, value: false };
  } catch (error) { return { ok: false, error: `${path} cannot be parsed: ${error instanceof Error ? error.message : String(error)}` }; }
}

function priorNodeAvailable(): Result<void> {
  try {
    const identified = spawnSync("node", ["--version"], { encoding: "utf8", timeout: 5_000,
      shell: process.platform === "win32" });
    const match = /^v(\d+)\.(\d+)\.(\d+)\s*$/.exec(identified.stdout ?? "");
    if (identified.error !== undefined || identified.status !== 0 || match === null
      || Number(match[1]) < 22 || (Number(match[1]) === 22 && Number(match[2]) < 18))
      return { ok: false, error: "The previous npm hooks require Node 22.18 or newer on PATH before update or rollback can restore them" };
    return { ok: true, value: undefined };
  } catch {
    return { ok: false, error: "The previous npm hooks require Node 22.18 or newer on PATH before update or rollback can restore them" };
  }
}

function verifyJournalHostTransition(journal: StandaloneUpdateJournal, activeVersion: string): Result<{ claude: boolean; pi: boolean }> {
  if (journal.intent === "rollback" ? journal.source.version !== activeVersion : journal.targetVersion !== activeVersion)
    return { ok: false, error: `The update journal requires the verified active Bounded ${journal.intent === "rollback" ? journal.source.version : journal.targetVersion} executable` };
  const source = journal.source.kind === "standalone" ? locateInstalledRelease(journal.source.version) : null;
  if (source !== null && !source.ok) return source;
  const target = journal.targetKind === "npm" ? null : locateInstalledRelease(journal.targetVersion);
  if (target !== null && !target.ok) return target;
  const sourceExecutable = source?.ok ? realpathSync(source.executable) : null;
  const targetExecutable = target?.ok ? realpathSync(target.executable) : null;
  const pin = journal.files.find((file) => file.path === ".bounded/version.json");
  if (pin === undefined) return { ok: false, error: "The update journal has no exact version pin transition" };
  const previousPin = `${JSON.stringify({ schema: "bounded-project-version/1", version: journal.source.version })}\n`;
  const nextPin = `${JSON.stringify({ schema: "bounded-project-version/1", version: journal.targetVersion })}\n`;
  if (journal.source.kind === "npm" ? pin.before.content !== null || pin.before.mode !== null
    : pin.before.content === null || Buffer.from(pin.before.content, "base64").toString("utf8") !== previousPin)
    return { ok: false, error: "The update journal has inconsistent source release pin bytes" };
  if (journal.targetKind === "npm" ? pin.after.content !== null || pin.after.mode !== null
    : pin.after.content === null || Buffer.from(pin.after.content, "base64").toString("utf8") !== nextPin)
    return { ok: false, error: "The update journal has inconsistent target release pin bytes" };
  const claude = journal.files.find((file) => file.path === ".claude/settings.json");
  const pi = journal.files.find((file) => file.path === ".pi/extensions/bounded/index.ts");
  if (claude === undefined && pi === undefined)
    return { ok: false, error: "The update journal has no installed Bounded host" };
  if (claude !== undefined) {
    if (claude.before.content === null || claude.after.content === null)
      return { ok: false, error: "The update journal has incomplete Claude Code hook bytes" };
    const beforeBytes = Buffer.from(claude.before.content, "base64").toString("utf8");
    const afterBytes = Buffer.from(claude.after.content, "base64").toString("utf8");
    const checked = journal.targetKind === "npm"
      ? verifyStandaloneClaudeHookTransition(afterBytes, beforeBytes, sourceExecutable ?? "", { recognizedPriorNodeHooks: true })
      : journal.source.kind === "npm"
        ? verifyStandaloneClaudeHookTransition(beforeBytes, afterBytes, targetExecutable ?? "", { recognizedPriorNodeHooks: true })
        : verifyStandaloneClaudeHookTransition(beforeBytes, afterBytes, targetExecutable ?? "",
          { recognizedPriorExecutable: sourceExecutable ?? "" });
    if (!checked.ok) return checked;
  }
  if (pi !== undefined) {
    const previousLoader = journal.source.kind === "npm" ? piLoader().content : standalonePiLoader(sourceExecutable ?? "");
    const nextLoader = journal.targetKind === "npm" ? piLoader().content : standalonePiLoader(targetExecutable ?? "");
    if (pi.before.content === null || pi.after.content === null
      || Buffer.from(pi.before.content, "base64").toString("utf8") !== previousLoader
      || Buffer.from(pi.after.content, "base64").toString("utf8") !== nextLoader)
      return { ok: false, error: "The update journal has an edited or inconsistent Pi loader" };
  }
  return { ok: true, value: { claude: claude !== undefined, pi: pi !== undefined } };
}

function managedReleaseTypes(version: string, located: Extract<ReturnType<typeof locateInstalledRelease>, { ok: true }>): ManagedPackReleaseTypes {
  return { boundedVersion: version,
    boundedExportPaths: Object.keys(standaloneRuntimeExports).map((specifier) => `.${specifier.slice("bounded".length)}`),
    releaseTypesRoot: join(located.releaseRoot, "share", "types"),
    releaseTypeFilesFromVerifiedManifest: Object.fromEntries(located.verifiedFiles
      .filter((file) => file.path.startsWith("share/types/") && file.path.endsWith(".d.ts"))
      .map((file) => [file.path.slice("share/types/".length), file.sha256])) };
}

async function verifyJournalManagedSnapshot(projectRoot: string, journal: StandaloneUpdateJournal,
  side: "before" | "after"): Promise<Result<void>> {
  if (journal.managed === undefined) return { ok: true, value: undefined };
  const version = side === "before" ? journal.source.version : journal.targetVersion;
  const located = locateInstalledRelease(version);
  if (!located.ok) return located;
  const ownedFiles: Record<string, { bytes: Uint8Array; mode: number }> = {};
  for (const file of journal.files) {
    if (file.path !== ".bounded/packs.lock.json" && file.path !== ".bounded/types-receipt.json" && !file.path.startsWith("node_modules/")) continue;
    const state = file[side];
    if (state.content === null || state.mode === null) continue;
    ownedFiles[file.path] = { bytes: Buffer.from(state.content, "base64"), mode: state.mode };
  }
  const lockBytes = ownedFiles[".bounded/packs.lock.json"]?.bytes;
  const receiptBytes = ownedFiles[".bounded/types-receipt.json"]?.bytes;
  if (lockBytes === undefined || receiptBytes === undefined)
    return { ok: false, error: "Managed update snapshot lacks its exact pack lock or receipt" };
  const verified = await verifyManagedPackUpdateProjectionSnapshot({ projectRoot, storeRoot: join(userDataRoot(), "packs", "store"),
    release: managedReleaseTypes(version, located), lockBytes, receiptBytes, ownedFiles,
    ownedDirectories: side === "before" ? journal.managed.oldOwnedDirectories : journal.managed.newOwnedDirectories });
  return verified.ok ? verified : { ok: false, error: `Managed update snapshot ${side}: ${verified.error}` };
}

async function managedUpdateGraph(projectRoot: string, version: string): Promise<Result<ManagedPackRuntimeGraph>> {
  const located = locateInstalledRelease(version);
  if (!located.ok) return located;
  return captureManagedPackRuntimeGraph({ projectRoot, storeRoot: join(userDataRoot(), "packs", "store"),
    ...managedReleaseTypes(version, located) });
}

function verifyJournalNpmClosure(projectRoot: string, journal: StandaloneUpdateJournal): Result<void> {
  if (journal.source.kind !== "npm" && journal.targetKind !== "npm") return { ok: true, value: undefined };
  if (journal.npmClosure === undefined) return { ok: false, error: "The update journal has no verified npm closure" };
  const checked = reverifyInstalledNpmClosure(projectRoot, journal.npmClosure);
  if (!checked.ok) return checked;
  return priorNodeAvailable();
}

function updateJournalVerifiers(projectRoot: string, activeVersion: string): StandaloneUpdateVerifiers {
  return {
    async beforeRestore(journal) {
      const checked = verifyJournalHostTransition(journal, activeVersion);
      if (!checked.ok) return checked;
      const npm = verifyJournalNpmClosure(projectRoot, journal);
      if (!npm.ok) return npm;
      const source = await verifyJournalManagedSnapshot(projectRoot, journal, "before");
      if (!source.ok) return source;
      return verifyJournalManagedSnapshot(projectRoot, journal, "after");
    },
    async restoredSource(journal) {
      const checked = verifyJournalHostTransition(journal, activeVersion);
      if (!checked.ok) return checked;
      if (journal.source.kind === "npm") return verifyJournalNpmClosure(projectRoot, journal);
      const graph = journal.managed === undefined ? undefined : await managedUpdateGraph(projectRoot, journal.source.version);
      if (graph !== undefined && !graph.ok) return graph;
      const preflight = await preflightStandaloneUpdate(projectRoot, journal.source.version, checked.value.claude, checked.value.pi,
        graph?.value);
      return preflight.ok ? { ok: true, value: undefined } : preflight;
    },
    async committedTarget(journal) {
      const checked = verifyJournalHostTransition(journal, activeVersion);
      if (!checked.ok) return checked;
      if (journal.targetKind === "npm") return verifyJournalNpmClosure(projectRoot, journal);
      const graph = journal.managed === undefined ? undefined : await managedUpdateGraph(projectRoot, journal.targetVersion);
      if (graph !== undefined && !graph.ok) return graph;
      const preflight = await preflightStandaloneUpdate(projectRoot, journal.targetVersion, checked.value.claude, checked.value.pi,
        graph?.value);
      return preflight.ok ? { ok: true, value: undefined } : preflight;
    },
  };
}

async function updateStandalone(args: readonly string[], version: string): Promise<void> {
  const rollbackRequested = args.length === 2 && args[1] === "--rollback";
  if (args.length !== 1 && !rollbackRequested) { refusal("Use bounded update or bounded update --rollback from the project root"); return; }
  if (!releaseIdentity(version)) return;
  const projectRoot = process.cwd();
  const writer = await acquireStandaloneUpdateWriter(projectRoot);
  if (!writer.ok) { refusal(writer.error); return; }
  let packWriter: ManagedPackWriter | undefined;
  try {
    const target = locateInstalledRelease(version);
    if (!target.ok) { refusal(target.error); return; }
    if (realpathSync(target.executable) !== realpathSync(process.execPath)) { refusal(`The active Bounded executable differs from the verified installed ${version} release; use the installed launcher`); return; }
    const acquiredPackWriter = await acquireManagedPackWriter(projectRoot);
    if (!acquiredPackWriter.ok) { refusal(acquiredPackWriter.error); return; }
    packWriter = acquiredPackWriter.value;
    const boundary = join(projectRoot, ".bounded");
    const verifiers = updateJournalVerifiers(projectRoot, version);
    const journal = hasOwnedFile(join(boundary, "update-journal.json"));
    if (!journal.ok) { refusal(journal.error); return; }
    if (journal.value) {
      const recovered = await recoverStandaloneUpdate(projectRoot, verifiers);
      if (!recovered.ok) { refusal(recovered.error); return; }
      if (recovered.value === "source") { refusal("The interrupted update restored the previous project state; run bounded update again to retry"); return; }
      process.stdout.write(`Bounded ${version} update recovered and verified\n`);
      return;
    }
    if (rollbackRequested) {
      const recorded = readStandaloneRollbackRecord(projectRoot);
      if (!recorded.ok) { refusal(recorded.error); return; }
      if (recorded.value === null) { refusal("No verified previous Bounded generation is available for rollback"); return; }
      const inverse = createStandaloneRollbackJournal(projectRoot, recorded.value);
      const published = await publishStandaloneUpdate(projectRoot, inverse, verifiers);
      if (!published.ok) { refusal(published.error); return; }
      process.stdout.write(`Bounded project restored from ${version} to ${recorded.value.source.version}; restart the installed host\n`);
      return;
    }
    const pinned = exactProjectPin(projectRoot);
    if (!pinned.ok) { refusal(pinned.error); return; }
    let npmClosure: NpmClosureSnapshot | null = null;
    let sourceVersion: string;
    if (pinned.value === null) {
      const captured = captureInstalledNpmClosure(projectRoot);
      if (!captured.ok) { refusal(captured.error); return; }
      npmClosure = captured.value;
      sourceVersion = captured.value.version;
    } else sourceVersion = pinned.value;
    const prior = pinned.value === null ? null : locateInstalledRelease(pinned.value);
    if (prior !== null && !prior.ok) { refusal(prior.error); return; }
    if (sourceVersion.includes("-") || version.includes("-")) {
      refusal(`Bounded update requires stable source and target releases; ${sourceVersion} to ${version} is a prerelease transition`);
      return;
    }
    const priorParts = sourceVersion.split(".").map(Number);
    const targetParts = version.split(".").map(Number);
    if (priorParts[0] !== targetParts[0] || priorParts.some((part, index) => part > (targetParts[index] ?? -1)
      && priorParts.slice(0, index).every((earlier, at) => earlier === targetParts[at]))) {
      refusal(`Bounded ${sourceVersion} cannot update to ${version} across a major version or downgrade; install a compatible target`);
      return;
    }
    const managed = ["packs.lock.json", "types-receipt.json", "types-journal.json"].map((name) => hasOwnedFile(join(boundary, name)));
    const problem = managed.find((state) => !state.ok);
    if (problem && !problem.ok) { refusal(problem.error); return; }
    const hasManagedState = managed.some((state) => state.ok && state.value);
    if (npmClosure !== null && hasManagedState) { refusal("An npm project with existing managed pack state needs an explicit migration; preserve its lock and project files"); return; }
    const verifiedPrior = prior?.ok ? prior : null;
    if (hasManagedState && verifiedPrior === null) { refusal("Managed pack state requires a verified prior standalone release"); return; }
    const candidateProjection = hasManagedState && verifiedPrior !== null ? await prepareManagedPackTargetProjectionUnderWriter({
      writer: packWriter, projectRoot, storeRoot: join(userDataRoot(), "packs", "store"),
      source: managedReleaseTypes(sourceVersion, verifiedPrior), target: managedReleaseTypes(version, target),
    }) : undefined;
    const preparedProjection = candidateProjection?.ok && sourceVersion === version
      ? { ok: true as const, value: { ...candidateProjection.value,
        newOwnedFiles: candidateProjection.value.oldOwnedFiles,
        newOwnedDirectories: candidateProjection.value.oldOwnedDirectories,
        targetLockBytes: candidateProjection.value.oldOwnedFiles[".bounded/packs.lock.json"]?.bytes ?? candidateProjection.value.targetLockBytes,
        targetReceiptBytes: candidateProjection.value.oldOwnedFiles[".bounded/types-receipt.json"]?.bytes ?? candidateProjection.value.targetReceiptBytes } }
      : candidateProjection;
    if (preparedProjection !== undefined && !preparedProjection.ok) { refusal(preparedProjection.error); return; }
    const steps: StandaloneUpdateFile[] = [];
    const claudePath = join(projectRoot, ".claude", "settings.json");
    const claudeInstalled = hasClaudeBoundedHooks(claudePath);
    if (!claudeInstalled.ok) { refusal(claudeInstalled.error); return; }
    if (claudeInstalled.value) {
      const prepared = await prepareStandaloneClaudeHooks(projectRoot, realpathSync(target.executable),
        prior?.ok ? { recognizedPriorExecutable: realpathSync(prior.executable) } : { recognizedPriorNodeHooks: true });
      if (!prepared.ok) { refusal(prepared.error); return; }
      steps.push(captureStandaloneUpdateFile(projectRoot, ".claude/settings.json", prepared.value.nextBytes, prepared.value.mode));
    }
    const piPath = join(projectRoot, ".pi", "extensions", "bounded", "index.ts");
    const piInstalled = hasOwnedFile(piPath);
    if (!piInstalled.ok) { refusal(piInstalled.error); return; }
    if (piInstalled.value) {
      const expectedPriorLoader = prior?.ok ? standalonePiLoader(realpathSync(prior.executable)) : piLoader().content;
      if (readFileSync(piPath, "utf8") !== expectedPriorLoader) {
        refusal(`${piPath} differs from the exact previous generated Pi loader; preserve edits and repair before updating`);
        return;
      }
      const prepared = await prepareStandalonePiExtension(projectRoot, realpathSync(target.executable),
        verifiedPrior === null ? {} : { recognizedPriorExecutable: realpathSync(verifiedPrior.executable) });
      if (!prepared.ok) { refusal(prepared.error); return; }
      steps.push(captureStandaloneUpdateFile(projectRoot, ".pi/extensions/bounded/index.ts", prepared.value.nextBytes, prepared.value.mode));
    }
    if (steps.length === 0) { refusal("No installed Bounded host wiring was found; initialize a host before updating"); return; }
    const preflight = await preflightStandaloneUpdate(projectRoot, version, claudeInstalled.value, piInstalled.value,
      preparedProjection?.value.targetGraph);
    if (!preflight.ok) { refusal(preflight.error); return; }
    if (preparedProjection !== undefined) {
      const paths = [...new Set([...Object.keys(preparedProjection.value.oldOwnedFiles),
        ...Object.keys(preparedProjection.value.newOwnedFiles)])].sort();
      for (const path of paths) {
        const old = preparedProjection.value.oldOwnedFiles[path];
        const next = preparedProjection.value.newOwnedFiles[path];
        const step = captureStandaloneUpdateFile(projectRoot, path, next?.bytes ?? null,
          next?.mode ?? null, true);
        if ((old === undefined && step.before.content !== null)
          || (old !== undefined && (step.before.content !== Buffer.from(old.bytes).toString("base64") || step.before.mode !== old.mode))) {
          refusal(`Managed pack owned file ${path} changed after target preparation; retry the update`);
          return;
        }
        steps.push(step);
      }
    }
    const pinPath = join(boundary, "version.json");
    const pinMode = pinned.value === null ? 0o644 : lstatSync(pinPath).mode & 0o777;
    steps.push(captureStandaloneUpdateFile(projectRoot, ".bounded/version.json",
      `${JSON.stringify({ schema: "bounded-project-version/1", version })}\n`, pinMode));
    const source = { kind: pinned.value === null ? "npm" as const : "standalone" as const, version: sourceVersion };
    const preparedJournal = createStandaloneUpdateJournal(projectRoot, source, version, preflight.value, steps,
      preparedProjection === undefined ? undefined : { oldOwnedDirectories: preparedProjection.value.oldOwnedDirectories,
        newOwnedDirectories: preparedProjection.value.newOwnedDirectories }, npmClosure ?? undefined);
    const changed = preparedJournal.files.some((file) => JSON.stringify(file.before) !== JSON.stringify(file.after));
    if (!changed) { process.stdout.write(`Bounded ${sourceVersion} is already updated to ${version}\n`); return; }
    const published = await publishStandaloneUpdate(projectRoot, preparedJournal, verifiers);
    if (!published.ok) { refusal(published.error); return; }
    process.stdout.write(`Bounded project updated from ${sourceVersion} to ${version}; restart ${steps.slice(0, -1).map((step) => step.path.startsWith(".pi/") ? "Pi" : "Claude Code").join(" and ")}\n`);
  } catch (error) { refusal(`Cannot update the project: ${error instanceof Error ? error.message : String(error)}`); }
  finally {
    try { await packWriter?.release(); }
    catch (error) { refusal(`Cannot release the managed pack writer: ${error instanceof Error ? error.message : String(error)}`); }
    try { writer.value(); }
    catch (error) { refusal(`Cannot release the project update writer: ${error instanceof Error ? error.message : String(error)}`); }
  }
}

async function addStandalone(args: readonly string[], version: string): Promise<void> {
  const parsed = parseStandaloneAddArguments(args);
  if (!parsed.ok) { refusal(parsed.error); return; }
  const added = await runStandaloneAddInternal(args, { projectRoot: process.cwd(), boundedVersion: version });
  if (!added.ok) { refusal(added.error); return; }
  const imports = [...new Set(added.value.catalogueImports.map((pack) =>
    pack.exportName === "default" ? `import selectedPack from ${JSON.stringify(pack.importPath)};`
      : `import { ${pack.exportName} } from ${JSON.stringify(pack.importPath)};`))];
  process.stdout.write(`Added ${parsed.value.request}\n${imports.length === 0 ? "" : `Select a pack in bounded.config.ts:\n${imports.map((line) => `  ${line}`).join("\n")}\n`}`);
}

type AddResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };
interface CompletedPackAddition {
  readonly lockPath: string;
  readonly receiptPath: string;
  readonly catalogueImports: readonly { readonly importPath: string; readonly exportName: string }[];
}
type PackReply = { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: Uint8Array };
type AddRequest = { readonly request: string; readonly registryUrl: string };
const defaultRegistryUrl = "https://registry.npmjs.org";
const exactPackRequest = /^(@[a-z0-9._-]+\/[a-z0-9._-]+|[a-z0-9._-]+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
const packResponseLimit = 64 * 1024 * 1024;
const packRequestTimeoutMs = 15_000;

/** Parse one exact pack request without reading or changing the project. */
export function parseStandaloneAddArguments(args: readonly string[]): AddResult<AddRequest> {
  if (args[0] !== "add" || (args.length !== 2 && args.length !== 4))
    return { ok: false, error: "Use bounded add name@version [--registry https://registry.example]" };
  const request = args[1];
  if (request === undefined || !exactPackRequest.test(request))
    return { ok: false, error: `Pack request ${request ?? "(missing)"} must name an exact package version` };
  if (args.length === 2) return { ok: true, value: { request, registryUrl: defaultRegistryUrl } };
  const registryArgument = args[3];
  if (args[2] !== "--registry" || registryArgument === undefined)
    return { ok: false, error: "Use --registry followed by an HTTPS npm-compatible registry URL" };
  try {
    const registry = new URL(registryArgument);
    if (registry.protocol !== "https:" || registry.username !== "" || registry.password !== "" || registry.search !== "" || registry.hash !== "")
      return { ok: false, error: "The pack registry must be an HTTPS URL without credentials, query or fragment" };
    return { ok: true, value: { request, registryUrl: registryArgument.replace(/\/+$/, "") } };
  } catch { return { ok: false, error: `Invalid pack registry URL ${registryArgument}` }; }
}

/** Return one bounded response; the installer checks every redirect itself. */
export async function fetchStandalonePackResponse(
  url: string,
  fetcher: typeof fetch = fetch,
  limits: { readonly maxBytes: number; readonly timeoutMs: number } = { maxBytes: packResponseLimit, timeoutMs: packRequestTimeoutMs },
): Promise<PackReply> {
  if (new URL(url).protocol !== "https:") throw new Error(`Pack requests require HTTPS: ${url}`);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error(`Pack request ${url} exceeded its timeout`)); }, limits.timeoutMs);
  });
  try {
    const response = await Promise.race([fetcher(url, { redirect: "manual", signal: controller.signal }), timeout]);
    const declaredSize = response.headers.get("content-length");
    if (declaredSize !== null && Number(declaredSize) > limits.maxBytes) throw new Error(`Pack response ${url} exceeds the size limit`);
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (response.body !== null) {
      const reader = response.body.getReader();
      for (;;) {
        const part = await Promise.race([reader.read(), timeout]);
        if (part.done) break;
        total += part.value.byteLength;
        if (total > limits.maxBytes) { controller.abort(); throw new Error(`Pack response ${url} exceeds the size limit`); }
        chunks.push(part.value);
      }
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body };
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

interface InternalAddContext {
  readonly projectRoot: string;
  readonly boundedVersion: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly get?: (url: string) => Promise<PackReply>;
  /** Test seam; a production call uses the verified installed-release wrapper. */
  readonly publish?: (input: { readonly request: string; readonly registryUrl: string; readonly projectRoot: string; readonly boundedVersion: string; readonly get: (url: string) => Promise<PackReply> }) => Promise<AddResult<CompletedPackAddition>>;
}

/** Run the verified managed add transaction for the standalone command. */
export async function runStandaloneAddInternal(args: readonly string[], context: InternalAddContext): Promise<AddResult<CompletedPackAddition>> {
  const parsed = parseStandaloneAddArguments(args);
  if (!parsed.ok) return parsed;
  if (!isAbsolute(context.projectRoot))
    return { ok: false, error: "The dispatched project root must be absolute" };
  const updateJournal = join(context.projectRoot, ".bounded", "update-journal.json");
  try {
    lstatSync(updateJournal);
    return { ok: false, error: `Project update journal ${updateJournal} requires recovery; run bounded update before adding packs` };
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      return { ok: false, error: `Cannot inspect project update journal ${updateJournal}; run bounded update to recover it` };
  }
  const get = context.get ?? ((url: string) => fetchStandalonePackResponse(url));
  const input = { ...parsed.value, projectRoot: context.projectRoot, boundedVersion: context.boundedVersion, get };
  if (context.publish !== undefined) return context.publish(input);
  let storeRoot: string;
  try { storeRoot = join(userDataRoot(context.env), "packs", "store"); }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  const boundedExportPaths = Object.keys(standaloneRuntimeExports).map((specifier) => `.${specifier.slice("bounded".length)}`);
  return addManagedPackWithInstalledReleaseProjection({ ...input, storeRoot, boundedExportPaths }, context.env);
}

/** Internal native entry: projection types and digests come from the verified installed release. */
export async function addManagedPackWithInstalledReleaseProjection(
  input: Omit<ProjectionInput, "releaseTypesRoot" | "releaseTypeFilesFromVerifiedManifest">,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Awaited<ReturnType<typeof addManagedPackWithProjection>>> {
  const located = locateInstalledRelease(input.boundedVersion, env);
  if (!located.ok) return { ok: false, error: located.error };
  const releaseTypeFilesFromVerifiedManifest = Object.fromEntries(located.verifiedFiles
    .filter((file) => file.path.startsWith("share/types/") && file.path.endsWith(".d.ts"))
    .map((file) => [file.path.slice("share/types/".length), file.sha256]));
  return addManagedPackWithProjection({ ...input, releaseTypesRoot: join(located.releaseRoot, "share", "types"), releaseTypeFilesFromVerifiedManifest });
}
