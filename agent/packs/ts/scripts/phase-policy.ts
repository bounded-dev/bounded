// The composed phase test policies (the ts pack's `phaseTestPolicies`
// socket, ADR 2026-064), combined into the one decision a gate applies to
// the test process it spawns.
//
//   red     every policy's `env` is set and its `unsetEnv` removed; a skipped
//           result is accepted exactly when a skipping policy claims it
//   green   any refusal refuses the run; otherwise every policy's `unsetEnv`
//           is removed, so a variable leaked into the gate's environment
//           cannot skip anything
//   both    a policy may ask for a service the run needs (`prepare`): the
//           gate starts each in policy order just before the run, sets its
//           environment over everything else, and releases every one after
//           the run, whatever happened (withPreparedServices)

import { readProjectPacks } from "../../../src/project-composition.ts";
import { composePacks } from "../../../src/socket-registry.ts";
import { INSTALLED_PACKS } from "../../installed.ts";
import { type PhaseTestDecision, phaseTestPolicies, type PreparedTestService, type TestPhase } from "../pack.ts";

export interface PhaseRun {
  /** Why the gate must not run the suite at all (green only). */
  readonly refusals: readonly string[];
  /** Why some tests are skipped (red only), one line per skipping policy. */
  readonly skips: readonly string[];
  readonly env: { readonly set: Readonly<Record<string, string>>; readonly unset: readonly string[] };
  /** Is this skipped result one a policy skipped on purpose? */
  readonly skippedOnPurpose: (resultName: string) => boolean;
  /** Services to start for the run, in policy order. */
  readonly prepares: readonly { readonly name: string; readonly prepare: () => Promise<PreparedTestService> }[];
}

/** Combine decisions. Pure. A skip at green, or a refusal at red, is a policy
 *  defect and is treated as the strictest reading: a refusal. */
export function combineDecisions(phase: TestPhase, decisions: readonly { readonly name: string; readonly decision: PhaseTestDecision }[]): PhaseRun {
  const refusals: string[] = [];
  const skips: string[] = [];
  const set: Record<string, string> = {};
  const unset = new Set<string>();
  const claims: ((name: string) => boolean)[] = [];
  const prepares: { name: string; prepare: () => Promise<PreparedTestService> }[] = [];
  for (const { name, decision } of decisions) {
    if (decision.action === "run" && decision.prepare !== undefined) prepares.push({ name, prepare: decision.prepare });
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
    prepares,
  };
}

/** The outcome of a run inside prepared services. */
export type PreparedRun<T> =
  | { readonly ok: true; readonly value: T; readonly lines: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Start every service the policies asked for, run `body` with the run's
 * environment (each service's variables set over the policies' own), and
 * release every started service afterwards — after a failed start, a throw
 * or a normal return alike, in reverse order. A service that cannot start
 * means the run did not happen: `ok: false` with the reason, never a run
 * against whatever the environment already pointed at.
 */
export async function withPreparedServices<T>(
  run: Pick<PhaseRun, "env" | "prepares">,
  body: (env: PhaseRun["env"]) => Promise<T>,
): Promise<PreparedRun<T>> {
  const started: PreparedTestService[] = [];
  const releaseAll = (): void => {
    for (const service of started.splice(0).reverse()) {
      try {
        service.release();
      } catch {
        // release never throws by contract; a broken one must not mask the run
      }
    }
  };
  // An interrupted gate (Ctrl-C, a host killing it) still takes down what it
  // started, then dies of the same signal.
  const onSignal = (signal: NodeJS.Signals): void => {
    releaseAll();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.kill(process.pid, signal);
  };
  if (run.prepares.length > 0) {
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  }
  try {
    const set: Record<string, string> = { ...run.env.set };
    for (const { name, prepare } of run.prepares) {
      let service: PreparedTestService;
      try {
        service = await prepare();
      } catch (error) {
        return { ok: false, reason: `the '${name}' test policy could not start what the run needs: ${error instanceof Error ? error.message : String(error)}` };
      }
      started.push(service);
      Object.assign(set, service.env);
    }
    const lines = started.map((service) => service.description);
    const unset = run.env.unset.filter((variable) => !(variable in set));
    const value = await body({ set, unset });
    return { ok: true, value, lines };
  } finally {
    releaseAll();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
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
