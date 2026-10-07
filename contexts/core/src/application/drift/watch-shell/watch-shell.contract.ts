import type { Result, ToolResult, ToolUse, Verdict, WatchedPath } from "bounded/domain";

/** A watched file's content hash, and the index of the first rule that watches it. */
export interface WatchedFile {
  readonly hash: string;
  readonly rule: number;
}

/** Every watched file by project-relative path. */
export type WatchedHashes = Readonly<Record<string, WatchedFile>>;

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
 * The project's files: hashing those the rules watch, and putting files back
 * from version control (removing any it never held).
 * @implementedBy in-memory file-system
 */
export interface WatchedFiles {
  hash(rules: readonly WatchedPath[]): Promise<Result<WatchedHashes>>;
  restore(paths: readonly string[]): Promise<Result<void>>;
}

/**
 * Snapshots kept between a call and its result, by call id. A host may run
 * each hook in a process of its own, so a store must outlive it.
 * @implementedBy in-memory file-system
 */
export interface ShellSnapshots {
  save(callId: string, hashes: WatchedHashes): Promise<void>;
  /** The snapshot for a call, removed as it is given; undefined when there is none. */
  take(callId: string): Promise<WatchedHashes | undefined>;
}
