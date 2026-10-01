// Green's Testcontainers preflight, and the infrastructure-failure classifier
// (ADR 2026-064, amended).
//
// At green a Postgres project starts containers two ways: the gate's own
// throwaway app database through the docker CLI (app-database.ts), and the
// store tests through Testcontainers, inside the generated test support. The
// two can disagree: a credential helper named in the Docker config but
// missing from PATH, a registry out of reach, a socket Testcontainers does
// not look at, or a resource reaper (Ryuk) that cannot start all break only
// the second. Those failures used to look like failing store tests and went
// to the builder, who cannot fix a machine.
//
// So before green runs any test, when store tests exist and a runtime
// answers, the policy starts and stops one container from the pinned image
// through the SAME code path the store tests use, once per distinct
// Testcontainers installation the contexts with store tests resolve:
//
//   · the same `bun` on PATH, in the project, with the environment the test
//     process gets (the gate's test environment with the policies' set and
//     unset applied), so DOCKER_HOST, the Testcontainers properties,
//     DOCKER_CONFIG and the Ryuk settings are exactly the tests';
//   · `@testcontainers/postgresql` resolved from the store tests' own
//     directory, the module the generated support imports;
//   · `bun -e` rather than `bun test`: the test run adds only a preload that
//     silences console output, which Testcontainers does not read.
//
// The pull has its own generous timeout, like the app database's. The child
// removes its container itself on every exit it controls, through the client
// Testcontainers resolved; the parent then sweeps this run's label on the
// runtime the child reported using, and once more after a grace period when
// the child was killed, for a create that was still in flight.
//
// A failure refuses green with the real cause, cleaned of secrets, and a
// concrete remedy. The same classifier is green's backstop over the suite's
// failures. It is deliberately conservative: it claims only text that Docker
// or Testcontainers themselves produce, and when unsure it leaves the
// failure with the builder.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { PreparedTestService, TestFailure } from "../../ts/pack.ts";
import { COMMAND_TIMEOUT_MS, PULL_TIMEOUT_MS, runChild, type CommandResult } from "./app-database.ts";
import { POSTGRES_IMAGE } from "./emit.ts";

/** Every preflight container carries this label and a per-run one. */
export const PREFLIGHT_LABEL_KEY = "dev.bounded.role";
export const PREFLIGHT_LABEL_VALUE = "green-testcontainers-preflight";
export const PREFLIGHT_RUN_LABEL = "dev.bounded.preflight-run";
/** Start and stop, after the pull: the generated support's own start budget. */
export const START_TIMEOUT_MS = 180_000;
/** How long after a killed child the parent sweeps again. */
export const SWEEP_GRACE_MS = 3_000;

export type PreflightStage = "runtime" | "pull" | "start";

export type InfrastructureKind = "credential-helper" | "no-runtime" | "socket" | "reaper" | "pull" | "timeout" | "other";

export interface InfrastructureCause {
  readonly kind: InfrastructureKind;
  /** The underlying error, cleaned of secrets and machine paths. */
  readonly cause: string;
  /** What the user can do about it. */
  readonly remedy: string;
}

/** What the classifier knows about the machine. */
export interface ClassifyContext {
  readonly image: string;
  /** Where the Docker config is, as shown to the user, and what it names. */
  readonly dockerConfig: DockerConfigFacts;
  /** The endpoint the harness's own probe found answering, if any. */
  readonly endpoint?: string;
  readonly home?: string;
  readonly temp?: string;
}

export interface DockerConfigFacts {
  readonly shownAs: string;
  readonly credsStore?: string;
  readonly credHelpers?: Readonly<Record<string, string>>;
}

/** The test run's environment change, as the gate applies it. */
export interface EnvChange {
  readonly set: Readonly<Record<string, string>>;
  readonly unset: readonly string[];
}

/** The Docker config Testcontainers reads (DOCKER_CONFIG, else ~/.docker),
 *  shown without the user's paths. An unreadable file names nothing. */
