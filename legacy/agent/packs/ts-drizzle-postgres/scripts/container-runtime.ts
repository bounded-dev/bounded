// Store tests and persisting apps' smoke tests need a container runtime at
// green only (ADR 2026-064, ADR 2026-072). This is the pack's half of that
// rule, for the red and green gates to call:
//
//   probeContainerRuntime  is a Docker-API runtime answering right now?
//   drizzleStoreTests      which test files in the project need one?
//   storeTestDecision      run, skip with a logged reason (red), or refuse (green)
//   storeTestPhaseDecision the same in the ts pack's policy shape, plus the
//                          builder's run_tests (build): green's preflight where
//                          it can start, and the store and app smoke tests
//                          left out, with the reason, where they cannot (no
//                          runtime, no migration yet)
//
// The probe is deterministic for a given environment and filesystem: it
// tries a fixed, ordered list of endpoints and asks each one the Docker API's
// `GET /_ping` and then `GET /version`, each within a bounded timeout. The
// version is answered by the daemon itself, unlike a front proxy or VM that
// answers the ping while the daemon behind it hangs (issue #52), so a hung
// engine is refused within seconds. It never starts anything. Whatever it
// misses fails closed: green refuses rather than running tests that could
// not start, and a runtime it finds but Testcontainers cannot use is caught
// by green's Testcontainers preflight (testcontainers-preflight.ts), which
// refuses with the machine's cause before any test runs.
//
// A refusal for the engine is routed to the user, in product terms: starting
// or restarting the engine on their own machine is the one environment step
// no role can take (ADR 2026-072). The gates never start a database of
// their own: each persisting app's smoke tests start theirs through the
// generated app-test-database support.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type PhaseTestDecision, type PhaseTestPolicy, type PreparedTestService, type TestEnvChange, type TestFailure, type TestPhase, USER_ROUTE } from "../../ts/pack.ts";
import { APP_DATABASE_ENV } from "./app-database.ts";
import { DRIZZLE, DRIZZLE_PREFIX, POSTGRES_IMAGE, RED_PHASE_TOKEN, STORE_TESTS_PHASE_ENV, STORE_TESTS_SKIP_ENV } from "./emit.ts";
import { preflightAllStoreTests, storeTestInfrastructureFailure } from "./testcontainers-preflight.ts";
import { CONTEXTS_DIR, drizzleContexts, MIGRATIONS_DIR } from "./check-db.ts";
import { appSmokeTests } from "../../ts-hexagonal/scripts/obligations.ts";

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
  /** Green only: do not run the suite; block with `reason`, routed to the
   *  user (the engine is their machine). Any later run removes `unsetEnv`
   *  from the child's environment. */
  | { readonly action: "refuse"; readonly reason: string; readonly unsetEnv: readonly string[]; readonly route: typeof USER_ROUTE };

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

/** Printed by the probe's child when the ping answered and the version did not. */
const NOT_RESPONDING = "NOT_RESPONDING";
/** Printed, with the status, when the version request was answered with an error. */
const VERSION_ERROR = "VERSION_ERROR";

