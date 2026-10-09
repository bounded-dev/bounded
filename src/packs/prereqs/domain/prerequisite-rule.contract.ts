import type { AgentName, Composition, Effect, ExtensionPoint, PackId, Result } from "bounded/domain";
import type { FileSetFingerprint } from "./file-set-fingerprint.contract.ts";
import type { PendingAgentRun } from "./pending-agent-run.contract.ts";
import type { PrerequisiteRecord } from "./prerequisite-record.contract.ts";
import type { CannotSeeFix, ProgramPrefix } from "./program-prefix.contract.ts";

/** The brand only PrerequisiteRule itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const prerequisiteRuleBrand: unique symbol;

/**
 * The one action a rule's wire form comes before: a delegation to an agent, a
 * write to a file its pattern matches, or an execute of a program with its
 * leading arguments ("terraform apply"). Exactly one is given.
 */
export type PrerequisiteBeforeJSON =
  | { readonly delegate: string; readonly write?: undefined; readonly execute?: undefined }
  | { readonly write: string; readonly delegate?: undefined; readonly execute?: undefined }
  | { readonly execute: string; readonly delegate?: undefined; readonly write?: undefined };

/**
 * A rule's wire form: what a project writes (an object literal) and
 * PrerequisiteRule.parse takes, and what toJSON gives back.
 */
export interface PrerequisiteRuleJSON {
  readonly before: PrerequisiteBeforeJSON;
  readonly require: { readonly delegate: string; readonly succeeded: true };
  readonly unchangedSince: readonly [string, ...string[]];
  readonly redirect: string;
}

/** The action a rule comes before, checked: an agent's name, a tidied file pattern, or a program prefix. */
export type PrerequisiteBefore =
  | { readonly delegate: AgentName; readonly write?: undefined; readonly execute?: undefined }
  | { readonly write: string; readonly delegate?: undefined; readonly execute?: undefined }
  | { readonly execute: ProgramPrefix; readonly delegate?: undefined; readonly write?: undefined };

/**
 * Whether a rule comes before an effect: definitely (what the effect does
 * that it comes before, for messages), not certainly, as bounded cannot see
 * what a shell command does (why, and what would let it see), or not.
 */
export type BeforeMatch = { readonly kind: "comes-before"; readonly what: string } | { readonly kind: "cannot-see"; readonly why: string; readonly fix: CannotSeeFix } | { readonly kind: "not-before" };

/**
 * Whether a rule's requirement is met now: a record over the current files
 * holds; else a run still to finish, launched over the current files, is
 * pending (ADR 2026-025); else records only over earlier files are stale;
 * none, or no matching file, is missing.
 */
export type PrerequisiteStatus = "holds" | "pending" | "stale" | "missing";

/**
 * A prerequisite rule: before an action (`before`), a delegation to an agent
 * (`require`) must have succeeded over the files `unchangedSince` names, as
 * they are now. `redirect` is what to do instead when it has not.
 */
export interface PrerequisiteRule {
  readonly __brand: "PrerequisiteRule";
  readonly [prerequisiteRuleBrand]: true;
  readonly before: PrerequisiteBefore;
  readonly require: { readonly delegate: AgentName; readonly succeeded: true };
  readonly unchangedSince: readonly [string, ...string[]];
  readonly redirect: string;
  /** Whether the rule definitely comes before `effect`: exactly matchBefore(effect).kind === "comes-before". */
  comesBefore(effect: Effect): boolean;
  /**
   * Whether the rule comes before `effect` (ADR 2026-019, amended): a
   * delegation to its agent (in any case, ignoring surrounding spaces: every
   * spelling a host may resolve to it); a write to a path its pattern matches
   * (ignoring case, as the protected-paths pack), by a file tool or in a
   * shell command's reading; a shell command whose reading runs its program
   * prefix. Where a shell command's reading cannot show whether it does, the
   * rule cannot see: an unread command, an unresolved program name or code,
   * and for an execute rule an unresolved argument before its words or a run
   * passing its program, for a write rule an unresolved write (never one to
   * /dev/null, /dev/stdout, /dev/stderr or /dev/fd/<n>). A delegation rule
   * is never before a shell command.
   */
  matchBefore(effect: Effect): BeforeMatch;
  /** The agent whose delegation the rule requires. */
  requiredAgent(): AgentName;
  /** Whether a delegation to `agent` is what the rule requires: the exact name, case-sensitively. Applied to the agent the host resolved (ADR 2026-025). */
  requiresDelegationTo(agent: AgentName): boolean;
  /**
   * Whether a delegation requested as `requested` may resolve to the rule's
   * required agent: the same name ignoring case and surrounding spaces, as
   * Claude Code resolves a requested name (ADR 2026-025). Such a delegation
   * is a candidate: its start is kept, and it counts only when the host says
   * it resolved to the required agent exactly.
   */
  mayResolveToRequiredAgent(requested: AgentName): boolean;
  /** The requirement it needs: its required agent (by its exact name) and its patterns (in any order, each once), as a record's. */
  requirementKey(): string;
  /** The action it comes before, for messages: "before write '<pattern>'", "before delegating to '<agent>'" or "before executing '<program and words>'". */
  describeBefore(): string;
  /** Whether its requirement is met, given every record, the current fingerprint of its files, and the runs still to finish. */
  status(records: readonly PrerequisiteRecord[], current: FileSetFingerprint, pendingRuns?: readonly PendingAgentRun[]): PrerequisiteStatus;
  /** The run still to finish that the rule waits on: one keeping a start for its requirement over the files as they are now; undefined when none. */
  pendingRun(pendingRuns: readonly PendingAgentRun[], current: FileSetFingerprint): PendingAgentRun | undefined;
  equals(other: PrerequisiteRule): boolean;
  toJSON(): PrerequisiteRuleJSON;
}

export interface PrerequisiteRuleFactory {
  /**
   * A frozen rule, its patterns and redirect tidied, or why the value is not
   * one: not { before, require, unchangedSince, redirect }; a before that is
   * not one delegation, write or execute, or an execute that is not a
   * program prefix (ProgramPrefixFactory.parse says why); a require
   * that is not a delegation that succeeded, or is the action it comes
   * before; patterns the protected-paths pack would refuse, or inside .bounded; a
   * redirect that is blank, holds control characters or is over 1000
   * characters. Never throws.
   */
  parse(raw: unknown): Result<PrerequisiteRule>;
}

/** The pack's rules in a composition, found by the declaration the pack made its point from: how its own code reads them without importing the pack. Undefined when the pack is not selected. */
export type RulesIn = (composition: Composition) => ExtensionPoint<PrerequisiteRule, PackId> | undefined;
