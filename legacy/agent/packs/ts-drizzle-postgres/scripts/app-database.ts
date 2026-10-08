// Child processes for the pack's machine checks (ADR 2026-064, amended by
// ADR 2026-072): one awaited child with its own timeout, and the docker CLI
// pointed at one endpoint. Nothing here blocks the event loop while it waits.
//
// The gates no longer start an application database of their own (issue
// #52): each persisting app's smoke tests start their own migrated Postgres
// through the generated app-test-database support, so the project's own check
// needs nothing but a container engine.
import { type ChildProcess, type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";

/** The variable each app's composition root reads its database from. */
export const APP_DATABASE_ENV = "DATABASE_URL";
/** A docker CLI call or the preflight's runtime stage. */
export const COMMAND_TIMEOUT_MS = 60_000;

export interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

const dockerEnv = (endpoint: string): NodeJS.ProcessEnv => ({ ...process.env, DOCKER_HOST: endpoint, DOCKER_CONTEXT: "" });

/** One child process, awaited; killed and reported at `timeoutMs`. */
export function runChild(
  command: string, args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs: number; onSpawn?: (child: ChildProcess) => void },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
      options.onSpawn?.(child);
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

