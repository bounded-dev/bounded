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
import { dirname, join } from "node:path";
import { buildStandaloneConfigModule } from "./hosts/claude-code/standalone-config-as-module.ts";

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

function initStandalone(args: readonly string[], version: string): void {
  if (!releaseIdentity(version)) return;
  const hosts = requestedHosts(args);
  if (hosts === null) return;
  // No executable-carried host installer has landed yet. Setup must refuse
  // before the core writes a config or a pin that no host can run.
  refusal(hosts.length > 0
    ? `${hosts.join(", ")} host installer is unavailable in this standalone release; install a release carrying that host before init`
    : "no host installer is available in this standalone release; install a release carrying your host before init");
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
    initStandalone(args, version);
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
