import type { AgentName, CallId, Result } from "bounded/domain";
import type { FileSetFingerprint } from "./file-set-fingerprint.contract.ts";
import type { PrerequisiteStartJSON } from "./prerequisite-start.contract.ts";

/** The brand only PrerequisiteRecord itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const prerequisiteRecordBrand: unique symbol;

/** A record's wire form: one line of the pack's records. */
export interface PrerequisiteRecordJSON extends PrerequisiteStartJSON {
  readonly callId: string;
}

/**
 * A delegation that succeeded over files that did not change while it ran:
 * the agent, the files a rule requires unchanged, their fingerprint, and the
 * id of the call that ran it. A requirement holds while its files' current
 * fingerprint equals a record's. Records are content-addressed: files put
 * back as they were reviewed hold again.
 */
export interface PrerequisiteRecord {
  readonly __brand: "PrerequisiteRecord";
  readonly [prerequisiteRecordBrand]: true;
  readonly delegate: AgentName;
  readonly unchangedSince: readonly [string, ...string[]];
  readonly fingerprint: FileSetFingerprint;
  readonly callId: CallId;
  /** The requirement it serves: its agent (by its exact name) and its patterns (in any order, each once), as a start's. */
  requirementKey(): string;
  equals(other: PrerequisiteRecord): boolean;
  toJSON(): PrerequisiteRecordJSON;
}

export interface PrerequisiteRecordFactory {
  /** A frozen record from its wire form, its patterns checked and tidied, or why the value is not one, naming the field. Never throws. */
  parse(raw: unknown): Result<PrerequisiteRecord>;
}