export function readDockerConfig(env: NodeJS.ProcessEnv = process.env, home = homedir()): DockerConfigFacts {
  const custom = (env["DOCKER_CONFIG"] ?? "") !== "";
  const file = join(custom ? env["DOCKER_CONFIG"]! : join(home, ".docker"), "config.json");
  const shownAs = custom ? "$DOCKER_CONFIG/config.json" : "~/.docker/config.json";
  if (!existsSync(file)) return { shownAs };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { credsStore?: unknown; credHelpers?: unknown };
    const credsStore = typeof parsed.credsStore === "string" && parsed.credsStore !== "" ? parsed.credsStore : undefined;
    const credHelpers = parsed.credHelpers !== null && typeof parsed.credHelpers === "object"
      ? Object.fromEntries(Object.entries(parsed.credHelpers as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"))
      : undefined;
    return { shownAs, ...(credsStore !== undefined ? { credsStore } : {}), ...(credHelpers !== undefined ? { credHelpers } : {}) };
  } catch {
    return { shownAs };
  }
}

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, "g");
const MAX_CAUSE = 600;
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Tokens recognisable by their prefix alone (GitHub, GitLab, Slack, npm,
 *  Docker Hub, AWS access keys, OpenAI-style keys, JWTs). */
const TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|glpat-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|npm_[A-Za-z0-9]{20,}|dckr_pat_[A-Za-z0-9_-]{10,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*)/g;
/** `name=value` and `name: value` where the name says it holds a secret. */
const SECRET_FIELD = /(\b[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|key|auth|authorization)[A-Za-z0-9_.-]*\b["']?\s*[:=]\s*["']?)(?!\[redacted\])[^\s"',;}]+/gi;

/**
 * The cause as the user may see it: no ANSI, no stack or code frames, no
 * secrets (URL credentials up to the last `@` before the host, secret-named
 * fields in any case, bearer and basic credentials, prefixed tokens), no
 * absolute machine paths (home, the temp directory, /private/var/folders,
 * /var/folders, /tmp, /Users, /home, /root), one line, bounded. Pure.
 */
export function cleanCause(text: string, home = homedir(), temp = tmpdir()): string {
  const lines = text.replace(ANSI, "").split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !/^at\s/.test(line) && !/^\d+\s*\|/.test(line) && !/^\^+$/.test(line));
  let out = [...new Set(lines)].join(" ");
  out = out
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi, "$1[redacted]@")
    .replace(TOKEN, "[redacted]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
    .replace(SECRET_FIELD, "$1[redacted]");
  const roots = [temp, home].filter((root) => root !== "" && root !== "/").map(escapeRegExp);
  const paths = new RegExp(
    `(?<![\\w.-])(?:${[...roots, "(?:/private)?/var/folders", "(?:/private)?/tmp", "/Users", "/home", "/root"].join("|")})(?=/|$|[\\s"'\`(),;:])[^\\s"'\`(),;]*`,
    "g",
  );
  out = out.replace(paths, "[path]").replace(/\s+/g, " ").trim();
  return out.length > MAX_CAUSE ? `${out.slice(0, MAX_CAUSE - 1)}…` : out;
}

const shown = (endpoint: string, home: string): string => (home !== "" && home !== "/" ? endpoint.split(home).join("~") : endpoint);

/** The configuration key that names a helper, for the remedy. */
function helperKey(helper: string, config: DockerConfigFacts): string {
  const registries = Object.entries(config.credHelpers ?? {}).filter(([, name]) => name === helper).map(([registry]) => registry);
  if (config.credsStore !== helper && registries.length > 0) return `credHelpers '${registries.join("', '")}' → '${helper}'`;
  return `credsStore '${helper}'`;
}

