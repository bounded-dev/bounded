import type { DecisionTime, Result } from "bounded/domain";
import type { PrerequisiteBeforeJSON, PrerequisiteStatus } from "./prerequisite-rule.contract.ts";

/** The brand only PrerequisiteStatusSnapshot itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const prerequisiteStatusSnapshotBrand: unique symbol;

/** The snapshot's wire format: a reader that knows another refuses the file, naming both. */
export type PrerequisiteStatusSnapshotFormat = "bounded-prereqs-status/1";

/** One requirement as the reading found it: its key, agent and patterns, its status, how many files its patterns match, and the run it waits on while pending. */
export interface PrerequisiteRequirementStatusJSON {
  /** The requirement's key, as PrerequisiteRule.requirementKey gives it. */
  readonly key: string;
  readonly requiredAgent: string;
  /** The patterns as the first rule naming the requirement gives them. */
  readonly unchangedSince: readonly [string, ...string[]];
  readonly status: PrerequisiteStatus;
  readonly filesMatched: number;
  /** The run still to finish the requirement waits on, exactly when its status is pending; else null. */
  readonly pendingRun: { readonly agentRunId: string; readonly startedAt: string } | null;
}

/** One rule as the reading found it, in contribution order: the pack that contributed it, its own before, its requirement, and whether the gate would allow its action now. */
export interface PrerequisiteRuleStatusJSON {
  readonly contributedBy: string;
  readonly before: PrerequisiteBeforeJSON;
  readonly requirementKey: string;
  /** Whether the gate allows the action the rule comes before now: exactly when its requirement holds. */
  readonly allows: boolean;
}

/** A snapshot whose reading finished: each requirement once, in the order rules first name it, and every rule. */
export interface ReadPrerequisiteStatusSnapshotJSON {
  readonly format: PrerequisiteStatusSnapshotFormat;
  readonly outcome: "read";
  readonly readingStartedAt: string;
  readonly requirements: readonly PrerequisiteRequirementStatusJSON[];
  readonly rules: readonly PrerequisiteRuleStatusJSON[];
}

/** A snapshot whose reading could not be made, as a whole, and why. */
export interface UnreadPrerequisiteStatusSnapshotJSON {
  readonly format: PrerequisiteStatusSnapshotFormat;
  readonly outcome: "unread";
  readonly readingStartedAt: string;
  readonly why: string;
}

/** A snapshot's wire form: what toJSON gives and parse takes. It holds no project root; the file form adds one. */
export type PrerequisiteStatusSnapshotJSON = ReadPrerequisiteStatusSnapshotJSON | UnreadPrerequisiteStatusSnapshotJSON;

/**
 * bounded/prereqs's status as of one reading (ADR 2026-026): for display
 * only, it decides nothing. Read: every requirement the rules name, with
 * its status, and every rule, with whether the gate would allow its action.
 * Unread: why the reading could not be made, as a whole, never per rule.
 * Its time is when the reading began.
 */
export interface PrerequisiteStatusSnapshot {
  readonly __brand: "PrerequisiteStatusSnapshot";
  readonly [prerequisiteStatusSnapshotBrand]: true;
  readonly outcome: "read" | "unread";
  readonly readingStartedAt: DecisionTime;
  equals(other: PrerequisiteStatusSnapshot): boolean;
  toJSON(): PrerequisiteStatusSnapshotJSON;
}

export interface PrerequisiteStatusSnapshotFactory {
  /**
   * A frozen snapshot from its wire form, or why the value is not one, naming
   * the field: another format; an outcome that is neither read nor unread; a
   * key it does not have (a project root included); a readingStartedAt that
   * is not a decision time; a blank why; a requirement whose key is not its
   * agent's and patterns', whose status is unknown, whose filesMatched is not
   * a whole number (or is 0 and its status not missing), or with a pendingRun
   * other than exactly when it is pending; a requirement listed twice; a
   * rule whose before is not a rule's before, whose requirement is not
   * listed, or whose allows is not whether that requirement holds. Never
   * throws.
   */
  parse(raw: unknown): Result<PrerequisiteStatusSnapshot>;
}
