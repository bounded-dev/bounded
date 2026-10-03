// The mutation measurement's restore journal (ADR 2026-070, issue #48).
//
// mutation-score edits the user's source one mutant at a time. Its restore
// cannot run when the process is killed outright: in a dogfood run a host's
// command limit did exactly that, the mutant stayed in the tree, and no guard
// event said so. So before each mutant is written, this journal is written
// OUTSIDE the source roots, under the harness state directory:
//
//   .bounded/mutation-score/original       the file's bytes before the edit
//   .bounded/mutation-score/journal.json   which file, which edit, both
//                                          versions' hashes, which process
//
// Both are written atomically (a temporary file renamed into place), the
// original first, so a journal never names a copy that is not complete. The
// journal is removed only once the restore has been verified.
//
// Every ts gate (the registry wraps each entry, gates.ts) and the next
// mutation-score run call `restoreLeftoverMutant` first. What it does depends
// only on what it finds:
//
//   no journal                  nothing
//   the owner is still running  refuse, touching nothing: the tree holds its
//                               mutant right now, and both restoring it and
//                               judging a tree with a mutant in it are wrong
//   the file is the original    the kill came before the edit or after the
//                               restore: the journal is removed
//   the file is the mutant      the original is written back, verified, the
//                               journal removed
//   anything else               refuse, touching nothing: the file was edited
//                               over the mutant, and only a person can merge
//
// A leftover journal means the run that wrote it never finished cleanly, so
// the verdicts it saved for a later call to continue from are dropped with
// it: the next measurement starts its sample over, baseline first.
//
// Every restore and refusal is a guard event under `mutation-score`, with
// `detail.kind` saying which. A SIGINT or SIGTERM is handled in place by
// mutation-score itself; the journal is for what no handler sees (SIGKILL,
// a power cut).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, join } from "node:path";
import { logGuardEvent } from "../../../src/guard-log.ts";

/** Where the measurement keeps its state, relative to the project. */
export const MUTATION_STATE_DIR = ".bounded/mutation-score";
export const JOURNAL_FILE = `${MUTATION_STATE_DIR}/journal.json`;
export const ORIGINAL_FILE = `${MUTATION_STATE_DIR}/original`;
/** The verdicts a measurement keeps between calls (mutation-score.ts). */
export const PROGRESS_FILE = `${MUTATION_STATE_DIR}/progress.json`;

/** The guard every restore, refusal and interruption is logged under. */
export const MUTATION_GUARD = "mutation-score";

export interface MutationJournal {
  readonly version: 1;
  /** Project-relative posix path of the mutated file. */
  readonly file: string;
  /** The edit, as the report names it (`=== → !==`). */
  readonly mutation: string;
  readonly originalSha256: string;
  readonly mutatedSha256: string;
  readonly pid: number;
  readonly host: string;
  readonly startedAt: string;
}

export const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** Write `bytes` to `path` so a reader sees the old file or the new one, never half. */
export function writeAtomically(path: string, bytes: Buffer | string): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, bytes);
  renameSync(temp, path);
}

/** Record, before the edit, how to undo it. */
export function writeJournal(
  cwd: string,
  entry: { readonly file: string; readonly mutation: string; readonly original: Buffer; readonly mutated: Buffer },
): void {
  mkdirSync(join(cwd, MUTATION_STATE_DIR), { recursive: true });
  writeAtomically(join(cwd, ORIGINAL_FILE), entry.original);
  const journal: MutationJournal = {
    version: 1,
    file: entry.file,
    mutation: entry.mutation,
    originalSha256: sha256(entry.original),
    mutatedSha256: sha256(entry.mutated),
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
  };
  writeAtomically(join(cwd, JOURNAL_FILE), `${JSON.stringify(journal, null, 2)}\n`);
}

/** The edit was undone and verified: forget it. The journal goes first, so a
 *  kill in between never leaves a journal pointing at a missing original. */
export function clearJournal(cwd: string): void {
  rmSync(join(cwd, JOURNAL_FILE), { force: true });
  rmSync(join(cwd, ORIGINAL_FILE), { force: true });
}

export type LeftoverRestore =
  | { readonly status: "none" }
  /** The file already held its original bytes; only the journal was left. */
  | { readonly status: "clean"; readonly file: string }
  | { readonly status: "restored"; readonly file: string; readonly mutation: string; readonly line: string }
  /** The tree may hold a mutant and was left alone: nothing may run over it. */
  | { readonly status: "refused"; readonly reason: string };

export interface RestoreDeps {
  /** Is a process with this id alive on this host? */
  readonly alive: (pid: number) => boolean;
  readonly host: string;
}

