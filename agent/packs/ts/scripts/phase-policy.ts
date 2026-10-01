// The composed phase test policies (the ts pack's `phaseTestPolicies`
// socket, ADR 2026-064), combined into the one decision a gate applies to
// the test process it spawns.
//
//   red     every policy's `env` is set and its `unsetEnv` removed; a skipped
//           result is accepted exactly when a skipping policy claims it
//   green   any refusal refuses the run; otherwise every policy's `unsetEnv`
//           is removed, so a variable leaked into the gate's environment
//           cannot skip anything

import { readProjectPacks } from "../../../src/project-composition.ts";
import { composePacks } from "../../../src/socket-registry.ts";
import { INSTALLED_PACKS } from "../../installed.ts";
import { type PhaseTestDecision, phaseTestPolicies, type TestPhase } from "../pack.ts";

export interface PhaseRun {
  /** Why the gate must not run the suite at all (green only). */
  readonly refusals: readonly string[];
  /** Why some tests are skipped (red only), one line per skipping policy. */
  readonly skips: readonly string[];
  readonly env: { readonly set: Readonly<Record<string, string>>; readonly unset: readonly string[] };
  /** Is this skipped result one a policy skipped on purpose? */
  readonly skippedOnPurpose: (resultName: string) => boolean;
}

/** Combine decisions. Pure. A skip at green, or a refusal at red, is a policy
 *  defect and is treated as the strictest reading: a refusal. */
export function combineDecisions(phase: TestPhase, decisions: readonly { readonly name: string; readonly decision: PhaseTestDecision }[]): PhaseRun {
  const refusals: string[] = [];
  const skips: string[] = [];
  const set: Record<string, string> = {};
  const unset = new Set<string>();
  const claims: ((name: string) => boolean)[] = [];
  for (const { name, decision } of decisions) {
    for (const variable of decision.unsetEnv) unset.add(variable);
    if (decision.action === "refuse" || (decision.action === "skip" && phase === "green")) {
      refusals.push(decision.action === "refuse" ? decision.reason : `${name} asked to skip tests at green: ${decision.reason}`);
    } else if (decision.action === "skip") {
      skips.push(decision.reason);
      Object.assign(set, decision.env);
      claims.push(decision.skippedTest);
    }
  }
  for (const variable of Object.keys(set)) unset.delete(variable);
  return {
    refusals,
    skips,
    env: { set, unset: [...unset].sort() },
    skippedOnPurpose: (resultName) => claims.some((claim) => claim(resultName)),
  };
}

/** The decision for the project at `cwd`. A policy that throws refuses, naming
 *  itself: a rule that could not decide has not allowed anything. */
export function phaseRun(cwd: string, phase: TestPhase): PhaseRun {
  const policies = composePacks(INSTALLED_PACKS, readProjectPacks(cwd)).read(phaseTestPolicies);
  return combineDecisions(phase, policies.map((policy) => {
    try {
      return { name: policy.name, decision: policy.decide({ project: cwd, phase }) };
    } catch (error) {
      return {
        name: policy.name,
        decision: { action: "refuse", reason: `the '${policy.name}' test policy could not decide: ${error instanceof Error ? error.message : String(error)}`, unsetEnv: [] },
      };
    }
  }));
}