// Only text Docker or Testcontainers produce. Each pattern names its source.
/** Testcontainers' own wrapper around a credential helper's failure. */
const TC_CREDENTIAL = /Error from Docker credential provider/;
/** A credential helper the OS could not execute: Node/Bun's spawn, or the docker CLI's exec. */
const HELPER_MISSING = /\bspawn docker-credential-[\w.-]+ ENOENT\b|Executable not found in \$PATH: "docker-credential-|exec: "docker-credential-[\w.-]+": executable file not found in \$PATH/;
/** Testcontainers, when no strategy finds a runtime. */
const TC_NO_RUNTIME = /Could not find a working container runtime strategy/;
/** A refused or missing Docker-API socket by its exact path, or the Docker daemon's TCP ports. */
const DOCKER_SOCKET = /\bconnect (?:ECONNREFUSED|ENOENT|EACCES|EPERM) (?:\S*\/)?(?:docker|podman)\.sock\b|\bconnect ECONNREFUSED [\w.:[\]]*:(?:2375|2376)\b(?![\d.])/;
/** Testcontainers' reaper: its connect failure, its port check, its image and container names. */
const TC_REAPER = /Failed to connect to Reaper|Expected Reaper to map exposed port|\btestcontainers\/ryuk\b|\btestcontainers-ryuk-[0-9a-f-]+/;
/** A registry's or the Docker daemon's own pull phrasing. */
const REGISTRY = /\bpull access denied for \S+, repository does not exist|\bmanifest for \S+ not found: manifest unknown|\bmanifest unknown: manifest unknown\b|\btoomanyrequests: You have reached your pull rate limit|\bunauthorized: (?:authentication required|incorrect username or password)\b|\bdenied: requested access to the resource is denied\b|\(HTTP code \d{3}\) [\w ]+ - Get "https?:\/\/[^"\s]+\/v2\/[^"\s]*"|\bregistry-1\.docker\.io\b|Failed to pull image "/;

export interface RecogniseOptions {
  /** Only the patterns no test could plausibly print itself: for failures
   *  no test file claims. */
  readonly narrow?: boolean;
}

/**
 * A recognised infrastructure cause in a container start's error text, or
 * undefined when the text is not clearly about the machine. Pure: the
 * environment reaches it only through `context`.
 */
export function recogniseInfrastructure(text: string, context: ClassifyContext, options: RecogniseOptions = {}): InfrastructureCause | undefined {
  const home = context.home ?? homedir();
  const cause = cleanCause(text, home, context.temp ?? tmpdir());
  const helper = /docker-credential-([\w.-]+)/.exec(text);
  // Narrow: only Testcontainers' own wrapper. Full: that, or the OS's own
  // words for a helper it could not execute.
  const helperFailed = TC_CREDENTIAL.test(text) || (options.narrow !== true && HELPER_MISSING.test(text));
  if (helper !== null && helperFailed) {
    const name = helper[1]!.replace(/[.:]+$/, "");
    return {
      kind: "credential-helper",
      cause,
      remedy: `${context.dockerConfig.shownAs} names ${helperKey(name, context.dockerConfig)} but docker-credential-${name} is not on PATH: remove the line or install the helper`,
    };
  }
  const probed = context.endpoint !== undefined ? ` (the harness found one answering at ${shown(context.endpoint, home)})` : "";
  if (TC_NO_RUNTIME.test(text)) {
    return {
      kind: "no-runtime",
      cause,
      remedy: `Testcontainers found no container runtime${probed}: start the runtime, or point Testcontainers at it with ` +
        "DOCKER_HOST or docker.host in ~/.testcontainers.properties",
    };
  }
  if (options.narrow === true) return undefined;
  if (TC_REAPER.test(text)) {
    return {
      kind: "reaper",
      cause,
      remedy: "Testcontainers' resource reaper (Ryuk) could not start: let the runtime run it (it mounts the Docker socket), " +
        "or, where it cannot (rootless runtimes), set TESTCONTAINERS_RYUK_DISABLED=true for the harness",
    };
  }
  if (DOCKER_SOCKET.test(text)) {
    return {
      kind: "socket",
      cause,
      remedy: `Testcontainers could not reach the Docker socket it chose${probed}: start the runtime, fix the socket's ` +
        "permissions, or point DOCKER_HOST (or docker.host in ~/.testcontainers.properties) at the runtime's socket",
    };
  }
  if (REGISTRY.test(text)) {
    return {
      kind: "pull",
      cause,
      remedy: `the image could not be pulled: check the network and registry access (\`docker pull ${context.image}\` shows the ` +
        "registry's own answer), log in if the registry needs it, or configure the runtime's proxy or mirror",
    };
  }
  return undefined;
}

/** Every failure the preflight can report: a recognised cause, a stage that
 *  ran out of time, or the raw cause with a generic remedy. Pure. In the
 *  preflight the text is the container start's own error, never a test's. */
export function classifyPreflightFailure(text: string, stage: PreflightStage, timedOut: boolean, context: ClassifyContext): InfrastructureCause {
  const known = recogniseInfrastructure(text, context);
  if (known !== undefined) return known;
  const clean = (): string => cleanCause(text, context.home ?? homedir(), context.temp ?? tmpdir());
  if (stage === "pull" && !timedOut && text !== "") {
    return {
      kind: "pull",
      cause: clean(),
      remedy: `the image could not be pulled: check the network and registry access (\`docker pull ${context.image}\` shows the ` +
        "registry's own answer), log in if the registry needs it, or configure the runtime's proxy or mirror",
    };
  }
  if (timedOut) {
    const what = stage === "pull" ? `pulling ${context.image}` : stage === "runtime" ? "reaching the container runtime" : "starting and stopping the container";
    return {
      kind: stage === "pull" ? "pull" : "timeout",
      cause: clean() || `${what} did not finish in time`,
      remedy: stage === "pull"
        ? `pull the image ahead (\`docker pull ${context.image}\`) or check the network and registry access, then run green again`
        : "check that the runtime is healthy and not overloaded (`docker info`, `docker ps`), then run green again",
    };
  }
  return {
    kind: "other",
    cause: clean() || "the preflight exited without saying why",
    remedy: `run \`docker run --rm ${context.image} postgres --version\` to see the runtime's own error, fix it, and run green again`,
  };
}

/** The refusal text for a failed preflight. */
export function preflightRefusal(found: InfrastructureCause, image: string): string {
  return `Testcontainers, which the store tests start Postgres through, could not start a ${image} container on this ` +
    `machine (green's preflight, before any test ran): ${found.cause}. Remedy: ${found.remedy}. This is the machine, ` +
    "not the code: no role can fix it (ADR 2026-064).";
}

// The child: one container through the store tests' own Testcontainers,
// resolved from the store tests' directory. One JSON line per stage; the
// runtime stage reports the Docker host Testcontainers' client resolved.
// Whatever happens after the client exists, it removes every container with
// this run's label through that same client before exiting.
const CHILD = `
const { createRequire } = await import("node:module");
const say = (line) => process.stdout.write(JSON.stringify(line) + "\\n");
const labels = JSON.parse(process.env.BOUNDED_PREFLIGHT_LABELS);
const runLabel = process.env.BOUNDED_PREFLIGHT_RUN_LABEL;
let stage = "runtime";
let client;
async function sweep() {
  if (client === undefined) return;
  try {
    const docker = client.container.dockerode;
    const found = await docker.listContainers({ all: true, filters: { label: [runLabel + "=" + labels[runLabel]] } });
    for (const info of found) { try { await docker.getContainer(info.Id).remove({ force: true, v: true }); } catch {} }
  } catch {}
}
try {
  const from = createRequire(process.env.BOUNDED_PREFLIGHT_FROM);
  const postgresql = from.resolve("@testcontainers/postgresql");
  const { PostgreSqlContainer } = await import(postgresql);
  const { getContainerRuntimeClient, ImageName } = await import(createRequire(postgresql).resolve("testcontainers"));
  const image = process.env.BOUNDED_PREFLIGHT_IMAGE;
  client = await getContainerRuntimeClient();
  const modem = client.container.dockerode.modem ?? {};
  const host = modem.socketPath ? "unix://" + modem.socketPath : modem.host ? "tcp://" + modem.host + ":" + (modem.port ?? 2375) : "";
  say({ done: "runtime", host });
  stage = "pull";
  await client.image.pull(ImageName.fromString(image));
  say({ done: "pull" });
  stage = "start";
  const container = await new PostgreSqlContainer(image).withLabels(labels).start();
  await container.stop();
  await sweep();
  say({ done: "start" });
  process.exit(0);
} catch (error) {
  await sweep();
  const text = error instanceof Error ? (error.message + (error.cause ? "\\n" + String(error.cause) : "")) : String(error);
  say({ failed: stage, error: text });
  process.exit(1);
}
`;

export type ChildResult = CommandResult & { readonly timedOut: boolean };

export interface PreflightDeps {
  /** Run the child; `timeoutFor()` bounds the current stage, re-read after
   *  every line the child prints. */
  readonly child: (env: NodeJS.ProcessEnv, cwd: string, onLine: (line: string) => void, timeoutFor: () => number) => Promise<ChildResult>;
  /** Remove every container with this run label on `host` (empty: the
   *  environment's default), synchronously. Never throws. */
  readonly sweep: (runLabel: string, host: string) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly suffix: () => string;
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
}

const STAGE_TIMEOUT: Readonly<Record<PreflightStage, number>> = { runtime: COMMAND_TIMEOUT_MS, pull: PULL_TIMEOUT_MS, start: START_TIMEOUT_MS };
const NEXT: Readonly<Record<PreflightStage, PreflightStage | undefined>> = { runtime: "pull", pull: "start", start: undefined };

/** The child under `bun -e`, each stage on its own clock. */
export function preflightChild(env: NodeJS.ProcessEnv, cwd: string, onLine: (line: string) => void, timeoutFor: () => number): Promise<ChildResult> {
  return new Promise((resolve) => {
    // runChild gives the overall bound; the per-stage clock is ours.
    const total = STAGE_TIMEOUT.runtime + STAGE_TIMEOUT.pull + STAGE_TIMEOUT.start;
    let timedOut = false;
    let buffered = "";
    let timer: NodeJS.Timeout | undefined;
    let kill: (() => void) | undefined;
    const arm = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => { timedOut = true; kill?.(); }, timeoutFor());
    };
    arm();
    void runChild("bun", ["-e", CHILD], {
      cwd, env, timeoutMs: total,
      onSpawn: (child) => {
        kill = () => child.kill("SIGKILL");
        child.stdout?.on("data", (d: Buffer) => {
          buffered += d.toString();
          let at: number;
          while ((at = buffered.indexOf("\n")) >= 0) {
            onLine(buffered.slice(0, at));
            buffered = buffered.slice(at + 1);
            arm();
          }
        });
      },
    }).then((result) => {
      if (timer !== undefined) clearTimeout(timer);
      resolve({ ...result, timedOut: timedOut || (result.status === null && result.error !== undefined && /timed out/.test(result.error.message)) });
    });
  });
}

