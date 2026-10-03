// A lock file owned by one live process (ADR 2026-066). The owner is recorded
// by pid AND that process's start time, so a lock whose owner has died — or
// whose pid the system has since given to another process — is stale by
// evidence, never by a timeout, and the next taker clears it.
//
// Every step is atomic on the filesystem, so two takers can never both hold
// the lock:
//   · the lock is created complete, by hard-linking a fully written file into
//     place (a link never replaces an existing file), so it is never seen
//     half-written;
//   · a stale lock is claimed by renaming it away, which only one taker can do,
//     and the claimer then checks it moved the very lock it judged stale; if
//     it moved a fresh one instead, it puts it back.
// When the system cannot say whether the owner still runs (`ps` failed), the
// lock is NOT stale: the taker refuses and says how to clear it by hand.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** How a lock judges whether its owner still runs. Tests replace it. */
export interface ProcessProbe {
  /** The running process's start time; undefined when no such process runs;
   *  null when the system could not say. */
  startTime(pid: number): string | null | undefined;
}

export const systemProcesses: ProcessProbe = {
  startTime(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
    const run = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
    if (run.error !== undefined) return null;
    const out = (run.stdout ?? "").trim();
    if (run.status === 0 && out !== "") return out;
    // ps exits 1 with no output for a pid that does not exist.
    return run.status === 1 && out === "" ? undefined : null;
  },
};

export interface LockOwner {
  readonly pid: number;
  readonly started: string;
}

export type OwnerState = "alive" | "stale" | "unknown";

/** Whether the recorded owner still runs: the same pid, started at the same time. */
export function ownerState(owner: LockOwner, probe: ProcessProbe = systemProcesses): OwnerState {
  // An owner recorded without its start time can never be told apart.
  if (owner.started === "unknown") return "unknown";
  const now = probe.startTime(owner.pid);
  if (now === null) return "unknown";
  if (now === undefined) return "stale";
  return now === owner.started ? "alive" : "stale";
}

export function ownerAlive(owner: LockOwner, probe: ProcessProbe = systemProcesses): boolean {
  return ownerState(owner, probe) !== "stale";
}

function readOwner(path: string): LockOwner | undefined {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as LockOwner;
    return typeof raw.pid === "number" && typeof raw.started === "string" ? raw : undefined;
  } catch {
    return undefined;
  }
}

const sameOwner = (a: LockOwner | undefined, b: LockOwner | undefined): boolean =>
  a !== undefined && b !== undefined && a.pid === b.pid && a.started === b.started;

const unique = (path: string, what: string): string => `${path}.${what}-${process.pid}-${randomBytes(6).toString("hex")}`;

/** Put `content` at `path` only if nothing is there, all at once. */
function createExclusive(path: string, content: string): boolean {
  const tmp = unique(path, "new");
  writeFileSync(tmp, content);
  try {
    linkSync(tmp, path);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(tmp, { force: true });
  }
}

export type Acquired =
  | { readonly ok: true; release(): void }
  | { readonly ok: false; readonly owner: LockOwner; readonly reason: string };

/** Take the lock at `path` for this process, clearing a stale one. */
export function acquireLock(path: string, probe: ProcessProbe = systemProcesses, pid: number = process.pid): Acquired {
  mkdirSync(dirname(path), { recursive: true });
  const mine: LockOwner = { pid, started: probe.startTime(pid) ?? "unknown" };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (createExclusive(path, JSON.stringify(mine))) {
      // Re-verify: what is at the path now is this lock.
      if (!sameOwner(readOwner(path), mine)) continue;
      return {
        ok: true,
        release() {
          if (sameOwner(readOwner(path), mine)) rmSync(path, { force: true });
        },
      };
    }
    const owner = readOwner(path);
    if (owner === undefined) continue; // gone, or claimed by another taker: try again
    const state = ownerState(owner, probe);
    if (state === "alive") return { ok: false, owner, reason: `held by pid ${owner.pid}` };
    if (state === "unknown") {
      return { ok: false, owner, reason: `held by pid ${owner.pid}, and the system cannot say whether it still runs; if it does not, remove ${path}` };
    }
    // Stale: claim it by renaming it away, which only one taker can do.
    const claimed = unique(path, "stale");
    try {
      renameSync(path, claimed);
    } catch {
      continue; // another taker claimed it first
    }
    if (sameOwner(readOwner(claimed), owner)) {
      rmSync(claimed, { force: true });
    } else {
      // A fresh lock replaced the stale one before the rename: put it back.
      try { linkSync(claimed, path); } catch { /* a newer lock is in place */ }
      rmSync(claimed, { force: true });
      const now = readOwner(path);
      return { ok: false, owner: now ?? owner, reason: `held by pid ${(now ?? owner).pid}` };
    }
  }
  const owner = readOwner(path) ?? { pid: 0, started: "unknown" };
  return { ok: false, owner, reason: `held by pid ${owner.pid}` };
}
