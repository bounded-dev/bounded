// Store tests need a container runtime at green only (ADR 2026-064). This is
// the pack's half of that rule, for the red and green gates to call:
//
//   probeContainerRuntime  is a Docker-API runtime answering right now?
//   drizzleStoreTests      which test files in the project need one?
//   storeTestDecision      run, skip with a logged reason (red), or refuse (green)
//
// The probe is deterministic for a given environment and filesystem: it
// tries a fixed, ordered list of endpoints and asks each one the Docker API's
// `GET /_ping`, with a bounded timeout. It never starts anything. Whatever it
// misses fails closed: green refuses rather than running store tests that
// could not start, and a runtime it finds but Testcontainers cannot use makes
// the store tests fail loudly, never pass.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DRIZZLE, STORE_TESTS_SKIP_ENV } from "./emit.ts";
import { CONTEXTS_DIR } from "./check-db.ts";

export type ContainerRuntimeProbe =
  | { readonly available: true; readonly endpoint: string }
  | { readonly available: false; readonly reason: string };

export type StoreTestDecision =
  /** Run the suite as it is. */
  | { readonly action: "run" }
  /** Red only: run the suite with `env` added; the store tests skip themselves
   *  and log `reason`. The gate logs `reason` too. */
  | { readonly action: "skip"; readonly reason: string; readonly env: Readonly<Record<string, string>> }
  /** Green only: do not run the suite; block with `reason`. */
  | { readonly action: "refuse"; readonly reason: string };

export const PROBE_TIMEOUT_MS = 3_000;

/** Unix sockets the common Docker-API runtimes listen on, in probe order,
 *  relative to the home directory unless absolute. */
const SOCKETS = [
  "/var/run/docker.sock",
  ".docker/run/docker.sock",
  ".docker/desktop/docker.sock",
  ".colima/default/docker.sock",
  ".colima/docker.sock",
  ".rd/docker.sock",
  ".orbstack/run/docker.sock",
  ".local/share/containers/podman/machine/podman.sock",
] as const;

/** The `docker.host` Testcontainers reads from ~/.testcontainers.properties. */
function propertiesHost(home: string): string | undefined {
  const file = join(home, ".testcontainers.properties");
  if (!existsSync(file)) return undefined;
  const line = readFileSync(file, "utf8").split(/\r?\n/).find((l) => /^\s*docker\.host\s*=/.test(l));
  return line?.slice(line.indexOf("=") + 1).trim() || undefined;
}

/** The endpoints to ask, in order: an explicit host (DOCKER_HOST, then the
 *  Testcontainers properties file) alone when one is set, otherwise every
 *  known socket that exists. */
export function candidateEndpoints(env: NodeJS.ProcessEnv, home: string): string[] {
  const explicit = (env["DOCKER_HOST"] ?? "").trim() || propertiesHost(home);
  if (explicit !== undefined) return [explicit];
  const sockets = SOCKETS.map((socket) => (socket.startsWith("/") ? socket : join(home, socket)));
  const xdg = (env["XDG_RUNTIME_DIR"] ?? "").trim();
  if (xdg !== "") sockets.push(join(xdg, "docker.sock"), join(xdg, "podman", "podman.sock"));
  return sockets.filter((path) => existsSync(path)).map((path) => `unix://${path}`);
}

// Runs in a child process so the probe can stay synchronous for the gates.
// Exit 0 when the endpoint answers `GET /_ping` with 200, else prints why.
const PING = `
const http = require("node:http");
const endpoint = process.env.BOUNDED_PING_ENDPOINT;
const timeout = Number(process.env.BOUNDED_PING_TIMEOUT_MS);
let options;
if (endpoint.startsWith("unix://")) options = { socketPath: endpoint.slice(7), path: "/_ping" };
else { const url = new URL(endpoint.replace(/^tcp:/, "http:")); options = { host: url.hostname, port: url.port || 2375, path: "/_ping" }; }
const request = http.get({ ...options, timeout }, (response) => {
  response.resume();
  if (response.statusCode === 200) process.exit(0);
  console.log("answered " + response.statusCode);
  process.exit(1);
});
request.on("timeout", () => { console.log("did not answer within " + timeout + "ms"); request.destroy(); process.exit(1); });
request.on("error", (error) => { console.log(error.code || error.message); process.exit(1); });
`;

export interface ProbeOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly timeoutMs?: number;
}

/** Is a Docker-API container runtime answering? Synchronous, bounded. */
export function probeContainerRuntime(options: ProbeOptions = {}): ContainerRuntimeProbe {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const endpoints = candidateEndpoints(env, options.home ?? homedir());
  if (endpoints.length === 0) {
    return { available: false, reason: "no container runtime found: DOCKER_HOST is unset and no Docker-API socket exists" };
  }
  const failures: string[] = [];
  for (const endpoint of endpoints) {
    if (!/^(unix|tcp|http):\/\//.test(endpoint)) {
      failures.push(`${endpoint}: unsupported endpoint scheme`);
      continue;
    }
    const run = spawnSync(process.execPath, ["-e", PING], {
      env: { PATH: env["PATH"] ?? "", BOUNDED_PING_ENDPOINT: endpoint, BOUNDED_PING_TIMEOUT_MS: String(timeoutMs) },
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs + 2_000,
    });
    if (run.status === 0) return { available: true, endpoint };
    failures.push(`${endpoint}: ${(run.stdout ?? "").trim() || (run.error?.message ?? `exit ${run.status}`)}`);
  }
  return { available: false, reason: `no container runtime is answering (${failures.join("; ")})` };
}

/** Project-relative Drizzle store test files, sorted: every test-side file
 *  under a context's `adapters/out/drizzle/` except the generated support. */
export function drizzleStoreTests(root: string): string[] {
  const out: string[] = [];
  const base = join(root, CONTEXTS_DIR);
  if (!existsSync(base)) return out;
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const path = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(join(dir, entry.name), path);
      else if (/\.test\.tsx?$/i.test(entry.name)) out.push(path);
    }
  };
  for (const context of readdirSync(base).sort()) {
    const drizzle = join(base, context, "src", "adapters", "out", DRIZZLE);
    if (existsSync(drizzle) && statSync(drizzle).isDirectory()) walk(drizzle, `${CONTEXTS_DIR}/${context}/src/adapters/out/${DRIZZLE}`);
  }
  return out.sort();
}

/**
 * ADR 2026-064 as a pure function. With no store tests, or a runtime that
 * answers, the suite runs. Otherwise red skips the store tests with the
 * reason, and green refuses.
 */
export function storeTestDecision(
  phase: "red" | "green", storeTests: readonly string[], probe: ContainerRuntimeProbe,
): StoreTestDecision {
  if (storeTests.length === 0 || probe.available) return { action: "run" };
  if (phase === "red") {
    const reason = `${storeTests.length} Drizzle store test file(s) skipped at red: ${probe.reason}`;
    return { action: "skip", reason, env: { [STORE_TESTS_SKIP_ENV]: reason } };
  }
  return {
    action: "refuse",
    reason: `green needs a container runtime: ${storeTests.length} Drizzle store test file(s) run against real Postgres ` +
      `(${storeTests.join(", ")}), and ${probe.reason}. Start Docker (or another Docker-API runtime) and run green again; ` +
      "store tests are never skipped at green (ADR 2026-064).",
  };
}
