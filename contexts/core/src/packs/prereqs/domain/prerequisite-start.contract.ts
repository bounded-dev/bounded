import type { AgentName, Result } from "bounded/domain";
import type { FileSetFingerprint, FileSetFingerprintJSON } from "./file-set-fingerprint.contract.ts";

/** The brand only PrerequisiteStart itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const prerequisiteStartBrand: unique symbol;

/** A start's wire form: what is kept between a delegation and its result. */
export interface PrerequisiteStartJSON {
  readonly delegate: string;
  readonly unchangedSince: readonly [string, ...string[]];
  readonly fingerprint: FileSetFingerprintJSON;
}

/**
 * A delegation some rule requires, as it starts: the agent, the files a rule
 * requires unchanged, and their fingerprint before the run. Kept until the
 * delegation's result, when the files are fingerprinted again: only a run
 * over files that did not change while it ran counts.
 */
export interface PrerequisiteStart {
  readonly __brand: "PrerequisiteStart";
  readonly [prerequisiteStartBrand]: true;
  readonly delegate: AgentName;
  readonly unchangedSince: readonly [string, ...string[]];
  readonly fingerprint: FileSetFingerprint;
  /** The requirement it serves: its agent (ignoring case) and its patterns (in any order, each once). */
  requirementKey(): string;
  equals(other: PrerequisiteStart): boolean;
  toJSON(): PrerequisiteStartJSON;
}

export interface PrerequisiteStartFactory {
  /** A frozen start from its wire form, its patterns checked and tidied, or why the value is not one, naming the field. Never throws. */
  parse(raw: unknown): Result<PrerequisiteStart>;
  /** The starts kept for one call, as stored, each parsed; or why they are not a list of starts. Never throws. */
  parseList(raw: unknown): Result<readonly PrerequisiteStart[]>;
}
