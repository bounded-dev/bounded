// The background job's runner (ADR 2026-073): one process per run, started by
// src/detached-job.ts in a session of its own, so the call that started it can
// return and nothing that ends that call reaches it.
//
//   node job-runner.ts <job-dir> <run-id> <commands-json> <output-dir>
//
// It runs each command (an argv list) in turn, in its own working directory,
// with their output in the `stdout` and `stderr` files of its output
// directory (outside the project, so no role's search reaches it), and
// stops at the first that fails. At the job's time limit (the
// BOUNDED_COMMAND_TIMEOUT_MS it was started with) it records the run as timed
// out and stops everything it started. Its one product is
// `result-<run-id>.json`, written all at once: the caller reads only the
// current run's result, so a run abandoned earlier can never be collected.
// The commands come on its own argv from the process that started it, never
// from a file in the job directory.

import { spawn } from "node:child_process";
import { closeSync, openSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMainModule } from "./is-main-module.ts";

export interface RunnerResult {
  readonly runId: string;
  /** The failing (or last) command's exit code; null when it never ran to an
   *  exit (could not start, killed, timed out). */
  readonly code: number | null;
  readonly signal?: string;
  readonly timedOut?: true;
  /** Why a command could not start. */
  readonly error?: string;
  /** Which command (0-based) the code belongs to. */
  readonly step: number;
  readonly finishedAt: string;
}

export const resultFile = (runId: string): string => `result-${runId}.json`;
export const payloadFile = (runId: string): string => `payload-${runId}.json`;

/** Write a whole file at once: a reader sees nothing or all of it. */
export function writeWhole(path: string, text: string): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, path);
}

async function runAll(jobDir: string, runId: string, commands: readonly (readonly string[])[], timeoutMs: number, outputDir: string): Promise<never> {
  const out = openSync(join(outputDir, "stdout"), "w");
  const err = openSync(join(outputDir, "stderr"), "w");
  let finished = false;
  const finish = (result: Omit<RunnerResult, "runId" | "finishedAt">): void => {
    if (finished) return;
    finished = true;
    writeWhole(join(jobDir, resultFile(runId)), `${JSON.stringify({ runId, ...result, finishedAt: new Date().toISOString() })}\n`);
  };
  let step = 0;
  setTimeout(() => {
    finish({ code: null, timedOut: true, step });
    // Everything this run started is in its process group, this runner included.
    try { process.kill(-process.pid, "SIGKILL"); } catch { /* not a group leader */ }
    process.exit(124);
  }, timeoutMs).unref();
  for (; step < commands.length; step++) {
    const [command, ...args] = commands[step]!;
    const ended = await new Promise<{ code: number | null; signal?: string; error?: string }>((resolve) => {
      let settled = false;
      const settle = (value: { code: number | null; signal?: string; error?: string }): void => {
        if (!settled) { settled = true; resolve(value); }
      };
      try {
        const child = spawn(command!, args, { stdio: ["ignore", out, err], env: process.env });
        child.on("error", (e) => settle({ code: null, error: e.message }));
        child.on("exit", (code, signal) => settle({ code, ...(signal !== null ? { signal } : {}) }));
      } catch (e) {
        settle({ code: null, error: e instanceof Error ? e.message : String(e) });
      }
    });
    if (ended.code !== 0 || step === commands.length - 1) {
      finish({ ...ended, step });
      closeSync(out);
      closeSync(err);
      process.exit(0);
    }
  }
  finish({ code: 0, step: Math.max(0, commands.length - 1) });
  process.exit(0);
}

const [jobDir, runId, raw, outputDir] = process.argv.slice(2);
if (isMainModule(import.meta.url) && jobDir !== undefined && runId !== undefined && raw !== undefined && outputDir !== undefined) {
  const commands = JSON.parse(raw) as string[][];
  const timeoutMs = Number(process.env["BOUNDED_COMMAND_TIMEOUT_MS"]);
  await runAll(jobDir, runId, commands, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60 * 60_000, outputDir);
}
