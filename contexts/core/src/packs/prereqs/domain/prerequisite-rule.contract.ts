import type { AgentName, Composition, Effect, ExtensionPoint, PackId, Result } from "bounded/domain";
import type { FileSetFingerprint } from "./file-set-fingerprint.contract.ts";
import type { PrerequisiteRecord } from "./prerequisite-record.contract.ts";

/** The brand only PrerequisiteRule itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const prerequisiteRuleBrand: unique symbol;

/** The one action a rule's wire form comes before: a delegation to an agent, or a write to a file its pattern matches. Exactly one is given. */
export type PrerequisiteBeforeJSON = { readonly delegate: string; readonly write?: undefined } | { readonly write: string; readonly delegate?: undefined };

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

/** The action a rule comes before, checked: an agent's name, or a tidied file pattern. */
export type PrerequisiteBefore = { readonly delegate: AgentName; readonly write?: undefined } | { readonly write: string; readonly delegate?: undefined };

/** Whether a rule's requirement is met now: a record over the current files holds; records only over earlier files are stale; none, or no matching file, is missing. */
export type PrerequisiteStatus = "holds" | "stale" | "missing";

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
  /** Whether the rule comes before `effect`: a delegation to its agent (in any case, ignoring surrounding spaces: every spelling a host may resolve to it), or a write to a path its pattern matches (ignoring case, as the protected-paths pack). */
  comesBefore(effect: Effect): boolean;
  /** The agent whose delegation the rule requires. */
  requiredAgent(): AgentName;
  /** Whether a delegation to `agent` is what the rule requires: the exact name, case-sensitively. */
  requiresDelegationTo(agent: AgentName): boolean;
  /** The requirement it needs: its required agent (by its exact name) and its patterns (in any order, each once), as a record's. */
  requirementKey(): string;
  /** The action it comes before, for messages: "before write '<pattern>'" or "before delegating to '<agent>'". */
  describeBefore(): string;
  /** Whether its requirement is met, given every record and the current fingerprint of its files. */
  status(records: readonly PrerequisiteRecord[], current: FileSetFingerprint): PrerequisiteStatus;
  equals(other: PrerequisiteRule): boolean;
  toJSON(): PrerequisiteRuleJSON;
}

export interface PrerequisiteRuleFactory {
  /**
   * A frozen rule, its patterns and redirect tidied, or why the value is not
   * one: not { before, require, unchangedSince, redirect }; a before that is
   * not one delegation or write (an execute is not matched yet); a require
   * that is not a delegation that succeeded, or is the action it comes
   * before; patterns the protected-paths pack would refuse, or inside .bounded; a
   * redirect that is blank, holds control characters or is over 1000
   * characters. Never throws.
   */
  parse(raw: unknown): Result<PrerequisiteRule>;
}

/** The pack's rules in a composition, found by the declaration the pack made its point from: how its own code reads them without importing the pack. Undefined when the pack is not selected. */
export type RulesIn = (composition: Composition) => ExtensionPoint<PrerequisiteRule, PackId> | undefined;