/** The docker CLI's label sweep against one host. */
export function sweepWithDockerCli(runLabel: string, host: string): void {
  const env = { ...process.env, ...(host !== "" ? { DOCKER_HOST: host, DOCKER_CONTEXT: "" } : {}) };
  const listed = spawnSync("docker", ["ps", "--all", "--quiet", "--filter", `label=${PREFLIGHT_RUN_LABEL}=${runLabel}`], { env, encoding: "utf8", timeout: COMMAND_TIMEOUT_MS });
  const ids = (listed.stdout ?? "").split("\n").map((id) => id.trim()).filter((id) => id !== "");
  if (ids.length > 0) spawnSync("docker", ["rm", "--force", "--volumes", ...ids], { env, stdio: "ignore", timeout: COMMAND_TIMEOUT_MS });
}

export const DEFAULT_PREFLIGHT_DEPS: PreflightDeps = {
  child: preflightChild,
  sweep: sweepWithDockerCli,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  suffix: () => randomBytes(6).toString("hex"),
  get env() { return process.env; },
  home: homedir(),
};

export interface PreflightOptions {
  /** The image to start; the pinned one unless a test needs an uncached one. */
  readonly image?: string;
  /** The test run's environment change (the policies' set and unset). */
  readonly change?: EnvChange;
}

