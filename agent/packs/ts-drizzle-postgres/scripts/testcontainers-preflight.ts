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
// through the SAME code path the store tests use: a `bun` child in the
// project, resolving `@testcontainers/postgresql` from the store tests' own
// directory, in the environment the test process gets (DOCKER_HOST, the
// Testcontainers properties, DOCKER_CONFIG and the Ryuk settings untouched).
// The pull has its own generous timeout, like the app database's. The child
// stops its container on every exit it controls; the parent removes anything
// still carrying this run's label after the child is gone, timeout included.
//
// A failure refuses green with the real cause, cleaned of secrets, and a
// concrete remedy. The same classifier runs over the green suite's failures
// afterwards: a store test that still fails for one of these causes routes
// to the orchestrator, never to a role.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
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
}

export interface DockerConfigFacts {
  readonly shownAs: string;
  readonly credsStore?: string;
  readonly credHelpers?: Readonly<Record<string, string>>;
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

/**
 * The cause as the user may see it: no ANSI, no stack frames, no secrets
 * (URL credentials, password/secret/token/auth values, bearer and basic
 * credentials), the home directory as `~`, one line, bounded. Pure.
 */
export function cleanCause(text: string, home = homedir()): string {
  const lines = text.replace(ANSI, "").split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !/^at\s/.test(line) && !/^\d+\s*\|/.test(line) && !/^\^+$/.test(line));
  let out = [...new Set(lines)].join(" ");
  out = out
    .replace(/:\/\/[^\s/@:]+:[^\s/@]+@/g, "://[redacted]@")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
    .replace(/(["']?\b(?:password|passwd|secret|identitytoken|identity_token|token|auth|authorization|x-registry-auth)\b["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, "$1[redacted]");
  if (home !== "" && home !== "/") out = out.split(home).join("~");
  out = out.replace(/\s+/g, " ").trim();
  return out.length > MAX_CAUSE ? `${out.slice(0, MAX_CAUSE - 1)}…` : out;
}

const shown = (endpoint: string, home: string): string => (home !== "" && home !== "/" ? endpoint.split(home).join("~") : endpoint);

/** The configuration key that names a helper, for the remedy. */
function helperKey(helper: string, config: DockerConfigFacts): string {
  const registries = Object.entries(config.credHelpers ?? {}).filter(([, name]) => name === helper).map(([registry]) => registry);
  if (config.credsStore !== helper && registries.length > 0) return `credHelpers '${registries.join("', '")}' → '${helper}'`;
  return `credsStore '${helper}'`;
}

/**
 * A recognised infrastructure cause in a container start's error text, or
 * undefined when the text is not clearly about the machine. Pure: the
 * environment reaches it only through `context`.
 */
export function recogniseInfrastructure(text: string, context: ClassifyContext): InfrastructureCause | undefined {
  const home = context.home ?? homedir();
  const cause = cleanCause(text, home);
  const helper = /docker-credential-([A-Za-z0-9._-]+)/.exec(text);
  if (helper !== null && /ENOENT|not found|no such file|executable file not found|Error from Docker credential provider/i.test(text)) {
    const name = helper[1]!.replace(/[.:]+$/, "");
    return {
      kind: "credential-helper",
      cause,
      remedy: `${context.dockerConfig.shownAs} names ${helperKey(name, context.dockerConfig)} but docker-credential-${name} is not on PATH: remove the line or install the helper`,
    };
  }
  if (/ryuk/i.test(text)) {
    return {
      kind: "reaper",
      cause,
      remedy: "Testcontainers' resource reaper (Ryuk) could not start: let the runtime run it (it mounts the Docker socket), " +
        "or, where it cannot (rootless runtimes), set TESTCONTAINERS_RYUK_DISABLED=true for the harness",
    };
  }
  const probed = context.endpoint !== undefined ? ` (the harness found one answering at ${shown(context.endpoint, home)})` : "";
  if (/Could not find a working container runtime strategy/i.test(text)) {
    return {
      kind: "no-runtime",
      cause,
      remedy: `Testcontainers found no container runtime${probed}: start the runtime, or point Testcontainers at it with ` +
        "DOCKER_HOST or docker.host in ~/.testcontainers.properties",
    };
  }
  if (/\bconnect (ECONNREFUSED|ENOENT|EACCES|EPERM)\b[^\n]*(docker|podman|\.sock\b|:2375|:2376)|docker\.sock[^\n]*(ECONNREFUSED|ENOENT|EACCES|EPERM)/i.test(text)) {
    return {
      kind: "socket",
      cause,
      remedy: `Testcontainers could not reach the Docker socket it chose${probed}: start the runtime, fix the socket's ` +
        "permissions, or point DOCKER_HOST (or docker.host in ~/.testcontainers.properties) at the runtime's socket",
    };
  }
  if (/Failed to pull image|pull access denied|manifest unknown|manifest for \S+ not found|toomanyrequests|unauthorized: |denied: |\bENOTFOUND\b|\bEAI_AGAIN\b|getaddrinfo|TLS handshake timeout|i\/o timeout|registry-1\.docker\.io|request canceled while waiting for connection/i.test(text)) {
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
 *  ran out of time, or the raw cause with a generic remedy. Pure. */
export function classifyPreflightFailure(text: string, stage: PreflightStage, timedOut: boolean, context: ClassifyContext): InfrastructureCause {
  const known = recogniseInfrastructure(text, context);
  if (known !== undefined) return known;
  if (timedOut) {
    const what = stage === "pull" ? `pulling ${context.image}` : stage === "runtime" ? "reaching the container runtime" : "starting and stopping the container";
    return {
      kind: stage === "pull" ? "pull" : "timeout",
      cause: cleanCause(text, context.home ?? homedir()) || `${what} did not finish in time`,
      remedy: stage === "pull"
        ? `pull the image ahead (\`docker pull ${context.image}\`) or check the network and registry access, then run green again`
        : "check that the runtime is healthy and not overloaded (`docker info`, `docker ps`), then run green again",
    };
  }
  return {
    kind: "other",
    cause: cleanCause(text, context.home ?? homedir()) || "the preflight exited without saying why",
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
// resolved from the store tests' directory. One JSON line per stage.
const CHILD = `
const { createRequire } = await import("node:module");
const say = (line) => process.stdout.write(JSON.stringify(line) + "\\n");
let stage = "runtime";
let container;
try {
  const from = createRequire(process.env.BOUNDED_PREFLIGHT_FROM);
  const postgresql = from.resolve("@testcontainers/postgresql");
  const { PostgreSqlContainer } = await import(postgresql);
  const { getContainerRuntimeClient, ImageName } = await import(createRequire(postgresql).resolve("testcontainers"));
  const image = process.env.BOUNDED_PREFLIGHT_IMAGE;
  const client = await getContainerRuntimeClient();
  say({ done: "runtime" });
  stage = "pull";
  await client.image.pull(ImageName.fromString(image));
  say({ done: "pull" });
  stage = "start";
  container = await new PostgreSqlContainer(image).withLabels(JSON.parse(process.env.BOUNDED_PREFLIGHT_LABELS)).start();
  const started = container;
  container = undefined;
  await started.stop();
  say({ done: "start" });
  process.exit(0);
} catch (error) {
  if (container !== undefined) { try { await container.stop(); } catch {} }
  const text = error instanceof Error ? (error.message + (error.cause ? "\\n" + String(error.cause) : "")) : String(error);
  say({ failed: stage, error: text });
  process.exit(1);
}
`;

export interface PreflightDeps {
  /** Run the child with these arguments; `timeoutFor(stage)` bounds each
   *  stage after the previous one reported done. */
  readonly child: (env: NodeJS.ProcessEnv, cwd: string, onLine: (line: string) => void, timeoutFor: () => number) => Promise<CommandResult & { timedOut: boolean }>;
  /** Remove every container with this run label, synchronously. Never throws. */
  readonly sweep: (runLabel: string, endpoint: string) => void;
  readonly suffix: () => string;
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
}

const STAGE_TIMEOUT: Readonly<Record<PreflightStage, number>> = { runtime: COMMAND_TIMEOUT_MS, pull: PULL_TIMEOUT_MS, start: START_TIMEOUT_MS };
const NEXT: Readonly<Record<PreflightStage, PreflightStage | undefined>> = { runtime: "pull", pull: "start", start: undefined };

/** The child under `bun -e`, each stage on its own clock. */
export function preflightChild(env: NodeJS.ProcessEnv, cwd: string, onLine: (line: string) => void, timeoutFor: () => number): Promise<CommandResult & { timedOut: boolean }> {
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

export const DEFAULT_PREFLIGHT_DEPS: PreflightDeps = {
  child: preflightChild,
  sweep: (runLabel, endpoint) => {
    const env = { ...process.env, ...(endpoint !== "" ? { DOCKER_HOST: endpoint, DOCKER_CONTEXT: "" } : {}) };
    const listed = spawnSync("docker", ["ps", "--all", "--quiet", "--filter", `label=${PREFLIGHT_RUN_LABEL}=${runLabel}`], { env, encoding: "utf8", timeout: COMMAND_TIMEOUT_MS });
    const ids = (listed.stdout ?? "").split("\n").map((id) => id.trim()).filter((id) => id !== "");
    if (ids.length > 0) spawnSync("docker", ["rm", "--force", "--volumes", ...ids], { env, stdio: "ignore", timeout: COMMAND_TIMEOUT_MS });
  },
  suffix: () => randomBytes(6).toString("hex"),
  get env() { return process.env; },
  home: homedir(),
};

export interface PreflightOptions {
  /** The image to start; the pinned one unless a test needs an uncached one. */
  readonly image?: string;
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
  const { testEnvironment } = await import("../../ts/scripts/run-tests.ts");
  const env: NodeJS.ProcessEnv = {
    ...testEnvironment(deps.env),
    BOUNDED_PREFLIGHT_FROM: join(project, storeTestFile),
    BOUNDED_PREFLIGHT_IMAGE: image,
    BOUNDED_PREFLIGHT_LABELS: JSON.stringify({ [PREFLIGHT_LABEL_KEY]: PREFLIGHT_LABEL_VALUE, [PREFLIGHT_RUN_LABEL]: run }),
  };
  let stage: PreflightStage = "runtime";
  let failure: string | undefined;
  let done = false;
  let result: CommandResult & { timedOut: boolean };
  try {
    result = await deps.child(env, project, (line) => {
      let parsed: { done?: unknown; failed?: unknown; error?: unknown };
      try {
        parsed = JSON.parse(line) as typeof parsed;
      } catch {
        return;
      }
      if (parsed.done === "start") done = true;
      else if (typeof parsed.done === "string" && parsed.done in NEXT) stage = NEXT[parsed.done as PreflightStage] ?? stage;
      if (typeof parsed.failed === "string") failure = typeof parsed.error === "string" ? parsed.error : "";
    }, () => STAGE_TIMEOUT[stage]);
  } catch (error) {
    result = { status: null, stdout: "", stderr: "", error: error instanceof Error ? error : new Error(String(error)), timedOut: false };
  } finally {
    try {
      deps.sweep(run, endpoint);
    } catch {
      // best effort: Ryuk, where enabled, also reaps the session's containers
    }
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
    image, endpoint, home: deps.home, dockerConfig: readDockerConfig(deps.env, deps.home),
  });
  throw new Error(preflightRefusal(found, image));
}

/**
 * The defence in depth: a green failure whose text is clearly the machine,
 * as `cause. Remedy: remedy`, or undefined. Only store-test failures (or
 * failures no file claims, such as an unhandled error) are judged: a
 * matching string elsewhere is ordinary test output.
 */
export function storeTestInfrastructureFailure(
  storeTests: readonly string[], context: Omit<ClassifyContext, "dockerConfig"> & { readonly dockerConfig?: DockerConfigFacts },
): (failure: TestFailure) => string | undefined {
  const files = new Set(storeTests);
  return (failure) => {
    if (failure.file !== undefined && !files.has(failure.file)) return undefined;
    const found = recogniseInfrastructure(`${failure.message ?? ""}`, { ...context, dockerConfig: context.dockerConfig ?? readDockerConfig() });
    return found === undefined ? undefined : `${failure.name}: ${found.cause}. Remedy: ${found.remedy}`;
  };
}
