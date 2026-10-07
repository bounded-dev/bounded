import type { Result, ToolResult, ToolUse, Verdict, WatchedPath } from "bounded/domain";

/**
 * A watched file: the SHA-256 of its bytes (hex), its size in bytes, and the
 * index of the first rule that watches it. A link is never followed: `link`
 * is true, and its hash is of where it points.
 */
export interface WatchedFile {
  readonly hash: string;
  readonly size: number;
  readonly rule: number;
  readonly link?: true;
}

/** Every watched file by project-relative path. */
export type WatchedHashes = Readonly<Record<string, WatchedFile>>;

/**
 * How a file can be put back as it was before a command: from the commit
 * (its content matched it), from a copy of its bytes (base64), or nowhere
 * (too large to copy: a change is reported, never replaced).
 */
export type Kept = { readonly from: "commit" } | { readonly from: "copy"; readonly content: string; readonly executable: boolean } | { readonly from: "nowhere" };

/** A watched file before a command, and how it can be put back. */
export interface SnapshotFile extends WatchedFile {
  readonly kept: Kept;
}

/** The watched files before a command, and the commit they were compared with (null outside git or before a first commit). */
export interface Snapshot {
  readonly commit: string | null;
  readonly files: Readonly<Record<string, SnapshotFile>>;
}

/** Where a restored file comes from: a commit (its bytes and executable bit), or a copy of its bytes (base64) and whether it was executable. */
export type RestoreFrom = { readonly from: "commit"; readonly commit: string } | { readonly from: "copy"; readonly content: string; readonly executable: boolean };

/** A watched file that a shell command changed. */
export interface Change {
  readonly path: string;
  readonly change: "modified" | "deleted" | "created";
}

/** What a shell command did to watched files: none, or the changes, whether they were undone, and what to tell the agent. */
export interface DriftCheck {
  readonly changed: readonly Change[];
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

// Out ports: exactly what this feature needs (with the judge-event feature's DecisionLog, Clock and DecisionIds).
/**
 * The project's files: hashing those the rules watch (a rule's match ignores
 * case, its except does not), what a commit holds, copies of files, and
 * putting a file back. Never inside .git or .bounded.
 * @implementedBy in-memory file-system
 */
export interface WatchedFiles {
  /** The watched files now; never inside node_modules or .git at any depth, nor .bounded, and never through a linked directory. */
  hash(rules: readonly WatchedPath[]): Promise<Result<WatchedHashes>>;
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