/**
 * Start and stop one container through the store tests' Testcontainers,
 * from `storeTestFile`'s directory in `project`. Resolves with a service
 * that holds nothing (the container is already gone); rejects with the
 * refusal text. Whatever happens, anything still labelled with this run is
 * removed before it settles.
 */
export async function preflightTestcontainers(
  project: string, storeTestFile: string, endpoint: string, deps: PreflightDeps = DEFAULT_PREFLIGHT_DEPS, options: PreflightOptions = {},
): Promise<PreparedTestService> {
  const image = options.image ?? POSTGRES_IMAGE;
  const run = deps.suffix();
  // Imported here, not at the top: run-tests reaches the composed packs, and
  // this module loads while this pack is being composed.
  const { adjustedEnvironment, testEnvironment } = await import("../../ts/scripts/run-tests.ts");
  const env: NodeJS.ProcessEnv = {
    ...adjustedEnvironment(testEnvironment(deps.env), options.change ?? { set: {}, unset: [] }),
    BOUNDED_PREFLIGHT_FROM: join(project, storeTestFile),
    BOUNDED_PREFLIGHT_IMAGE: image,
    BOUNDED_PREFLIGHT_RUN_LABEL: PREFLIGHT_RUN_LABEL,
    BOUNDED_PREFLIGHT_LABELS: JSON.stringify({ [PREFLIGHT_LABEL_KEY]: PREFLIGHT_LABEL_VALUE, [PREFLIGHT_RUN_LABEL]: run }),
  };
  let stage: PreflightStage = "runtime";
  let failure: string | undefined;
  let host: string | undefined;
  let done = false;
  let result: ChildResult;
  try {
    result = await deps.child(env, project, (line) => {
      let parsed: { done?: unknown; failed?: unknown; error?: unknown; host?: unknown };
      try {
        parsed = JSON.parse(line) as typeof parsed;
      } catch {
        return;
      }
      if (typeof parsed.host === "string" && parsed.host !== "") host = parsed.host;
      if (parsed.done === "start") done = true;
      else if (typeof parsed.done === "string" && parsed.done in NEXT) stage = NEXT[parsed.done as PreflightStage] ?? stage;
      if (typeof parsed.failed === "string") failure = typeof parsed.error === "string" ? parsed.error : "";
    }, () => STAGE_TIMEOUT[stage]);
  } catch (error) {
    result = { status: null, stdout: "", stderr: "", error: error instanceof Error ? error : new Error(String(error)), timedOut: false };
  }
  // The runtime Testcontainers used, else the one the probe found.
  const sweepHost = host ?? endpoint;
  const sweep = (): void => {
    try {
      deps.sweep(run, sweepHost);
    } catch {
      // best effort: Ryuk, where enabled, also reaps the session's containers
    }
  };
  sweep();
  // A killed child may have had a create request in flight.
  if (result.status === null) {
    await deps.sleep(SWEEP_GRACE_MS);
    sweep();
  }
  if (result.status === 0 && done) {
    return {
      description: `Testcontainers preflight: started and removed a ${image} container through the store tests' own Testcontainers`,
      env: {},
      release: () => {},
    };
  }
  const text = failure ?? (result.timedOut ? "" : result.error !== undefined
    ? (/ENOENT/.test(result.error.message) ? "bun is not on PATH, so the preflight could not run" : result.error.message)
    : (result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`));
  const found = classifyPreflightFailure(text, stage, result.timedOut, {
    image, endpoint: sweepHost, home: deps.home, dockerConfig: readDockerConfig(deps.env, deps.home),
  });
  throw new Error(preflightRefusal(found, image));
}

/** Where a store test's `@testcontainers/postgresql` resolves from, or
 *  undefined when it does not resolve there. */
export function testcontainersResolution(project: string, storeTestFile: string): string | undefined {
  try {
    return createRequire(join(project, storeTestFile)).resolve("@testcontainers/postgresql");
  } catch {
    return undefined;
  }
}

/** One store test per distinct Testcontainers resolution, in order; a test
 *  whose resolution fails is its own group (its preflight says why). */
export function preflightTargets(storeTests: readonly string[], resolve: (file: string) => string | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const file of storeTests) {
    const key = resolve(file) ?? `unresolved:${file.split("/").slice(0, 2).join("/")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(file);
  }
  return out;
}

/** The preflight for every distinct Testcontainers the store tests use. */
export async function preflightAllStoreTests(
  project: string, storeTests: readonly string[], endpoint: string, change: EnvChange,
  preflight: (file: string) => Promise<PreparedTestService> = (file) => preflightTestcontainers(project, file, endpoint, DEFAULT_PREFLIGHT_DEPS, { change }),
  resolve: (file: string) => string | undefined = (file) => testcontainersResolution(project, file),
): Promise<PreparedTestService> {
  const descriptions: string[] = [];
  for (const file of preflightTargets(storeTests, resolve)) descriptions.push((await preflight(file)).description);
  return { description: [...new Set(descriptions)].join("; "), env: {}, release: () => {} };
}

/**
 * The backstop: a green failure whose text is clearly the machine, as
 * `cause. Remedy: remedy`, or undefined. Only store-test failures are judged
 * in full; a failure no file claims (an unhandled error) gets only the
 * narrowest patterns, and a failure in any other test file none.
 */
export function storeTestInfrastructureFailure(
  storeTests: readonly string[], context: Omit<ClassifyContext, "dockerConfig"> & { readonly dockerConfig?: DockerConfigFacts },
): (failure: TestFailure) => string | undefined {
  const files = new Set(storeTests);
  return (failure) => {
    if (failure.file !== undefined && !files.has(failure.file)) return undefined;
    const found = recogniseInfrastructure(failure.message ?? "", { ...context, dockerConfig: context.dockerConfig ?? readDockerConfig() }, {
      narrow: failure.file === undefined,
    });
    return found === undefined ? undefined : `${failure.name}: ${found.cause}. Remedy: ${found.remedy}`;
  };
}
