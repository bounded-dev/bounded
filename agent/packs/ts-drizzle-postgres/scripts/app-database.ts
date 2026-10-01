// The green run's throwaway application database (ADR 2026-064, extended).
//
// A delivered app keeps its data in Postgres: its composition root reads
// `process.env.DATABASE_URL` (the worked example's persistence.md). So the
// app smoke tests, which run at green only, need a running, migrated
// Postgres. The green gate gets one from here, through the phase test
// policy's `prepare`:
//
//   1. one container from the pinned image (POSTGRES_IMAGE, the same one the
//      store tests and docker-compose.yml use), on a free loopback port,
//      labelled so a leftover is recognisable;
//   2. every context's committed migrations applied, exactly as
//      `bun run db:migrate` applies them;
//   3. its URL set as DATABASE_URL in the test process, over any inherited
//      value, so a green run never touches a developer's database;
//   4. removed after the run (`docker rm -f`), on failure too.
//
// It talks to the runtime through the docker CLI pointed at the endpoint the
// probe found (DOCKER_HOST), so the database and the probe agree on which
// runtime they mean. Everything that touches the machine is injectable; the
// sequencing is unit-tested without Docker.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { PreparedTestService } from "../../ts/pack.ts";
import { POSTGRES_IMAGE } from "./emit.ts";
import { migrateAll } from "./db-migrate.ts";

export const APP_DATABASE_ENV = "DATABASE_URL";
export const APP_DATABASE_LABEL = "dev.bounded.role=green-app-database";
export const APP_DATABASE_NAME = "app";
const USER = "postgres";
const PASSWORD = "postgres";
export const READY_TIMEOUT_MS = 90_000;

export interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

export interface AppDatabaseDeps {
  /** Run the docker CLI with these arguments against `endpoint`. */
  readonly docker: (args: readonly string[], endpoint: string) => CommandResult;
  /** Apply every context's migrations to `url`; the exit code and its output. */
  readonly migrate: (project: string, url: string) => { readonly code: number; readonly output: string };
  /** Block for `ms` milliseconds. */
  readonly sleep: (ms: number) => void;
  readonly now: () => number;
  /** A short random suffix for the container name. */
  readonly suffix: () => string;
}

/** The docker CLI against one endpoint, never inheriting another DOCKER_HOST. */
export function dockerCli(args: readonly string[], endpoint: string): CommandResult {
  const run = spawnSync("docker", [...args], {
    encoding: "utf8",
    env: { ...process.env, DOCKER_HOST: endpoint, DOCKER_CONTEXT: "" },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "", ...(run.error !== undefined ? { error: run.error } : {}) };
}

/** `bun run db:migrate`'s own function, quiet, against `url` only. */
export function migrateQuietly(project: string, url: string): { code: number; output: string } {
  const lines: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  console.error = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    const code = migrateAll(project, appDatabaseEnv(process.env, url), "pipe");
    return { code, output: lines.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

export const DEFAULT_DEPS: AppDatabaseDeps = {
  docker: dockerCli,
  migrate: migrateQuietly,
  sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  now: () => Date.now(),
  suffix: () => randomBytes(4).toString("hex"),
};

/** The test process's environment variables for a database at `url`: the URL
 *  overrides whatever the gate inherited. */
export function appDatabaseEnv(base: NodeJS.ProcessEnv, url: string): NodeJS.ProcessEnv {
  return { ...base, [APP_DATABASE_ENV]: url };
}

/** The connection URL for the container's published loopback port. */
export function appDatabaseUrl(port: number): string {
  return `postgres://${USER}:${PASSWORD}@127.0.0.1:${port}/${APP_DATABASE_NAME}`;
}

/** The host port from `docker port <id> 5432/tcp` output (first IPv4 line). */
export function publishedPort(output: string): number | undefined {
  for (const line of output.split("\n")) {
    const match = /^(?:0\.0\.0\.0|127\.0\.0\.1):(\d+)\s*$/.exec(line.trim());
    if (match !== null) return Number(match[1]);
  }
  return undefined;
}

const why = (r: CommandResult): string =>
  r.error !== undefined
    ? (/ENOENT/.test(r.error.message) ? "the docker CLI is not on PATH" : r.error.message)
    : (r.stderr.trim() || r.stdout.trim() || `exit ${r.status}`).split("\n").slice(-3).join(" ");

/**
 * Start, wait for, and migrate one throwaway Postgres. Throws with the reason
 * when any step fails, having removed whatever it started.
 */
export function startAppDatabase(project: string, endpoint: string, deps: AppDatabaseDeps = DEFAULT_DEPS): PreparedTestService {
  const name = `bounded-green-db-${deps.suffix()}`;
  const run = deps.docker([
    "run", "--detach", "--rm", "--name", name, "--label", APP_DATABASE_LABEL,
    "--env", `POSTGRES_USER=${USER}`, "--env", `POSTGRES_PASSWORD=${PASSWORD}`, "--env", `POSTGRES_DB=${APP_DATABASE_NAME}`,
    "--publish", "127.0.0.1::5432", POSTGRES_IMAGE,
  ], endpoint);
  if (run.status !== 0) throw new Error(`could not start a ${POSTGRES_IMAGE} container: ${why(run)}`);
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try {
      deps.docker(["rm", "--force", "--volumes", name], endpoint);
    } catch {
      // best effort: the container also carries --rm and a label
    }
  };
  try {
    const portOut = deps.docker(["port", name, "5432/tcp"], endpoint);
    const port = portOut.status === 0 ? publishedPort(portOut.stdout) : undefined;
    if (port === undefined) throw new Error(`the database container published no port: ${why(portOut)}`);
    // Ready means the final server answers over TCP: during first-start
    // initialisation the image runs a temporary server on its socket only.
    const deadline = deps.now() + READY_TIMEOUT_MS;
    for (;;) {
      const ready = deps.docker(["exec", name, "pg_isready", "--host", "127.0.0.1", "--username", USER, "--dbname", APP_DATABASE_NAME], endpoint);
      if (ready.status === 0) break;
      if (deps.now() >= deadline) throw new Error(`the database container was not ready within ${READY_TIMEOUT_MS / 1000}s: ${why(ready)}`);
      deps.sleep(250);
    }
    const url = appDatabaseUrl(port);
    const migrated = deps.migrate(project, url);
    if (migrated.code !== 0) {
      throw new Error(`the migrations did not apply to the throwaway database: ${migrated.output.split("\n").slice(-4).join(" ")}`);
    }
    return {
      description: `started a throwaway ${POSTGRES_IMAGE} (${name}) on 127.0.0.1:${port}, migrated, as ${APP_DATABASE_ENV} for this run; removed after it`,
      env: { [APP_DATABASE_ENV]: url },
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}
