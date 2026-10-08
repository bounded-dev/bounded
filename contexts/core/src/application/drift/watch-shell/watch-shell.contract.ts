import type { Result, Snapshot, ToolResult, ToolUse, Verdict, WatchedFile, WatchedPath } from "bounded/domain";

// Domain types this feature's ports carry, listed here so this contract names them.
export type { Kept, Snapshot, SnapshotFile, SnapshotJSON, WatchedFile } from "bounded/domain";

// Out ports this feature shares with judge-event: declared there, listed here so this contract names every port the feature needs.
import type { DecisionIds } from "../../guard-log/judge-event/judge-event.contract.ts";
export type { Clock, DecisionIds, GuardLog } from "../../guard-log/judge-event/judge-event.contract.ts";

/** Every watched file by project-relative path. */
export type WatchedHashes = Readonly<Record<string, WatchedFile>>;

/** Where a restored file comes from: a commit (its bytes and executable bit), or a copy of its bytes (base64) and whether it was executable. */
export type RestoreFrom = { readonly from: "commit"; readonly commit: string } | { readonly from: "copy"; readonly content: string; readonly executable: boolean };

/** A watched file that a shell command changed. */
export interface FileChange {
  readonly path: string;
  readonly change: "modified" | "deleted" | "created";
}

/** What a shell command did to watched files: none, or the changes, whether they were undone, and what to tell the agent. */
export interface DriftCheck {
  readonly changed: readonly FileChange[];
  readonly restored: boolean;
  readonly message: string | null;
}

// In port: what this feature offers.
/** Watch the files a shell command must not change: snapshot before it runs, put back what it changed after. */
export interface WatchShell {
  /** Before an allowed tool call with a shell command: hash the watched files under the call's id. A refusal if that cannot be done. */
  snapshot(call: ToolUse): Promise<Verdict>;
  /** After the call ran: undo any change to watched files, record it, and say what happened. */
  verify(result: ToolResult): Promise<DriftCheck>;
}

// Out ports: exactly what this feature needs (with the judge-event feature's GuardLog, Clock and DecisionIds).
/**
 * The project's files: hashing those the rules watch (a rule's match ignores
 * case, its except does not), what a commit holds, copies of files, and
 * putting a file back. Never inside .git or .bounded.
 * @implementedBy in-memory file-system
 */
export interface WatchedFiles {
  /** The watched files now; never inside node_modules or .git at any depth, nor .bounded, and never through a linked directory. */
  hash(rules: readonly WatchedPath[]): Promise<Result<WatchedHashes>>;
  /** The indexes of every rule that watches `path`, in order, whether or not a file is there. */
  rulesWatching(rules: readonly WatchedPath[], path: string): readonly number[];
  /** The commit checked out; null when the project is not a git repository with a commit. */
  head(): Promise<Result<string | null>>;
  /** The watched files as `commit` holds them. */
  committed(rules: readonly WatchedPath[], commit: string): Promise<Result<WatchedHashes>>;
  /** A file's bytes, base64, with their hash and size, and whether it is executable. */
  copy(path: string): Promise<Result<{ readonly hash: string; readonly size: number; readonly content: string; readonly executable: boolean }>>;
  /** Puts one project-relative file back; refuses a path outside the project. Leaves version control's index alone. */
  restore(path: string, from: RestoreFrom): Promise<Result<void>>;
  /** Moves files out of the project into a new quarantine directory, keeping their paths, and says where. Never deletes. */
  quarantine(paths: readonly string[]): Promise<Result<string>>;
}

/**
 * Snapshots kept between a call and its result, by call id. A host may run
 * each hook in a process of its own, so a store must outlive it. What it
 * gives back is checked by the handler: a store outside the process can be
 * changed by anything running as the same user.
 * @implementedBy in-memory file-system
 */
export interface ShellSnapshots {
  save(callId: string, snapshot: Snapshot): Promise<void>;
  /** The snapshot for a call as stored, removed as it is given; undefined when there is none (or it expired). Rejects when it cannot be read. */
  take(callId: string): Promise<unknown>;
}

/** How a watch-shell handler is set up, beyond its composition and out ports. */
export interface WatchShellOptions {
  readonly ids?: DecisionIds;
  /** How much a snapshot copies of files version control does not hold. */
  readonly limits?: { readonly perFile: number; readonly total: number };
}
