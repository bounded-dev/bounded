import { type AfterToolReport, type AgentRunFinished, type AgentRunFinishReport, type AgentRunId, type CallId, type DecisionTime, portKeysFor, type Result, type ToolResult, type ToolUse, type Verdict } from "bounded/domain";
import { prereqsId } from "../../domain/prereqs-id.ts";
import type { PrerequisiteRecord } from "../../domain/prerequisite-record.contract.ts";
import type { PrerequisiteStart } from "../../domain/prerequisite-start.contract.ts";
import type { PrerequisiteStatusSnapshot, PrerequisiteStatusSnapshotJSON } from "../../domain/prerequisite-status-snapshot.contract.ts";

// Domain types this feature's ports carry, listed here so this contract names them.
export type { FileSetFingerprint, FileSetFingerprintJSON } from "../../domain/file-set-fingerprint.contract.ts";
export type { PendingAgentRun, PendingAgentRunJSON } from "../../domain/pending-agent-run.contract.ts";
export type { PrerequisiteRecord, PrerequisiteRecordJSON } from "../../domain/prerequisite-record.contract.ts";
export type { PrerequisiteStart, PrerequisiteStartJSON } from "../../domain/prerequisite-start.contract.ts";
export type {
  PrerequisiteRequirementStatusJSON,
  PrerequisiteRuleStatusJSON,
  PrerequisiteStatusSnapshot,
  PrerequisiteStatusSnapshotFormat,
  PrerequisiteStatusSnapshotJSON,
  ReadPrerequisiteStatusSnapshotJSON,
  UnreadPrerequisiteStatusSnapshotJSON,
} from "../../domain/prerequisite-status-snapshot.contract.ts";

// In port: what this feature offers.
/**
 * Check prerequisites around a tool call, and at a delegated run's finish.
 * Before a call: an action a rule comes before is refused unless its
 * requirement holds (and refused as pending while a run that may meet it goes
 * on), and a delegation that may resolve to an agent some rule requires has
 * its files fingerprinted as it starts. After it: a run the host says
 * finished, as the required agent exactly, that succeeded, over files that
 * did not change while it ran, is recorded; a run whose finish the host
 * reports later has its start kept for that finish; anything else is not
 * recorded, and the agent is told why. At a run's finish: the same, recorded
 * in the Bounded log (ADR 2026-025).
 */
export interface CheckPrerequisites {
  /** Before an allowed tool call: allow, or refuse naming the pack, the rule and its redirect. Never rejects. */
  before(call: ToolUse): Promise<Verdict>;
  /** After the call ran: what to tell the agent and what to record. Never rejects. */
  after(result: ToolResult): Promise<AfterToolReport>;
  /** When a run whose finish the host reports later has finished: what to record, if anything. Never rejects. */
  recordAgentRunFinish(finish: AgentRunFinished): Promise<AgentRunFinishReport>;
  /**
   * The status of every rule's requirement now, as a snapshot whose reading
   * began at `readingStartedAt` (ADR 2026-026): read, or unread as a whole,
   * saying why. It reads only: records once, the runs still to finish at most
   * once (only when a requirement does not hold by its records), and each
   * requirement's files once. Never rejects.
   */
  readRuleStatuses(readingStartedAt: DecisionTime): Promise<PrerequisiteStatusSnapshot>;
  /**
   * Saves the status snapshot: its time from the store, taken before the
   * reading (none saved when that time does not parse); unread when the
   * reading overruns `withinMs`; the save abandoned after 500 ms, and a
   * failed one swallowed. For display only: it decides nothing. Never rejects.
   */
  writeStatusSnapshot(snapshots: PrerequisiteStatusSnapshots, options: { readonly withinMs: number }): Promise<void>;
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
 * Where the pack keeps its records, the starts of the delegations it is
 * waiting on by call id, and the starts of the runs whose finish the host
 * reports later by run id. A host may run each hook in a process of its own,
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
  /** Keeps the starts of a run whose finish the host reports later, with the call that launched it, stamped with when they were kept; replaces any kept for the run; rejects when it cannot be written. */
  saveStartedForRun(agentRunId: AgentRunId, callId: CallId, starts: readonly PrerequisiteStart[]): Promise<void>;
  /** The run's pending entry ({ agentRunId, callId, startedAt, starts }), as stored, removed as given; undefined when none (or expired); rejects when unreadable. */
  takeStartedForRun(agentRunId: AgentRunId): Promise<unknown>;
  /** Every run's pending entry still kept, as stored, none removed; rejects when one cannot be read. */
  readStartedForRuns(): Promise<readonly unknown[]>;
}

/**
 * Where the pack keeps the status snapshot a display reads (ADR 2026-026):
 * an optional port, which a host may provide; for output only, so no verdict
 * and no record depends on it. A host may run each hook in a process of its
 * own, so a store must outlive it.
 * @implementedBy FileSystemPrerequisiteStatusSnapshots
 */
export interface PrerequisiteStatusSnapshots {
  /** The time now, as the store keeps it; parsed by the handler as a DecisionTime. */
  now(): unknown;
  /** Saves the snapshot for this project, unless the one kept began its reading later; on failure removes the kept one, then rejects. */
  save(snapshot: PrerequisiteStatusSnapshot): Promise<void>;
}

/** The file form a store keeps: the snapshot and the root of the project it was read for. */
export type PrerequisiteStatusSnapshotFileJSON = PrerequisiteStatusSnapshotJSON & { readonly projectRoot: string };

// The pack's ports for this feature: a host provides them through openProject({ ports }).
/** The fingerprints of the project's files. */
export const fileSetFingerprintsPort = portKeysFor(prereqsId)<FileSetFingerprints>("fileSetFingerprints");
/** The pack's records and starts. */
export const prerequisiteRecordsPort = portKeysFor(prereqsId)<PrerequisiteRecords>("prerequisiteRecords");
/** The status snapshot: an optional port (ADR 2026-026), which only a host that shows the status provides. */
export const prerequisiteStatusSnapshotsPort = portKeysFor(prereqsId)<PrerequisiteStatusSnapshots>("prerequisiteStatusSnapshots");