/** The same liveness test the orphaned throwaway database uses
 *  (ts-drizzle-postgres/scripts/app-database.ts): signal 0, and EPERM means
 *  the process exists under another user. */
const DEFAULT_DEPS: RestoreDeps = {
  alive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  host: hostname(),
};

function parseJournal(text: string): MutationJournal | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const j: Record<string, unknown> = { ...raw };
  const file = j["file"];
  if (j["version"] !== 1 || typeof file !== "string" || file === "" || isAbsolute(file) || file.split(/[\\/]/).includes("..")) {
    return undefined;
  }
  for (const key of ["mutation", "originalSha256", "mutatedSha256", "host", "startedAt"]) {
    if (typeof j[key] !== "string") return undefined;
  }
  if (typeof j["pid"] !== "number" || !Number.isInteger(j["pid"])) return undefined;
  return raw as MutationJournal;
}

const handOff = (what: string): string =>
  `${what}. Nothing runs over a tree that may still hold a mutant: compare the file with ${ORIGINAL_FILE} ` +
  `(its bytes before the mutant), put right what should be there, then delete ${JOURNAL_FILE}`;

/**
 * Restore whatever an interrupted mutation-score run left in the tree, or say
 * why it cannot be done safely. Logs a guard event for every restore and
 * every refusal. Never throws.
 */
export function restoreLeftoverMutant(cwd: string, deps: RestoreDeps = DEFAULT_DEPS): LeftoverRestore {
  const journalPath = join(cwd, JOURNAL_FILE);
  if (!existsSync(journalPath)) return { status: "none" };
  const refuse = (reason: string, detail: Record<string, unknown> = {}): LeftoverRestore => {
    logGuardEvent(cwd, { guard: MUTATION_GUARD, verdict: "block", summary: reason, detail: { kind: "leftover-refused", ...detail } });
    return { status: "refused", reason };
  };
  let journal: MutationJournal | undefined;
  try {
    journal = parseJournal(readFileSync(journalPath, "utf8"));
  } catch {
    journal = undefined;
  }
  if (journal === undefined) return refuse(handOff(`mutation-score left ${JOURNAL_FILE}, and it cannot be read`));
  const { file, mutation } = journal;

  if (journal.host !== deps.host || deps.alive(journal.pid)) {
    const owner = journal.host === deps.host ? `process ${journal.pid}` : `process ${journal.pid} on ${journal.host}`;
    return refuse(
      `a mutation-score run (${owner}) has a mutant in ${file} right now (${mutation}); wait for it to finish, ` +
        "or stop it (it restores the file when interrupted), then run this again",
      { file, mutation, pid: journal.pid, host: journal.host },
    );
  }

  const target = join(cwd, file);
  let current: Buffer | undefined;
  try {
    current = readFileSync(target);
  } catch {
    current = undefined;
  }
  if (current !== undefined && sha256(current) === journal.originalSha256) {
    clearJournal(cwd);
    rmSync(join(cwd, PROGRESS_FILE), { force: true });
    return { status: "clean", file };
  }
  if (current === undefined || sha256(current) !== journal.mutatedSha256) {
    return refuse(
      handOff(`${file} was changed after an interrupted mutation-score run mutated it (${mutation}), so it is not restored`),
      { file, mutation },
    );
  }

  let original: Buffer;
  try {
    original = readFileSync(join(cwd, ORIGINAL_FILE));
  } catch {
    return refuse(handOff(`${file} still holds a mutation-score mutant (${mutation}), and its saved original is missing`), { file, mutation });
  }
  if (sha256(original) !== journal.originalSha256) {
    return refuse(handOff(`${file} still holds a mutation-score mutant (${mutation}), and its saved original does not match the journal`), { file, mutation });
  }
  try {
    // In place, not by rename: the file keeps its mode and identity.
    writeFileSync(target, original);
  } catch (error) {
    return refuse(handOff(`${file} still holds a mutation-score mutant (${mutation}) and could not be written: ${error instanceof Error ? error.message : String(error)}`), { file, mutation });
  }
  if (!readFileSync(target).equals(original)) {
    return refuse(handOff(`${file} did not read back as its original after restoring a mutation-score mutant (${mutation})`), { file, mutation });
  }
  clearJournal(cwd);
  rmSync(join(cwd, PROGRESS_FILE), { force: true });
  const line =
    `restored ${file}: an interrupted mutation-score run (process ${journal.pid}, started ${journal.startedAt}) ` +
    `left a mutant in it (${mutation})`;
  logGuardEvent(cwd, {
    guard: MUTATION_GUARD,
    verdict: "pass",
    summary: line,
    detail: { kind: "leftover-restored", file, mutation, pid: journal.pid, startedAt: journal.startedAt },
  });
  return { status: "restored", file, mutation, line };
}