// Runs in a child process so the probe can stay synchronous for the gates.
// Exit 0 when the endpoint answers `GET /_ping` and then `GET /version` with
// 200, each within the timeout; else prints why (NOT_RESPONDING when only
// the version did not come).
const PING = `
const http = require("node:http");
const endpoint = process.env.BOUNDED_PING_ENDPOINT;
const timeout = Number(process.env.BOUNDED_PING_TIMEOUT_MS);
let base;
if (endpoint.startsWith("unix://")) base = { socketPath: endpoint.slice(7) };
else { const url = new URL(endpoint.replace(/^tcp:/, "http:")); base = { host: url.hostname, port: url.port || 2375 }; }
function ask(path, onFail, then) {
  const request = http.get({ ...base, path, timeout }, (response) => {
    response.resume();
    if (response.statusCode === 200) return then();
    onFail("answered " + response.statusCode);
  });
  request.on("timeout", () => { request.destroy(); onFail("did not answer within " + timeout + "ms"); });
  request.on("error", (error) => onFail(error.code || error.message));
}
ask("/_ping", (why) => { console.log(why); process.exit(1); }, () =>
  ask("/version", (why) => {
    console.log(why.startsWith("answered ") ? "${VERSION_ERROR} " + why.slice(9) : "${NOT_RESPONDING}");
    process.exit(1);
  }, () => process.exit(0)));
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
  const hung: string[] = [];
  const erring: string[] = [];
  for (const endpoint of endpoints) {
    if (!/^(unix|tcp|http):\/\//.test(endpoint)) {
      failures.push(`${endpoint}: unsupported endpoint scheme`);
      continue;
    }
    // One child asks both questions; its own bound covers both.
    const run = spawnSync(process.execPath, ["-e", PING], {
      env: { PATH: env["PATH"] ?? "", BOUNDED_PING_ENDPOINT: endpoint, BOUNDED_PING_TIMEOUT_MS: String(timeoutMs) },
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 2 * timeoutMs + 2_000,
    });
    if (run.status === 0) return { available: true, endpoint };
    const said = (run.stdout ?? "").trim();
    if (said === NOT_RESPONDING) hung.push(endpoint);
    else if (said.startsWith(`${VERSION_ERROR} `)) erring.push(`(${said.slice(VERSION_ERROR.length + 1)}) at ${endpoint}`);
    else failures.push(`${endpoint}: ${said || (run.error?.message ?? `exit ${run.status}`)}`);
  }
  if (hung.length > 0) {
    return {
      available: false,
      reason: `the container engine is not responding: it answered a ping but not a request for its version within ${timeoutMs / 1000} s (${hung.join(", ")})`,
    };
  }
  if (erring.length > 0) {
    return {
      available: false,
      reason: `the container engine is failing: it answered a ping, but answered a request for its version with an error ${erring.join("; ")}`,
    };
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
    route: USER_ROUTE,
    reason: `green needs a container runtime: ${storeTests.length} Drizzle store test file(s) run against real Postgres ` +
      `(${storeTests.join(", ")}), and ${probe.reason}. ${engineRemedy(probe)}; ` +
      "store tests are never skipped at green (ADR 2026-064).",
  };
}

/** What the user does about an engine that is not available, in product
 *  terms (ADR 2026-072): start it, or restart it when it answers but hangs. */
export function engineRemedy(probe: Extract<ContainerRuntimeProbe, { available: false }>): string {
  return /not responding|is failing/.test(probe.reason)
    ? "The container engine is running but not answering properly: restart it"
    : "The container engine (Docker, or another Docker-API engine) isn't running: start it";
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

/** The reason green refuses a tree whose persisting apps have smoke tests
 *  but no runtime answers: each starts its own migrated Postgres. */
export function appDatabaseRefusal(probe: Extract<ContainerRuntimeProbe, { available: false }>): string {
  return `green needs a container runtime: the apps keep their data in Postgres, and their smoke tests each start a ` +
    `throwaway migrated database, and ${probe.reason}. ${engineRemedy(probe)} (ADR 2026-064, ADR 2026-072).`;
}

/** Drizzle contexts (project-relative dirs) whose migrations folder holds no
 *  migration yet: `generate_artifacts` writes them from the builder's schema. */
export function contextsWithoutMigrations(root: string): string[] {
  return drizzleContexts(root)
    .filter((context) => {
      const dir = join(context.path, MIGRATIONS_DIR);
      return !existsSync(dir) || !statSync(dir).isDirectory() || !readdirSync(dir).some((name) => name.endsWith(".sql"));
    })
    .map((context) => context.dir);
}

/** What the policy needs to decide one phase. */
export interface StoreTestPhaseOptions {
  readonly phase: TestPhase;
  /** Drizzle store test files, project-relative. */
  readonly storeTests: readonly string[];
  readonly probe: () => ContainerRuntimeProbe;
  /** The tree persists through Drizzle: its apps' smoke tests start their own
   *  database through the generated support. */
  readonly persists?: boolean;
  /** The app smoke tests, project-relative (read only when `persists`). */
  readonly smokeTests?: readonly string[];
  /** Start and stop one container through the given test files' own
   *  Testcontainers, before the run; rejects with the refusal. */
  readonly preflight?: (endpoint: string, env: TestEnvChange, files: readonly string[]) => Promise<PreparedTestService>;
  /** The classifier over the given test files (store and persisting smoke
   *  tests) that tells the machine's failures from the code's. */
  readonly infrastructureFailure?: (endpoint: string, files: readonly string[]) => (failure: TestFailure) => string | undefined;
  /** Build only: contexts with no committed migration yet. */
  readonly missingMigrations?: readonly string[];
}

/**
 * The builder's run (`build`, issue #48): what green will run, where it can
 * run. Before every context has a migration, or without a container runtime,
 * the store tests and the persisting apps' smoke tests are left out with the
 * reason (green runs them, so the builder is not told a failure is theirs
 * that is the machine's or a missing generation step's). Otherwise the run
 * starts green's preflight; a start that fails blocks the run with its reason.
 */
function buildDecision(options: StoreTestPhaseOptions, files: readonly string[]): PhaseTestDecision {
  if (files.length === 0) return { action: "run", unsetEnv: STORE_TEST_ENV };
  const leaveOut = (why: string): PhaseTestDecision => ({
    action: "run",
    unsetEnv: STORE_TEST_ENV,
    exclude: { files, reason: `${files.length} test file(s) that need Postgres are left out of this run: ${why}. They are not skipped: green runs them (ADR 2026-064)` },
  });
  const missing = options.missingMigrations ?? [];
  if (missing.length > 0) {
    return leaveOut(`${missing.join(", ")} ${missing.length === 1 ? "has" : "have"} no migration yet; the architect's generate_artifacts writes them from your schema`);
  }
  const probed = options.probe();
  if (!probed.available) return leaveOut(probed.reason);
  return withPreflight({ action: "run", unsetEnv: STORE_TEST_ENV }, options, probed.endpoint, files);
}

