// One architect per ticket worktree, as its own host session (ADR 2026-066).
//
// The lead never runs an architect inside its own session. `bounded lead
// start` launches the host's own command line in the ticket worktree, so the
// architect's working directory, hooks, path gate and `.bounded/` state are
// all that worktree's. Each turn is one run of that command: the first opens
// the session, `bounded lead reply` continues it with the lead's answer.
//
// The launch goes through a small detached wrapper (this module, run as a
// program) that waits for the host command, keeps its output, and records the
// turn's end — in the state file the lead reads and in the worktree's guard
// log, where the commission rules look for an architect's end
// (src/lead-state.ts). The state file is also the per-worktree lock: a turn is
// running while its wrapper process lives, and no second turn starts then.
//
// The host adapter only says which command runs a turn (hosts/<host>/
// architect-launch.ts); everything else here is host-neutral.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { logGuardEvent } from "./guard-log.ts";
import { isMainModule } from "./is-main-module.ts";
import { ARCHITECT_ENDED, LEAD_GUARD } from "./lead-state.ts";

export const ARCHITECT_DIR_RELATIVE = ".bounded/architect";
const STATE = "state.json";
const LOCK = "launch.lock";

/** What a host needs to run one architect turn. */
export interface ArchitectTurnSpec {
  readonly worktree: string;
  readonly sessionId: string;
  /** The opening brief on the first turn, the lead's reply afterwards. */
  readonly message: string;
  /** False on the first turn, which opens the session. */
  readonly resume: boolean;
  /** The architect's configured model, as the host names it, when one is configured. */
  readonly model?: string;
}

export interface HostCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** Variables of the launching session that must not reach the architect's. */
  readonly unset?: readonly string[];
}

/** A host adapter's half: the command line for one turn, and the host's name
 *  for a configured model pattern (undefined when it cannot run that model). */
export interface ArchitectHost {
  readonly name: string;
  command(spec: ArchitectTurnSpec): HostCommand;
  model(pattern: string): string | undefined;
}

export interface ArchitectState {
  readonly sessionId: string;
  readonly turn: number;
  readonly state: "running" | "ended";
  readonly pid: number;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly exitCode?: number;
}

export type ArchitectStatus =
  | { readonly kind: "none" }
  | { readonly kind: "running"; readonly turn: number; readonly since: string }
  | { readonly kind: "ended"; readonly turn: number; readonly exitCode: number }
  /** Recorded as running, but its wrapper is gone: the turn ended without a record. */
  | { readonly kind: "lost"; readonly turn: number };

const dirOf = (worktree: string): string => join(worktree, ARCHITECT_DIR_RELATIVE);

export function readArchitectState(worktree: string): ArchitectState | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(dirOf(worktree), STATE), "utf8")) as ArchitectState;
    return typeof raw.sessionId === "string" && typeof raw.turn === "number" && typeof raw.pid === "number" ? raw : undefined;
  } catch {
    return undefined;
  }
}

function writeState(worktree: string, state: ArchitectState): void {
  mkdirSync(dirOf(worktree), { recursive: true });
  writeFileSync(join(dirOf(worktree), STATE), JSON.stringify(state, null, 2) + "\n");
}

/** Whether a process is alive. A process we may not signal still exists. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === "EPERM";
  }
}

export function architectStatus(worktree: string, alive: (pid: number) => boolean = processAlive): ArchitectStatus {
  const state = readArchitectState(worktree);
  if (state === undefined) return { kind: "none" };
  if (state.state === "ended") return { kind: "ended", turn: state.turn, exitCode: state.exitCode ?? 1 };
  return alive(state.pid) ? { kind: "running", turn: state.turn, since: state.startedAt } : { kind: "lost", turn: state.turn };
}

/** Start a detached program and return its pid. Tests replace it. */
export type SpawnDetached = (command: string, args: readonly string[], cwd: string) => number;

export const spawnDetached: SpawnDetached = (command, args, cwd) => {
  const child = spawn(command, [...args], { cwd, detached: true, stdio: "ignore" });
  child.unref();
  if (child.pid === undefined) throw new Error(`could not start ${command}`);
  return child.pid;
};

