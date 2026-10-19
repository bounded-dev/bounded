import * as domain from "bounded/domain";
import * as application from "bounded/application";
import * as adapters from "bounded/adapters";
import * as project from "bounded/open-project";
import * as prereqs from "bounded/prereqs";
import * as prereqsAdapters from "bounded/prereqs/adapters";
import * as protectedPaths from "bounded/protected-paths";
import * as protectedPathsAdapters from "bounded/protected-paths/adapters";
import { shellCommandReader } from "./cli/standalone-shell-command-reader.ts";
import { addManagedPackWithProjection, captureManagedPackRuntimeGraph, type ProjectionInput } from "./cli/managed-pack-installer.ts";
import { locateInstalledRelease, userDataRoot } from "./standalone-installed-release.ts";
import { lstatSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
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

function prepareStandaloneRuntime(version: string): void {
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
    value: async (projectRoot: string) => {
      const bounded = join(projectRoot, ".bounded");
      const has = (name: string): boolean => {
        try { lstatSync(join(bounded, name)); return true; }
        catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error; }
      };
      if (!["packs.lock.json", "types-receipt.json", "types-journal.json"].some(has)) return undefined;
      const located = locateInstalledRelease(version);
      if (!located.ok) throw new Error(located.error);
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
  const route = commandRoutes[command as keyof typeof commandRoutes];
  if (route === "project-setup") {
    await initStandalone(args, version);
    return;
  }
  refusal(`unsupported standalone command ${JSON.stringify(args.join(" ") || "(none)")}; this release has no handler for it`);
}

async function addStandalone(args: readonly string[], version: string): Promise<void> {
  const parsed = parseStandaloneAddArguments(args);
  if (!parsed.ok) { refusal(parsed.error); return; }
  const added = await runStandaloneAddInternal(args, { projectRoot: process.cwd(), boundedVersion: version });
  if (!added.ok) { refusal(added.error); return; }
  const located = locateInstalledRelease(version);
  if (!located.ok) { refusal(located.error); return; }
  const releaseTypeFilesFromVerifiedManifest = Object.fromEntries(located.verifiedFiles
    .filter((file) => file.path.startsWith("share/types/") && file.path.endsWith(".d.ts"))
    .map((file) => [file.path.slice("share/types/".length), file.sha256]));
  let storeRoot: string;
  try { storeRoot = join(userDataRoot(), "packs", "store"); }
  catch (error) { refusal(error instanceof Error ? error.message : String(error)); return; }
  const graph = await captureManagedPackRuntimeGraph({ projectRoot: process.cwd(), boundedVersion: version,
    boundedExportPaths: Object.keys(standaloneRuntimeExports).map((specifier) => `.${specifier.slice("bounded".length)}`),
    storeRoot, releaseTypesRoot: join(located.releaseRoot, "share", "types"), releaseTypeFilesFromVerifiedManifest });
  if (!graph.ok) { refusal(graph.error); return; }
  const requestAt = parsed.value.request.lastIndexOf("@");
  const packageName = parsed.value.request.slice(0, requestAt);
  const rootId = graph.value.roots[packageName];
  const selected = rootId === undefined ? undefined : graph.value.nodes[rootId];
  if (selected?.catalogue === null || selected === undefined) {
    refusal(`Added ${parsed.value.request}, but its locked catalogue is missing; re-add ${packageName}`);
    return;
  }
  const imports = [...new Set(selected.catalogue.packs.map((pack) =>
    pack.exportName === "default" ? `import selectedPack from ${JSON.stringify(pack.importPath)};`
      : `import { ${pack.exportName} } from ${JSON.stringify(pack.importPath)};`))];
  process.stdout.write(`Added ${parsed.value.request}\n${imports.length === 0 ? "" : `Select a pack in bounded.config.ts:\n${imports.map((line) => `  ${line}`).join("\n")}\n`}`);
}

type AddResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };
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
  readonly publish?: (input: { readonly request: string; readonly registryUrl: string; readonly projectRoot: string; readonly boundedVersion: string; readonly get: (url: string) => Promise<PackReply> }) => Promise<AddResult<unknown>>;
}

/** Internal preparation path. The public add route remains a refusal until runtime loading lands. */
export async function runStandaloneAddInternal(args: readonly string[], context: InternalAddContext): Promise<AddResult<unknown>> {
  const parsed = parseStandaloneAddArguments(args);
  if (!parsed.ok) return parsed;
  if (!isAbsolute(context.projectRoot))
    return { ok: false, error: "The dispatched project root must be absolute" };
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
