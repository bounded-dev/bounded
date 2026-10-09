import type { AdapterRefusalJSON, Command, Decision, DecisionId, DecisionTime, Event, ProjectPath, Result, Verdict } from "bounded/domain";

/** The brand only JudgeEventCommand itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const judgeEventCommandBrand: unique symbol;

// Wire input: the event's own wire form, checked by Event.parse.
export type JudgeEventInput = unknown;

// Command: the input once checked into an event.
export interface JudgeEventCommand {
  readonly __brand: "JudgeEventCommand";
  readonly [judgeEventCommandBrand]: true;
  readonly event: Event;
}

export interface JudgeEventCommandFactory {
  parse(raw: unknown): Result<JudgeEventCommand>;
}

// In port: what this feature offers.
/** Decide an event with the composed guards and record the decision; the verdict is what the host enforces. */
export interface JudgeEvent {
  execute(command: JudgeEventCommand): Promise<Verdict>;
  /** Judges an event in its wire form: one that cannot be read is refused and recorded as invalid. Never rejects. */
  judge(raw: unknown): Promise<Verdict>;
  /** Records a refusal the host adapter made itself, before an event existed, and returns it. Never rejects. */
  refuse(refusal: AdapterRefusalInput): Promise<Verdict>;
}

/** How a judge-event handler is set up, beyond its composition and out ports. */
export interface JudgeEventOptions {
  /** How long recording a decision may take before the event is refused. */
  readonly recordWithinMs?: number;
  /** When set, every event is refused with this verdict (a project whose configuration cannot be used). */
  readonly refuseEverything?: Verdict;
  readonly ids?: DecisionIds;
  /** Run when the guards allow an event, before it is recorded; a refusal replaces the allow. */
  readonly beforeAllow?: (event: Event) => Promise<Verdict>;
  /**
   * Reads every execute effect's command before the guards run (ADR 2026-020).
   * Without one, every command is judged unread, saying the host passes one.
   */
  readonly shellCommandReader?: ShellCommandReader;
  /** The project's root, an absolute path, given to the reader with each command: required with a reader. */
  readonly projectRoot?: string;
  /** How long reading every command of one event may take; a command still unread then is judged unread, timed out. */
  readonly readWithinMs?: number;
}

/** A refusal the host adapter made itself, in its wire form: the host's tool name, its input, the role, and the reason and redirect (read by AdapterRefusal.parse). */
export type AdapterRefusalInput = AdapterRefusalJSON;

// Out ports: exactly what this feature needs.
/**
 * Where decisions are kept, append-only. Asynchronous, so it can be a file
 * today and a remote service later.
 * @implementedBy FileSystemBoundedLog
 */
export interface BoundedLog {
  record(decision: Decision): Promise<void>;
}

/**
 * A new `DecisionId` for each decision, never the same twice. The handlers
 * still parse what it gives when a decision is recorded (ADR 2026-017).
 * @implementedBy RandomDecisionIds
 */
export interface DecisionIds {
  next(): DecisionId;
}

/**
 * Reads a shell command: what it runs, the files it reads, lists and writes,
 * and what only the shell could resolve (ADR 2026-020). `read` gives the
 * reading's wire form (a ShellCommandReadingJSON), which the judge parses,
 * for `command` run from `cwd` (null: the project root) in the project at
 * `projectRoot`; it rejects when it cannot read at all. `prepare` loads what
 * reading needs, once, when the project opens; `read` works unprepared too.
 * Untagged, as HostInstaller is: the core names no reader. Its adapters live
 * in other packages (bounded's own, published as bounded/shell-command-reader;
 * a host's own) and each runs the suite in judge-event.shell-command-reader.test-support.ts,
 * published as bounded/testing/shell-command-reader-conformance.
 */
export interface ShellCommandReader {
  prepare(): Promise<void>;
  read(projectRoot: string, command: Command, cwd: ProjectPath | null): Promise<unknown>;
}

/**
 * The time of a decision, a `DecisionTime` (ISO 8601 in UTC). The handlers
 * still parse what it gives when a decision is recorded, so a host clock that
 * gives the ISO 8601 text is accepted with the same check (ADR 2026-017).
 * @implementedBy SystemClock
 */
export interface Clock {
  now(): DecisionTime;
}
