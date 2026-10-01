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
import type { PhaseTestDecision, PhaseTestPolicy, PreparedTestService } from "../../ts/pack.ts";
import { startAppDatabase } from "./app-database.ts";
import { DRIZZLE, DRIZZLE_PREFIX, RED_PHASE_TOKEN, STORE_TESTS_PHASE_ENV, STORE_TESTS_SKIP_ENV } from "./emit.ts";
import { CONTEXTS_DIR, drizzleContexts } from "./check-db.ts";

export type ContainerRuntimeProbe =
  | { readonly available: true; readonly endpoint: string }
  | { readonly available: false; readonly reason: string };

/** Every variable the store-test support reads; a run that must not skip
 *  removes them all from the test child's environment. */
export const STORE_TEST_ENV: readonly string[] = Object.freeze([STORE_TESTS_SKIP_ENV, STORE_TESTS_PHASE_ENV]);

export type StoreTestDecision =
  /** Run the suite with every `unsetEnv` name removed from the child's
   *  environment, so a leftover skip variable cannot skip anything. */
  | { readonly action: "run"; readonly unsetEnv: readonly string[] }
  /** Red only: run the suite with `env` (the skip reason and the red token)
   *  set in the child's environment; the store tests skip themselves and log
   *  `reason`. The gate logs `reason` too. */
  | { readonly action: "skip"; readonly reason: string; readonly env: Readonly<Record<string, string>> }
  /** Green only: do not run the suite; block with `reason`. Any later run
   *  removes `unsetEnv` from the child's environment. */
  | { readonly action: "refuse"; readonly reason: string; readonly unsetEnv: readonly string[] };

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
  if (storeTests.length === 0) return { action: "run", unsetEnv: STORE_TEST_ENV };
  // Red always skips store tests, container runtime or not: they apply the
  // context's migrations, which generate-artifacts only produces from the
  // builder's schema after red. Running them at red would fail for that
  // missing file, not for NotImplementedError (ADR 2026-064).
  if (phase === "red") {
    const why = probe.available
      ? "they apply migrations that are generated from the builder's schema after red"
      : probe.reason;
    const reason = `${storeTests.length} Drizzle store test file(s) skipped at red: ${why}`;
    return { action: "skip", reason, env: { [STORE_TESTS_SKIP_ENV]: reason, [STORE_TESTS_PHASE_ENV]: RED_PHASE_TOKEN } };
  }
  if (probe.available) return { action: "run", unsetEnv: STORE_TEST_ENV };
  return {
    action: "refuse",
    unsetEnv: STORE_TEST_ENV,
    reason: `green needs a container runtime: ${storeTests.length} Drizzle store test file(s) run against real Postgres ` +
      `(${storeTests.join(", ")}), and ${probe.reason}. Start Docker (or another Docker-API runtime) and run green again; ` +
      "store tests are never skipped at green (ADR 2026-064).",
  };
}

/**
 * The environment for the test child under a decision: `base` without every
 * `unsetEnv` name, plus `env`. Gates build the child's environment with this
 * and never pass their own through unchanged, so a skip variable leaked into
 * the gate's environment cannot reach a run that should not skip.
 */
export function storeTestEnv(base: NodeJS.ProcessEnv, decision: StoreTestDecision): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...base };
  for (const name of STORE_TEST_ENV) delete out[name];
  if (decision.action === "skip") Object.assign(out, decision.env);
  return out;
}

/** The first segment of a sanitized test name (`Describe > … > test`) that a
 *  skipped store block carries: the name passed to the generated
 *  `describeDrizzleStore`, which is the store class, `Drizzle<Port>`. */
const STORE_BLOCK = new RegExp(`^${DRIZZLE_PREFIX}[A-Z][A-Za-z0-9]*Store$`);

/** Is this skipped result one of the store blocks a red skip covers? */
export function isSkippedStoreTest(resultName: string): boolean {
  return STORE_BLOCK.test(resultName.split(" > ")[0]!.trim());
}

/** The reason green refuses a tree that persists through Drizzle but has no
 *  store test yet: its app smoke tests still need a database. */
export function appDatabaseRefusal(probe: Extract<ContainerRuntimeProbe, { available: false }>): string {
  return `green needs a container runtime: the apps keep their data in Postgres, and their smoke tests run against a ` +
    `throwaway migrated database the gate starts, and ${probe.reason}. Start Docker (or another Docker-API runtime) ` +
    "and run green again (ADR 2026-064).";
}

/**
 * ADR 2026-064 in the ts pack's `phaseTestPolicies` shape. The runtime is
 * probed only when the tree has store tests, or at green when it persists
 * through Drizzle at all. At green with a runtime, a Drizzle tree also gets
 * its throwaway application database (`startDatabase`, called by the gate
 * just before the run): the app smoke tests read DATABASE_URL through their
 * composition roots.
 */
export function storeTestPhaseDecision(
  phase: "red" | "green",
  storeTests: readonly string[],
  probe: () => ContainerRuntimeProbe,
  persists = false,
  startDatabase?: (endpoint: string) => Promise<PreparedTestService>,
): PhaseTestDecision {
  const needsRuntime = storeTests.length > 0 || (phase === "green" && persists);
  const probed = needsRuntime ? probe() : { available: true as const, endpoint: "(not probed)" };
  const decision = storeTestDecision(phase, storeTests, probed);
  if (decision.action === "skip") {
    return { action: "skip", reason: decision.reason, env: decision.env, unsetEnv: STORE_TEST_ENV, skippedTest: isSkippedStoreTest };
  }
  if (decision.action === "refuse") return decision;
  if (phase !== "green" || !persists) return decision;
  if (!probed.available) return { action: "refuse", reason: appDatabaseRefusal(probed), unsetEnv: STORE_TEST_ENV };
  if (startDatabase === undefined) return decision;
  const endpoint = probed.endpoint;
  return { ...decision, prepare: () => startDatabase(endpoint) };
}

export const storeTestPolicy: PhaseTestPolicy = {
  name: "store-tests-need-a-container-runtime",
  description:
    "Drizzle store tests run against real Postgres: without a container runtime the red gate skips them with the " +
    "reason logged, and the green gate refuses (ADR 2026-064). At green a Drizzle tree also gets one throwaway, " +
    "migrated Postgres as DATABASE_URL for the run (the app smoke tests), removed afterwards.",
  decide: ({ project, phase }) => storeTestPhaseDecision(
    phase,
    drizzleStoreTests(project),
    () => probeContainerRuntime(),
    phase === "green" && drizzleContexts(project).length > 0,
    (endpoint) => startAppDatabase(project, endpoint),
  ),
};