export type LaunchResult =
  | { readonly ok: true; readonly turn: number; readonly sessionId: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Start the next architect turn in `worktree`, unless one is running. The
 * first turn opens a new session; later turns continue it.
 */
export function launchArchitectTurn(
  worktree: string,
  message: string,
  host: ArchitectHost,
  options: { readonly model?: string; readonly spawn?: SpawnDetached; readonly alive?: (pid: number) => boolean } = {},
): LaunchResult {
  mkdirSync(dirOf(worktree), { recursive: true });
  const lockPath = join(dirOf(worktree), LOCK);
  let lock: number;
  try {
    lock = openSync(lockPath, "wx");
  } catch {
    return { ok: false, reason: "another architect launch in this worktree is in progress" };
  }
  try {
    const status = architectStatus(worktree, options.alive);
    if (status.kind === "running") {
      return { ok: false, reason: `this ticket's architect is still running (turn ${status.turn}); one architect runs per worktree` };
    }
    const previous = readArchitectState(worktree);
    const turn = (previous?.turn ?? 0) + 1;
    const sessionId = previous?.sessionId ?? randomUUID();
    const command = host.command({
      worktree, sessionId, message, resume: previous !== undefined,
      ...(options.model !== undefined ? { model: options.model } : {}),
    });
    writeFileSync(join(dirOf(worktree), `turn-${turn}.json`), JSON.stringify(command, null, 2) + "\n");
    const wrapper = fileURLToPath(import.meta.url);
    // Recorded as running before the wrapper starts, so a turn that ends at
    // once still finds its state to close; the wrapper's pid replaces this
    // process's only while the turn is still recorded as running.
    const startedAt = new Date().toISOString();
    writeState(worktree, { sessionId, turn, state: "running", pid: process.pid, startedAt });
    const pid = (options.spawn ?? spawnDetached)(process.execPath, [wrapper, worktree, String(turn)], worktree);
    const now = readArchitectState(worktree);
    if (now?.turn === turn && now.state === "running") writeState(worktree, { ...now, pid });
    return { ok: true, turn, sessionId };
  } catch (error) {
    const stuck = readArchitectState(worktree);
    if (stuck?.state === "running" && stuck.pid === process.pid) {
      writeState(worktree, { ...stuck, state: "ended", endedAt: new Date().toISOString(), exitCode: 127 });
    }
    return { ok: false, reason: `the architect could not be launched: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    closeSync(lock);
    rmSync(lockPath, { force: true });
  }
}

/** The last `lines` lines a turn printed: the architect's report to the lead. */
export function turnOutput(worktree: string, turn: number, lines = 60): string {
  const path = join(dirOf(worktree), `turn-${turn}.out`);
  if (!existsSync(path)) return "";
  const all = readFileSync(path, "utf8").trimEnd().split("\n");
  return all.slice(-lines).join("\n");
}

/** The wrapper's job: run one recorded turn to its end and record that end. */
export async function runArchitectTurn(worktree: string, turn: number): Promise<number> {
  const spec = JSON.parse(readFileSync(join(dirOf(worktree), `turn-${turn}.json`), "utf8")) as HostCommand;
  const out = openSync(join(dirOf(worktree), `turn-${turn}.out`), "w");
  const err = openSync(join(dirOf(worktree), `turn-${turn}.err`), "w");
  const code = await new Promise<number>((done) => {
    const env: Record<string, string | undefined> = { ...process.env, ...spec.env };
    for (const name of spec.unset ?? []) delete env[name];
    const child = spawn(spec.command, [...spec.args], { cwd: worktree, env, stdio: ["ignore", out, err] });
    child.on("error", () => done(127));
    child.on("exit", (status) => done(status ?? 1));
  });
  closeSync(out);
  closeSync(err);
  const before = readArchitectState(worktree);
  if (before !== undefined) {
    writeState(worktree, { ...before, state: "ended", endedAt: new Date().toISOString(), exitCode: code });
  }
  logGuardEvent(worktree, {
    guard: LEAD_GUARD, verdict: "pass",
    summary: code === 0 ? `architect turn ${turn} finished` : `architect turn ${turn} ended with exit ${code}`,
    detail: { kind: ARCHITECT_ENDED, launch: `turn-${turn}`, exitCode: code },
  });
  return code;
}

if (isMainModule(import.meta.url)) {
  const [worktree, turn] = process.argv.slice(2);
  if (worktree === undefined || turn === undefined || !/^[1-9][0-9]*$/.test(turn)) {
    process.stderr.write("usage: architect-launch.ts <worktree> <turn>\n");
    process.exit(64);
  }
  runArchitectTurn(worktree, Number(turn)).then((code) => process.exit(code), () => process.exit(2));
}
