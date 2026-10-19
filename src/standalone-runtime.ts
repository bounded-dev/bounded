import * as domain from "bounded/domain";
import * as application from "bounded/application";
import * as adapters from "bounded/adapters";
import * as project from "bounded/open-project";
import * as prereqs from "bounded/prereqs";
import * as prereqsAdapters from "bounded/prereqs/adapters";
import * as protectedPaths from "bounded/protected-paths";
import * as protectedPathsAdapters from "bounded/protected-paths/adapters";
import { shellCommandReader } from "./cli/standalone-shell-command-reader.ts";
import { addManagedPackWithProjection, type ProjectionInput } from "./cli/managed-pack-installer.ts";
import { locateInstalledRelease } from "./standalone-installed-release.ts";
import { lstatSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildStandaloneConfigModule } from "./hosts/claude-code/standalone-config-as-module.ts";
import { prepareStandaloneClaudeHooks } from "./hosts/claude-code/standalone-install.ts";
import { INITIAL_CONFIG } from "./cli/initial-config.ts";

const commandRoutes = {
  hook: "host-hook",
  init: "project-setup",
  update: "unavailable",
  check: "unavailable",
  host: "unavailable",
  catalog: "unavailable",
} as const;

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

async function initStandalone(args: readonly string[], version: string): Promise<void> {
  if (!releaseIdentity(version)) return;
  const hosts = requestedHosts(args);
  if (hosts === null) return;
  const projectRoot = process.cwd();
  const selectedHosts = hosts.length > 0 ? hosts : (() => {
    try { return lstatSync(join(projectRoot, ".claude")).isDirectory() ? ["claude-code"] : []; }
    catch { return []; }
  })();
  if (selectedHosts.length !== 1 || selectedHosts[0] !== "claude-code") {
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
  const prepared = await prepareStandaloneClaudeHooks(projectRoot, process.execPath);
  if (!prepared.ok) { refusal(prepared.error); return; }
  const installed = await prepared.value.install();
  if (!installed.ok) { refusal(installed.error); return; }
  const setup = await new InitProjectHandler(files, { load: async () => ({ ok: true, value: [{ host: "claude-code", install: async () => installed }] }) }, INITIAL_CONFIG).execute(projectRoot);
  if (!setup.ok) {
    try { await prepared.value.restore(); }
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
    try {
      await rm(join(projectRoot, setup.value.configWritten ?? "bounded.config.ts"));
      await prepared.value.restore();
    } catch (rollbackError) {
      refusal(`the project version pin could not be written: ${reason}; setup rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}; the installed hook stays fail closed`);
      return;
    }
    refusal(`the project version pin could not be written: ${reason}; settings and configuration were restored`);
    return;
  }
  process.stdout.write(`Bounded ${version} initialized for Claude Code\n`);
}

function embeddedWasmPath(name: "tree-sitter" | "tree-sitter-bash"): string {
  const pattern = name === "tree-sitter" ? /^tree-sitter-[a-z0-9]+\.wasm$/ : /^tree-sitter-bash-[a-z0-9]+\.wasm$/;
  const file = Bun.embeddedFiles.find((candidate) => pattern.test(Reflect.get(candidate, "name")));
  const filename: unknown = file === undefined ? undefined : Reflect.get(file, "name");
  if (typeof filename !== "string") throw new Error(`the standalone executable does not contain ${name}.wasm`);
  return join(import.meta.dir, filename);
}

function prepareStandaloneRuntime(): void {
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
  // Runtime-built configs and local packs use these exact module objects, so
  // nominal brands and pack dependencies match the executable's own core.
  Object.defineProperty(globalThis, "__boundedStandaloneRuntimeExports", {
    value: Object.freeze({
      "bounded/domain": domain,
      "bounded/application": application,
      "bounded/adapters": adapters,
      "bounded/open-project": project,
      "bounded/prereqs": prereqs,
      "bounded/prereqs/adapters": prereqsAdapters,
      "bounded/protected-paths": protectedPaths,
      "bounded/protected-paths/adapters": protectedPathsAdapters,
      "bounded/shell-command-reader": shellCommandReader,
    }),
    configurable: false,
    writable: false,
  });
}

export async function runStandaloneRuntime(args: readonly string[], version: string, hostProjectRoot?: string): Promise<void> {
  const [command, host] = args;
  if (command === "hook" && host === "claude-code") {
    prepareStandaloneRuntime();
    if (hostProjectRoot !== undefined) process.env.CLAUDE_PROJECT_DIR = hostProjectRoot;
    // The host entry owns the fail-closed wire response, including bootstrap failures.
    await import("./hosts/claude-code/main.ts");
    return;
  }
  const route = commandRoutes[command as keyof typeof commandRoutes];
  if (route === "project-setup") {
    await initStandalone(args, version);
    return;
  }
  refusal(`unsupported standalone command ${JSON.stringify(args.join(" ") || "(none)")}; this release has no handler for it`);
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