/** A run decision with the preflight and the classifier, both over every
 *  test that needs the engine, on the probed endpoint. */
function withPreflight(
  decision: Extract<PhaseTestDecision, { action: "run" }>, options: StoreTestPhaseOptions, endpoint: string, files: readonly string[],
): PhaseTestDecision {
  const classified = files.length > 0 && options.infrastructureFailure !== undefined
    ? { infrastructureFailure: options.infrastructureFailure(endpoint, files) } : {};
  const preflight = options.preflight;
  if (preflight === undefined) return { ...decision, ...classified };
  return { ...decision, ...classified, prepare: (env) => preflight(endpoint, env, files) };
}

/**
 * ADR 2026-064 (amended by ADR 2026-072) in the ts pack's
 * `phaseTestPolicies` shape. The runtime is probed only when the tree has
 * tests that need it (store tests, or a persisting tree's app smoke tests at
 * green), before anything is prepared. At green with a runtime, the gate
 * (just before the run) has their Testcontainers start and stop one
 * container (`preflight`), so a machine that cannot is refused with its
 * cause before any test runs; with store tests, green also gets the
 * classifier that tells a store test failed by the machine from one failed
 * by the code (`infrastructureFailure`). Without a runtime, green refuses,
 * routed to the user. The gate starts no database itself.
 */
export function storeTestPhaseDecision(options: StoreTestPhaseOptions): PhaseTestDecision {
  const decision = phaseDecision(options);
  // A persisting tree's green and build runs never see an inherited
  // DATABASE_URL: the apps' smoke tests set their own (ADR 2026-072).
  if (options.persists !== true || options.phase === "red" || decision.action === "skip") return decision;
  return { ...decision, unsetEnv: [...decision.unsetEnv, APP_DATABASE_ENV] };
}

function phaseDecision(options: StoreTestPhaseOptions): PhaseTestDecision {
  const { phase, storeTests } = options;
  const smokeTests = options.persists === true ? options.smokeTests ?? [] : [];
  const files = [...storeTests, ...smokeTests];
  if (phase === "build") return buildDecision(options, files);
  const needsRuntime = storeTests.length > 0 || (phase === "green" && smokeTests.length > 0);
  const probed = needsRuntime ? options.probe() : { available: true as const, endpoint: "(not probed)" };
  const decision = storeTestDecision(phase === "red" ? "red" : "green", storeTests, probed);
  if (decision.action === "skip") {
    return { action: "skip", reason: decision.reason, env: decision.env, unsetEnv: STORE_TEST_ENV, skippedTest: isSkippedStoreTest };
  }
  if (decision.action === "refuse") return decision;
  if (phase !== "green" || files.length === 0) return decision;
  if (!probed.available) return { action: "refuse", reason: appDatabaseRefusal(probed), unsetEnv: STORE_TEST_ENV, route: USER_ROUTE };
  return withPreflight(decision, options, probed.endpoint, files);
}

export const storeTestPolicy: PhaseTestPolicy = {
  name: "store-tests-need-a-container-runtime",
  description:
    "Drizzle store tests, and the smoke tests of apps that keep their data in Postgres, run against real Postgres: " +
    "without a container runtime the red gate skips the store tests with the reason logged, and the green gate " +
    "refuses, routed to the user (ADR 2026-064, ADR 2026-072). The runtime is probed (a ping and the engine's " +
    "version) before anything starts. The builder's run_tests gets what green gets where it can start, and " +
    "otherwise leaves those tests out with the reason (no runtime, or no migration generated yet). At green, their " +
    "Testcontainers first start and stop one container (a preflight that refuses with the machine's cause), and a " +
    "store test failed by the machine routes to the user, not a role. The gate starts no database: each app's " +
    "smoke tests start their own through the generated support.",
  decide: ({ project, phase }) => {
    const storeTests = drizzleStoreTests(project);
    const persists = phase !== "red" && drizzleContexts(project).length > 0;
    const smokeTests = persists ? appSmokeTests(project) : [];
    return storeTestPhaseDecision({
      phase,
      storeTests,
      persists,
      smokeTests,
      probe: () => probeContainerRuntime(),
      preflight: (endpoint, env, files) => preflightAllStoreTests(project, files, endpoint, env),
      infrastructureFailure: (endpoint, files) => storeTestInfrastructureFailure(files, { image: POSTGRES_IMAGE, endpoint }),
      ...(phase === "build" ? { missingMigrations: contextsWithoutMigrations(project) } : {}),
    });
  },
};
