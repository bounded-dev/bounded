import { type AfterToolReport, type CallId, portKeysFor, type Result, type ToolResult, type ToolUse, type Verdict } from "bounded/domain";
import { prereqsId } from "../../domain/prereqs-id.ts";
import type { PrerequisiteRecord } from "../../domain/prerequisite-record.contract.ts";
import type { PrerequisiteStart } from "../../domain/prerequisite-start.contract.ts";

// Domain types this feature's ports carry, listed here so this contract names them.
export type { FileSetFingerprint, FileSetFingerprintJSON } from "../../domain/file-set-fingerprint.contract.ts";
export type { PrerequisiteRecord, PrerequisiteRecordJSON } from "../../domain/prerequisite-record.contract.ts";
export type { PrerequisiteStart, PrerequisiteStartJSON } from "../../domain/prerequisite-start.contract.ts";

// In port: what this feature offers.
/**
 * Check prerequisites around a tool call. Before it: an action a rule comes
 * before is refused unless its requirement holds, and a delegation some rule
 * requires has its files fingerprinted as it starts. After it: a delegation
 * the host says finished, that succeeded, over files that did not change
 * while it ran, is recorded; anything else is not, and the agent is told why.
 */
export interface CheckPrerequisites {
  /** Before an allowed tool call: allow, or refuse naming the pack, the rule and its redirect. Never rejects. */
  before(call: ToolUse): Promise<Verdict>;
  /** After the call ran: what to tell the agent and what to record. Never rejects. */
  after(result: ToolResult): Promise<AfterToolReport>;
}

// Out ports: exactly what this feature needs.
/**
 * The fingerprint of the project files a list of patterns names (see
 * FileSet: matched ignoring case, seeing dotfiles, a glob-free pattern
 * covering what is under it; never inside .bounded, node_modules or .git;
 * gitignored files included). What it gives is parsed by the handler.
 * @implementedBy FileSystemFileSetFingerprints
 */
export interface FileSetFingerprints {
  /** The fingerprint's wire form ({ sha256, fileCount }), or why it cannot be computed. */
  fingerprint(patterns: readonly string[]): Promise<Result<unknown>>;
}

/**
 * Where the pack keeps its records, and the starts of the delegations it is
 * waiting on, by call id. A host may run each hook in a process of its own,
 * so a store must outlive it; what it gives back is parsed by the handler:
 * anything running as the same user can change it.
 * @implementedBy FileSystemPrerequisiteRecords
 */
export interface PrerequisiteRecords {
  /** Appends one record; rejects when it cannot be written. */
  append(record: PrerequisiteRecord): Promise<void>;
  /** Every record as stored, in order, unparsed; rejects when the store cannot be read. */
  readAll(): Promise<readonly unknown[]>;
  /** Keeps the starts of one call, replacing any kept for it; rejects when it cannot be written. */
  saveStartedForCall(callId: CallId, starts: readonly PrerequisiteStart[]): Promise<void>;
  /** The starts kept for a call, as stored, removed as given; undefined when none (or expired); rejects when unreadable. */
  takeStartedForCall(callId: CallId): Promise<unknown>;
}

// The pack's ports for this feature: a host provides them through openProject({ ports }).
/** The fingerprints of the project's files. */
export const fileSetFingerprintsPort = portKeysFor(prereqsId)<FileSetFingerprints>("fileSetFingerprints");
/** The pack's records and starts. */
export const prerequisiteRecordsPort = portKeysFor(prereqsId)<PrerequisiteRecords>("prerequisiteRecords");
