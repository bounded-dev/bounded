// Green's Testcontainers preflight, and the infrastructure-failure classifier
// (ADR LEG-2026-064, amended by ADR LEG-2026-072).
//
// At green a Postgres project starts containers through Testcontainers, inside
// the generated test support: the store tests' and each persisting app's
// smoke tests'. A credential helper named in the Docker config but missing
// from PATH, a registry out of reach, a socket Testcontainers does not look
// at, or a resource reaper (Ryuk) that cannot start used to look like
// failing tests and went to the builder, who cannot fix a machine.
//
// So before green runs any test, when such tests exist and a runtime answers,
// the policy starts and stops one container from the pinned image through the
// SAME code path the tests use, once per distinct Testcontainers installation
// their directories resolve:
//
//   · the same `bun` on PATH, in the project, with the environment the test
//     process gets (the gate's test environment with the policies' set and
//     unset applied), so DOCKER_HOST, the Testcontainers properties,
//     DOCKER_CONFIG and the Ryuk settings are exactly the tests';
//   · `@testcontainers/postgresql` resolved from the test's own directory,
//     the module the generated support imports;
//   · `bun -e` rather than `bun test`: the test run adds only a preload that
//     silences console output, which Testcontainers does not read.
//
// No stage outlives the host's call (issue #52). Each stage runs on its own
// clock, never longer than what is left of the call's budget (the core's
// callBudgetMs of the host's deadline): runtime 60 s, start 180 s, and the
// pull a stall clock of 60 s re-armed by every line of Testcontainers' own
// pull progress (its `testcontainers:pull` log, forwarded by the child), and
// capped at 30 minutes overall. A stage whose minimum no longer fits the
// budget is refused before it starts, routed to the calling role, which calls
// the gate again with a longer timeout. The child removes its container
// itself on every exit it controls, through the client Testcontainers
// resolved; the parent then sweeps this run's label on the runtime the child
// reported using, and once more after a grace period when the child was
// killed, for a create that was still in flight.
//
// A failure refuses green with the real cause, cleaned of secrets, and a
// remedy in product terms, routed to the user: the machine is theirs, and no
// role can fix it (ADR LEG-2026-072). The same classifier is green's backstop
// over the suite's failures. It is deliberately conservative: it claims only
// text that Docker or Testcontainers themselves produce, and when unsure it
// leaves the failure with the builder.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { callBudgetMs, commandTimeoutMs } from "../../../src/host.ts";
import { type PreparedTestService, type TestFailure, userRoutedError } from "../../ts/pack.ts";
import { COMMAND_TIMEOUT_MS, runChild, type CommandResult } from "./app-database.ts";
import { POSTGRES_IMAGE } from "./emit.ts";

/** Every preflight container carries this label and a per-run one. */
export const PREFLIGHT_LABEL_KEY = "dev.bounded.role";
export const PREFLIGHT_LABEL_VALUE = "green-testcontainers-preflight";
export const PREFLIGHT_RUN_LABEL = "dev.bounded.preflight-run";
/** Start and stop, after the pull: the generated support's own start budget. */
export const START_TIMEOUT_MS = 180_000;
/** The pull's stall clock, re-armed by each line of pull progress. */
export const PULL_STALL_MS = 60_000;
/** The pull's overall cap. */
export const PULL_CAP_MS = 1_800_000;
/** The least time each stage needs to be worth starting. */
export const STAGE_MINIMUM_MS: Readonly<Record<"runtime" | "pull" | "start", number>> = { runtime: 10_000, pull: 30_000, start: 30_000 };
/** How long after a killed child the parent sweeps again. */
export const SWEEP_GRACE_MS = 3_000;

export type PreflightStage = "runtime" | "pull" | "start";

export type InfrastructureKind = "credential-helper" | "no-runtime" | "socket" | "reaper" | "pull" | "timeout" | "other";

