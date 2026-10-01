// The green run's throwaway application database (ADR 2026-064, amended).
//
// A delivered app keeps its data in Postgres: its composition root reads
// `process.env.DATABASE_URL` (the worked example's persistence.md). So the
// app smoke tests, which run at green only, need a running, migrated
// Postgres. The green gate gets one from here, through the phase test
// policy's `prepare`:
//
//   0. containers a previous run left behind (its process was killed before
//      it could release them) are removed: only containers carrying this
//      harness's label, started on this host by a process that is gone;
//   1. the pinned image (POSTGRES_IMAGE, tag and digest) is pulled, with its
//      own generous timeout, then one container is started on a free
//      loopback port, labelled with the owning process;
//   2. every context's committed migrations are applied, exactly as
//      `bun run db:migrate` applies them;
//   3. its URL is set as DATABASE_URL in the test process, over any inherited
//      value, so a green run never touches a developer's database;
//   4. it is removed after the run (`docker rm -f`), on failure and on
//      SIGINT/SIGTERM too (withPreparedServices).
//
// Nothing here blocks the event loop while it waits: every docker call and
// the migration are child processes awaited, and polling sleeps on a timer.
// It talks to the runtime through the docker CLI pointed at the endpoint the
// probe found (DOCKER_HOST), so the database and the probe agree on which
// runtime they mean. Everything that touches the machine is injectable; the
// sequencing is unit-tested without Docker.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import type { PreparedTestService } from "../../ts/pack.ts";
import { POSTGRES_IMAGE } from "./emit.ts";

export const APP_DATABASE_ENV = "DATABASE_URL";
/** Every throwaway database carries this label, and the owner labels below. */
export const APP_DATABASE_LABEL = "dev.bounded.role=green-app-database";
const ROLE_FILTER = `label=${APP_DATABASE_LABEL}`;
const PID_LABEL = "dev.bounded.pid";
const HOST_LABEL = "dev.bounded.host";
export const APP_DATABASE_NAME = "app";
const USER = "postgres";
const PASSWORD = "postgres";
export const PULL_TIMEOUT_MS = 600_000;
export const COMMAND_TIMEOUT_MS = 60_000;
export const READY_TIMEOUT_MS = 90_000;
export const MIGRATE_TIMEOUT_MS = 180_000;

export interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

export interface AppDatabaseDeps {
  /** Run the docker CLI with these arguments against `endpoint`. */
  readonly docker: (args: readonly string[], endpoint: string, timeoutMs: number) => Promise<CommandResult>;
  /** Remove a container now, synchronously: it must work from a signal handler. */
  readonly remove: (name: string, endpoint: string) => void;
  /** Apply every context's migrations to `url`. */
  readonly migrate: (project: string, url: string) => Promise<CommandResult>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  /** A short random suffix for the container name. */
  readonly suffix: () => string;
  /** Is a process with this id alive on this host? */
  readonly alive: (pid: number) => boolean;
  readonly pid: number;
  readonly host: string;
}

const dockerEnv = (endpoint: string): NodeJS.ProcessEnv => ({ ...process.env, DOCKER_HOST: endpoint, DOCKER_CONTEXT: "" });

/** One child process, awaited; killed and reported at `timeoutMs`. */
export function runChild(command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs: number }): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ status: null, stdout, stderr, error: error instanceof Error ? error : new Error(String(error)) });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ status: null, stdout, stderr, error: new Error(`timed out after ${options.timeoutMs / 1000}s`) });
    }, options.timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr, error });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

/** The docker CLI against one endpoint, never inheriting another DOCKER_HOST. */
export function dockerCli(args: readonly string[], endpoint: string, timeoutMs = COMMAND_TIMEOUT_MS): Promise<CommandResult> {
  return runChild("docker", args, { env: dockerEnv(endpoint), timeoutMs });
}

/** `bun run db:migrate`'s own script, in a child, against `url` only. */
export function migrateInChild(project: string, url: string): Promise<CommandResult> {
  const script = join(import.meta.dirname, "db-migrate.ts");
  return runChild(process.execPath, [script, project], {
    cwd: project, env: appDatabaseEnv(process.env, url), timeoutMs: MIGRATE_TIMEOUT_MS,
  });
}

