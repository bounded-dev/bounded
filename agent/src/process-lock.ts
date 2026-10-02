// A lock file owned by one live process (ADR 2026-066). The owner is recorded
// by pid AND that process's start time, so a lock whose owner has died — or
// whose pid the system has since given to another process — is stale by
// evidence, never by a timeout, and is cleared by the next taker.

import { spawnSync } from "node:child_process";
import { mkdirSync, openSync, readFileSync, rmSync, writeSync, closeSync } from "node:fs";
import { dirname } from "node:path";

/** How a lock judges whether its owner still runs. Tests replace it. */
export interface ProcessProbe {
  /** The process's start time as the system reports it, or undefined when no such process runs. */
  startTime(pid: number): string | undefined;
}

export const systemProcesses: ProcessProbe = {
  startTime(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
    const run = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
    const out = (run.stdout ?? "").trim();
    return run.status === 0 && out !== "" ? out : undefined;
  },
};

export interface LockOwner {
  readonly pid: number;
  readonly started: string;
}

/** The recorded owner still runs: the same pid, started at the same time. */
export function ownerAlive(owner: LockOwner, probe: ProcessProbe = systemProcesses): boolean {
  return probe.startTime(owner.pid) === owner.started;
}

function readOwner(path: string): LockOwner | undefined {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as LockOwner;
    return typeof raw.pid === "number" && typeof raw.started === "string" ? raw : undefined;
  } catch {
    return undefined;
  }
}

export type Acquired =
  | { readonly ok: true; release(): void }
  | { readonly ok: false; readonly owner: LockOwner };

/**
 * Take the lock at `path` for this process. A lock whose recorded owner no
 * longer runs (or that records no owner at all, as a crash mid-write leaves
 * it) is stale and is taken over.
 */
export function acquireLock(path: string, probe: ProcessProbe = systemProcesses, pid: number = process.pid): Acquired {
  mkdirSync(dirname(path), { recursive: true });
  const started = probe.startTime(pid) ?? "unknown";
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try {
      fd = openSync(path, "wx");
    } catch {
      const owner = readOwner(path);
      if (owner !== undefined && ownerAlive(owner, probe)) return { ok: false, owner };
      rmSync(path, { force: true });
      continue;
    }
    writeSync(fd, JSON.stringify({ pid, started }));
    closeSync(fd);
    return {
      ok: true,
      release() {
        const owner = readOwner(path);
        if (owner?.pid === pid && owner.started === started) rmSync(path, { force: true });
      },
    };
  }
  const owner = readOwner(path);
  return { ok: false, owner: owner ?? { pid: 0, started: "unknown" } };
}