export interface InfrastructureCause {
  readonly kind: InfrastructureKind;
  /** The underlying error, cleaned of secrets and machine paths. */
  readonly cause: string;
  /** What the user can do about it, in product terms. */
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
/** One segment of a name that says it holds a secret. Compound words end in
 *  the secret word (`PGPASSWORD`, `identitytoken`); the short words count only
 *  as a whole segment, so `unauthorized`, `bypass` and `monkey` are ordinary. */
const SECRET_SEGMENT = String.raw`(?:[A-Za-z0-9]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization)|pwd|pass|key|auth)(?![A-Za-z0-9])`;
/** A whole name token holding a secret segment: `password`, `db_pass`,
 *  `PG_PWD`, `x-api-key`, `AWS_SECRET_ACCESS_KEY`. */
const SECRET_NAME = String.raw`(?<![A-Za-z0-9_.])(?:[A-Za-z0-9]+[_.-])*?${SECRET_SEGMENT}(?:[_.-][A-Za-z0-9]+)*(?![A-Za-z0-9_.-])`;
/** `name="a quoted value"`, spaces and all. */
const SECRET_QUOTED = new RegExp(String.raw`(${SECRET_NAME}["']?\s*[:=]\s*)(["'])(?!\[redacted\])(?:\\.|(?!\2)[^\\])*\2`, "gi");
/** `name=value` and `name: value` where the name says it holds a secret. */
const SECRET_FIELD = new RegExp(String.raw`(${SECRET_NAME}["']?\s*[:=]\s*["']?)(?!\[redacted\])[^\s"',;}]+`, "gi");
/** `Authorization: <scheme> <credential>`: the scheme and the credential both go. */
const AUTH_HEADER = /(\b(?:proxy-)?authorization["']?\s*[:=]\s*["']?)(?!\[redacted\])(?:[A-Za-z][\w-]*\s+(?=[^\s"',;}]))?[^\s"',;}]+/gi;
/** Words of ordinary prose or an error's own wording, in any case, that can
 *  follow a secret's NAME ("POSTGRES_PASSWORD to a non-empty value", "TOKEN
 *  EXPIRED", "token: invalid"): never taken for its value. */
const ORDINARY = /^(?:is|are|was|were|be|been|has|have|had|must|should|may|can|cannot|not|no|to|and|or|of|for|in|on|the|a|an|missing|required|unset|empty|set|given|provided|specified|value|variable|environment|flag|option|header|failed|failure|authentication|expired|invalid|unauthorized|denied|incorrect|forbidden|rejected|wrong|unknown|malformed|mismatch|error|none|null|undefined)[.!:]*$/i;
/** A secret value: quoted (spaces and all), or one bare word. */
const VALUE = String.raw`(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"',;}]+)`;
/** `--password x`, `--db-token x`: a long flag whose name says secret, then
 *  its value. `--password-stdin` and `--password-file` carry no secret. */
const SECRET_FLAG = new RegExp(
  String.raw`((?:^|\s)--?[A-Za-z0-9-]*(?:password|passwd|pwd|pass|secret|token|api-?key|access-?key|private-?key)(?![A-Za-z0-9-]*-(?:stdin|file)\b)[A-Za-z0-9-]*\s+)(?!\[redacted\]|-)${VALUE}`,
  "gi",
);
/** `PGPASSWORD x`, `POSTGRES_PASSWORD x`, `DB_PASS x`: an environment-style
 *  upper-case name that says secret, then its value. */
const SECRET_ENV = new RegExp(
  String.raw`(\b[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY)[A-Z0-9_]*\s+|\b[A-Z0-9_]+_(?:PASS|PWD)\s+)(?!\[redacted\]|-)${VALUE}`,
  "g",
);
/** `-p x` where `-p` is a registry login's password flag (`docker login -u
 *  bob -p x`); elsewhere `-p` is a port and stays. */
const LOGIN_P = new RegExp(String.raw`(\blogin\b[^;|&]{0,200}?\s-p\s+)(?!\[redacted\])${VALUE}`, "g");
/** URL credentials, up to the last `@` before the host. A password (after
 *  `user:`) may hold unencoded spaces while an `@` still lies ahead. */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)(?:[^\s/?#@:]*:(?:[^\s/?#]|\s(?=[^/?#]*@))*|[^\s/?#]*)@/gi;
/** An absolute path of two or more segments, not part of a URL or a word. */
const ABSOLUTE_PATH = /(?<![\w.~/-])\/(?!\/)[^\s"'`(),;/]+(?:\/[^\s"'`(),;]*)+/g;
/** Paths that name no machine or user: container-runtime sockets at their
 *  standard places, Docker Engine and registry API routes, and the system's
 *  own directories (where a remedy says a helper or the runtime lives). */
const WELL_KNOWN_PATH = new RegExp(
  "^(?:(?:/private)?(?:/var)?/run/(?:[\\w.-]+/)*[\\w.-]+\\.sock" +
    "|/(?:v\\d+(?:\\.\\d+)?|containers|images|networks|volumes|exec|services|tasks|plugins|distribution|\\.well-known)/\\S*" +
    "|/(?:usr/(?:local/)?(?:bin|sbin|lib|lib64|libexec|share|include|etc)|bin|sbin|lib|lib64|etc|var/lib/(?:docker|containerd|containers)|var/log" +
    "|opt/homebrew/(?:bin|sbin|lib|etc|opt|Cellar)|proc|sys|dev)(?:/\\S*)?)$",
);

/** Keep a secret-looking match when its "value" is an ordinary word. */
function redactUnlessOrdinary(onlyAfterColon: boolean, replacement: (prefix: string) => string) {
  return (match: string, prefix: string): string => {
    const value = match.slice(prefix.length);
    const colon = /:\s*["']?$/.test(prefix);
    return (!onlyAfterColon || colon) && ORDINARY.test(value) ? match : replacement(prefix);
  };
}

/** `Authorization:` keeps an ordinary word ("Authorization: required"),
 *  otherwise loses its scheme and credential together. */
function redactAuthHeader(match: string, prefix: string): string {
  const first = match.slice(prefix.length).split(/\s+/)[0] ?? "";
  return ORDINARY.test(first) ? match : `${prefix}[redacted]`;
}

/**
 * The cause as the user may see it: no ANSI, no stack or code frames, no
 * secrets (URL credentials up to the last `@` before the host, secret-named
 * fields in any case and quoted or not, an Authorization header's scheme and
 * credential, secret-named flags and environment names followed by a value,
 * a login's `-p` value, bearer and basic credentials, prefixed tokens), no
 * absolute machine paths (home, the temp directory, and any absolute path of
 * two or more segments except a runtime socket, an API route or a system
 * directory), one line, bounded. Pure.
 */
export function cleanCause(text: string, home = homedir(), temp = tmpdir()): string {
  const lines = text.replace(ANSI, "").split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !/^at\s/.test(line) && !/^\d+\s*\|/.test(line) && !/^\^+$/.test(line));
  let out = [...new Set(lines)].join(" ");
  out = out
    .replace(URL_CREDENTIALS, "$1[redacted]@")
    .replace(TOKEN, "[redacted]")
    .replace(AUTH_HEADER, redactAuthHeader)
    .replace(/\b(Bearer|Basic)\s+(?!\[redacted\])[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
    .replace(SECRET_QUOTED, "$1$2[redacted]$2")
    .replace(SECRET_FIELD, redactUnlessOrdinary(true, (prefix) => `${prefix}[redacted]`))
    .replace(SECRET_FLAG, redactUnlessOrdinary(false, (prefix) => `${prefix}[redacted]`))
    .replace(SECRET_ENV, redactUnlessOrdinary(false, (prefix) => `${prefix}[redacted]`))
    .replace(LOGIN_P, "$1[redacted]");
  const roots = [temp, home].filter((root) => root !== "" && root !== "/").map(escapeRegExp);
  const paths = new RegExp(
    `(?<![\\w.-])(?:${[...roots, "(?:/private)?/var/folders", "(?:/private)?/tmp", "/Users", "/home", "/root"].join("|")})(?=/|$|[\\s"'\`(),;:])[^\\s"'\`(),;]*`,
    "g",
  );
  out = out.replace(paths, (path) => `[path]${trailing(path)}`)
    .replace(ABSOLUTE_PATH, keepWellKnown)
    .replace(/\s+/g, " ").trim();
  return out.length > MAX_CAUSE ? `${out.slice(0, MAX_CAUSE - 1)}…` : out;
}

/** Sentence punctuation after a path ("no such file /x/y: ..."), kept. */
const trailing = (path: string): string => /[.:]+$/.exec(path)?.[0] ?? "";

/** A path kept when it names no machine, else `[path]`. A trailing
 *  `:line:col` or sentence punctuation is not part of what is judged. */
function keepWellKnown(path: string): string {
  const bare = path.replace(/(?::\d+)+$|[.:]+$/, "");
  return WELL_KNOWN_PATH.test(bare) ? path : `[path]${trailing(path)}`;
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
      remedy: `${REMEDY["credential-helper"]} (${context.dockerConfig.shownAs} names ${helperKey(name, context.dockerConfig)}, ` +
        `and docker-credential-${name} is not installed)`,
    };
  }
  const probed = context.endpoint !== undefined ? ` (the harness found it answering at ${shown(context.endpoint, home)})` : "";
  if (TC_NO_RUNTIME.test(text)) return { kind: "no-runtime", cause, remedy: `${REMEDY["no-runtime"]}${probed}` };
  if (options.narrow === true) return undefined;
  if (TC_REAPER.test(text)) return { kind: "reaper", cause, remedy: REMEDY.reaper };
  if (DOCKER_SOCKET.test(text)) return { kind: "socket", cause, remedy: `${REMEDY.socket}${probed}` };
  if (REGISTRY.test(text)) return { kind: "pull", cause, remedy: REMEDY.pull };
  return undefined;
}

/** What the user does about each cause, in product terms: never a command
 *  to type (ADR LEG-2026-072). The engine is the user's machine. */
const REMEDY: Readonly<Record<InfrastructureKind, string>> = {
  "credential-helper": "the container engine's settings name a registry login helper that isn't installed: install it, or remove it from the engine's settings",
  "no-runtime": "the container engine isn't running: start it",
  socket: "the tests can't reach the container engine: restart it",
  reaper: "the container engine doesn't let the tests' cleanup helper run: allow it in the engine's settings",
  pull: "the container engine can't fetch images: check your network and registry login",
  timeout: "the container engine couldn't start the test database: restart it",
  other: "the container engine couldn't start the test database: restart it",
};

/** Every failure the preflight can report: a recognised cause, a stage that
 *  ran out of time, or the raw cause with a generic remedy. Pure. In the
 *  preflight the text is the container start's own error, never a test's. */
export function classifyPreflightFailure(text: string, stage: PreflightStage, timedOut: boolean, context: ClassifyContext): InfrastructureCause {
  const known = recogniseInfrastructure(text, context);
  if (known !== undefined) return known;
  const clean = (): string => cleanCause(text, context.home ?? homedir(), context.temp ?? tmpdir());
  if (stage === "pull" && !timedOut && text !== "") return { kind: "pull", cause: clean(), remedy: REMEDY.pull };
  if (timedOut) {
    const what = stage === "pull" ? `pulling ${context.image}` : stage === "runtime" ? "reaching the container runtime" : "starting and stopping the container";
    return { kind: stage === "pull" ? "pull" : "timeout", cause: clean() || `${what} did not finish in time`, remedy: stage === "pull" ? REMEDY.pull : REMEDY.timeout };
  }
  return { kind: "other", cause: clean() || "the preflight exited without saying why", remedy: REMEDY.other };
}

/** The refusal text for a failed preflight. */
export function preflightRefusal(found: InfrastructureCause, image: string): string {
  return `Testcontainers, which the tests that need Postgres start it through, could not start a ${image} container on this ` +
    `machine (green's preflight, before any test ran): ${found.cause}. Remedy: ${found.remedy}. This is the machine, ` +
    "not the code: no role can fix it (ADR LEG-2026-064, ADR LEG-2026-072).";
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
// Testcontainers logs each line of its own pull's progress under this
// namespace: forwarded as progress, it re-arms the parent's stall clock.
const PULL_LOG = "testcontainers:pull";
process.env.DEBUG = [process.env.DEBUG, PULL_LOG].filter((x) => x).join(",");
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
  const testcontainers = createRequire(postgresql).resolve("testcontainers");
  try {
    const debug = createRequire(testcontainers)("debug");
    const { format } = await import("node:util");
    const write = debug.log;
    debug.log = function (...args) {
      if (this && this.namespace === PULL_LOG) say({ progress: "pull" });
      else if (typeof write === "function") write.apply(this, args);
      else process.stderr.write(format(...args) + "\\n");
    };
  } catch {}
  // Under NODE_ENV=test Testcontainers gives each logger its own console.log,
  // which wins over the shared one above: point the pull logger's at ours too.
  try {
    const { pullLog } = createRequire(testcontainers)("./common");
    if (pullLog && pullLog.logger) pullLog.logger.log = () => say({ progress: "pull" });
  } catch {}
  const { getContainerRuntimeClient, ImageName } = await import(testcontainers);
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

/** runChild's shape: the preflight's one way to spawn its child. */
export type SpawnChild = typeof runChild;

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
  /** Milliseconds on the clock the call's budget is measured on: since this
   *  process started, by default (performance.now()). */
  readonly now?: () => number;
  /** The host's command deadline; by default read from `env`
   *  (BOUNDED_COMMAND_TIMEOUT_MS). Undefined there means none. */
  readonly deadlineMs?: number;
}

/** Each stage's own clock (the pull's is a stall clock). */
const STAGE_TIMEOUT: Readonly<Record<PreflightStage, number>> = { runtime: COMMAND_TIMEOUT_MS, pull: PULL_STALL_MS, start: START_TIMEOUT_MS };
const NEXT: Readonly<Record<PreflightStage, PreflightStage | undefined>> = { runtime: "pull", pull: "start", start: undefined };

/** The child under `bun -e`; `timeoutFor()` is re-read after every line it
 *  prints, so a progress line re-arms the current stage's clock. */
export function preflightChild(
  env: NodeJS.ProcessEnv, cwd: string, onLine: (line: string) => void, timeoutFor: () => number, spawnChild: SpawnChild = runChild,
): Promise<ChildResult> {
  return new Promise((resolve) => {
    // runChild gives the overall bound; the per-stage clock is ours.
    const total = STAGE_TIMEOUT.runtime + PULL_CAP_MS + STAGE_TIMEOUT.start;
    let timedOut = false;
    let buffered = "";
    let timer: NodeJS.Timeout | undefined;
    let kill: (() => void) | undefined;
    const arm = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => { timedOut = true; kill?.(); }, timeoutFor());
    };
    arm();
    void spawnChild("bun", ["-e", CHILD], {
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
  // The call's budget (issue #52): each stage's clock fits what is left of
  // it, and a stage whose minimum no longer fits is refused before it starts.
  const now = deps.now ?? (() => performance.now());
  const budget = callBudgetMs(deps.deadlineMs ?? commandTimeoutMs(deps.env));
  const left = (): number => (budget === undefined ? Number.POSITIVE_INFINITY : budget - now());
  const tooLate = (at: PreflightStage): boolean => left() < STAGE_MINIMUM_MS[at];
  // Inside a background job (ADR LEG-2026-073) the deadline is the job's own
  // limit, which no role can raise: running out of it is the harness's bug.
  const inJob = deps.env["BOUNDED_JOB_DIR"] !== undefined;
  const budgetRefusal = (at: PreflightStage): Error => new Error(inJob
    ? `this run's time limit cannot fit starting the test containers (needs at least ${STAGE_MINIMUM_MS[at] / 1000} s for the ${at} stage, ` +
      `${Math.max(0, Math.floor(left() / 1000))} s left); this is a harness bug`
    : `this call's time cannot fit starting the test containers (needs at least ${STAGE_MINIMUM_MS[at] / 1000} s for the ${at} stage, ` +
      `${Math.max(0, Math.floor(left() / 1000))} s left); call the gate again with a longer command timeout`,
  );
  if (tooLate("runtime")) throw budgetRefusal("runtime");
  let stageStarted = now();
  let overBudget: PreflightStage | undefined;
  // Whether the timer last armed was the call's budget rather than the
  // stage's own clock: a kill then means the call ran out of time, which the
  // calling role fixes with a longer timeout, not the engine failing.
  let budgetBound = false;
  const timeoutFor = (): number => {
    if (overBudget !== undefined) return 0;
    let clock = STAGE_TIMEOUT[stage];
    if (stage === "pull") clock = Math.min(clock, PULL_CAP_MS - (now() - stageStarted));
    const remaining = left();
    budgetBound = remaining < clock;
    return Math.max(0, Math.min(clock, remaining));
  };
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
      else if (typeof parsed.done === "string" && parsed.done in NEXT) {
        stage = NEXT[parsed.done as PreflightStage] ?? stage;
        stageStarted = now();
        if (tooLate(stage)) overBudget = stage;
      }
      if (typeof parsed.failed === "string") failure = typeof parsed.error === "string" ? parsed.error : "";
    }, timeoutFor);
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
  if (overBudget !== undefined) throw budgetRefusal(overBudget);
  if (result.timedOut && budgetBound) {
    throw new Error(inJob
      ? `this run's time limit ran out during the ${stage} stage of starting the test containers; this is a harness bug`
      : `this call's time ran out during the ${stage} stage of starting the test containers; ` +
        "call the gate again with a longer command timeout");
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
  throw userRoutedError(preflightRefusal(found, image));
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

/** The preflight for every distinct Testcontainers the given tests use. */
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