export const DEFAULT_DEPS: AppDatabaseDeps = {
  docker: dockerCli,
  remove: (name, endpoint) => {
    spawnSync("docker", ["rm", "--force", "--volumes", name], { env: dockerEnv(endpoint), stdio: "ignore", timeout: COMMAND_TIMEOUT_MS });
  },
  migrate: migrateInChild,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  suffix: () => randomBytes(4).toString("hex"),
  alive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  pid: process.pid,
  host: hostname(),
};

/** The test process's environment for a database at `url`: the URL
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

/** Leftovers from `docker ps` lines of `<name>\t<pid label>\t<host label>`:
 *  ours (this host) and orphaned (that process is gone). Pure. */
export function orphanedContainers(listing: string, host: string, alive: (pid: number) => boolean): string[] {
  const out: string[] = [];
  for (const line of listing.split("\n")) {
    const [name, pid, owner] = line.trim().split("\t");
    if (name === undefined || name === "" || owner !== host || !/^\d+$/.test(pid ?? "")) continue;
    if (!alive(Number(pid))) out.push(name);
  }
  return out;
}

const why = (r: CommandResult): string =>
  r.error !== undefined
    ? (/ENOENT/.test(r.error.message) ? "the docker CLI is not on PATH" : r.error.message)
    : (r.stderr.trim() || r.stdout.trim() || `exit ${r.status}`).split("\n").slice(-3).join(" ");

/**
 * Clean up after killed runs, then start, wait for, and migrate one
 * throwaway Postgres. Rejects with the reason when any step fails, having
 * removed whatever it started.
 */
export async function startAppDatabase(project: string, endpoint: string, deps: AppDatabaseDeps = DEFAULT_DEPS): Promise<PreparedTestService> {
  const listed = await deps.docker(["ps", "--all", "--filter", ROLE_FILTER, "--format", `{{.Names}}\t{{.Label "${PID_LABEL}"}}\t{{.Label "${HOST_LABEL}"}}`], endpoint, COMMAND_TIMEOUT_MS);
  if (listed.status === 0) {
    for (const name of orphanedContainers(listed.stdout, deps.host, deps.alive)) deps.remove(name, endpoint);
  }

  const pull = await deps.docker(["pull", "--quiet", POSTGRES_IMAGE], endpoint, PULL_TIMEOUT_MS);
  if (pull.status !== 0) throw new Error(`could not pull ${POSTGRES_IMAGE}: ${why(pull)}`);

  const name = `bounded-green-db-${deps.suffix()}`;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try {
      deps.remove(name, endpoint);
    } catch {
      // best effort: the container also carries --rm and the owner labels
    }
  };
  try {
    const run = await deps.docker([
      "run", "--detach", "--rm", "--name", name,
      "--label", APP_DATABASE_LABEL, "--label", `${PID_LABEL}=${deps.pid}`, "--label", `${HOST_LABEL}=${deps.host}`,
      "--env", `POSTGRES_USER=${USER}`, "--env", `POSTGRES_PASSWORD=${PASSWORD}`, "--env", `POSTGRES_DB=${APP_DATABASE_NAME}`,
      "--publish", "127.0.0.1::5432", POSTGRES_IMAGE,
    ], endpoint, COMMAND_TIMEOUT_MS);
    // A run that fails or times out may still have created the container.
    if (run.status !== 0) throw new Error(`could not start a ${POSTGRES_IMAGE} container: ${why(run)}`);
    const portOut = await deps.docker(["port", name, "5432/tcp"], endpoint, COMMAND_TIMEOUT_MS);
    const port = portOut.status === 0 ? publishedPort(portOut.stdout) : undefined;
    if (port === undefined) throw new Error(`the database container published no port: ${why(portOut)}`);
    // Ready means the final server answers over TCP: during first-start
    // initialisation the image runs a temporary server on its socket only.
    const deadline = deps.now() + READY_TIMEOUT_MS;
    for (;;) {
      const ready = await deps.docker(["exec", name, "pg_isready", "--host", "127.0.0.1", "--username", USER, "--dbname", APP_DATABASE_NAME], endpoint, COMMAND_TIMEOUT_MS);
      if (ready.status === 0) break;
      if (deps.now() >= deadline) throw new Error(`the database container was not ready within ${READY_TIMEOUT_MS / 1000}s: ${why(ready)}`);
      await deps.sleep(250);
    }
    const url = appDatabaseUrl(port);
    const migrated = await deps.migrate(project, url);
    if (migrated.status !== 0) {
      throw new Error(`the migrations did not apply to the throwaway database: ${why(migrated)}`);
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
