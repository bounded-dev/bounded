// The composed phase test policies (the ts pack's `phaseTestPolicies`
// socket, ADR 2026-064), combined into the one decision a gate applies to
// the test process it spawns.
//
//   red     every policy's `env` is set and its `unsetEnv` removed; a skipped
//           result is accepted exactly when a skipping policy claims it
//   build   the builder's run_tests: a `run` may leave test files out
//           (`exclude`), merged across policies with every reason, so the
//           builder sees what green will route to it instead of a failure
//           that is the machine's; anywhere else an exclusion is a refusal
//   green   any refusal refuses the run; otherwise every policy's `unsetEnv`
//           is removed, so a variable leaked into the gate's environment
//           cannot skip anything
//   green   a refusal a policy routes to the user (the machine's container
//           engine) routes the gate to the user, but only when every
//           refusal does (`refusalRoute`, ADR 2026-072)
//   green   a policy may recognise a failure as the machine's, not the
//           code's (`infrastructureFailure`): when every failure is the
//           machine's, the gate routes to the user instead of a role
//   both    a policy may ask for a service the run needs (`prepare`): the
//           gate starts each in policy order just before the run, sets its
//           environment over everything else, and releases every one after
//           the run, whatever happened (withPreparedServices)

import { readProjectPacks } from "../../../src/project-composition.ts";
import { composePacks } from "../../../src/socket-registry.ts";
import { INSTALLED_PACKS } from "../../installed.ts";
import {
  type PhaseTestDecision, phaseTestPolicies, type PreparedTestService, routedToUser, type TestEnvChange, type TestFailure, type TestPhase,
  type USER_ROUTE,
} from "../pack.ts";

export interface PhaseRun {
  /** Why the gate must not run the suite at all (green only). */
  readonly refusals: readonly string[];
  /** "user" only when there are refusals and every one of them is a
   *  policy's refusal routed to the user (the machine's container engine);
   *  otherwise undefined, and the gate's own route applies (ADR 2026-072). */
  readonly refusalRoute?: typeof USER_ROUTE;
  /** Why some tests are skipped (red only), one line per skipping policy. */
  readonly skips: readonly string[];
  readonly env: { readonly set: Readonly<Record<string, string>>; readonly unset: readonly string[] };
  /** Is this skipped result one a policy skipped on purpose? */
  readonly skippedOnPurpose: (resultName: string) => boolean;
  /** Services to start for the run, in policy order. */
  readonly prepares: readonly { readonly name: string; readonly prepare: (env: TestEnvChange) => Promise<PreparedTestService> }[];
  /** Which of these failures a policy recognises as the machine's. */
  readonly infrastructure: (failures: readonly TestFailure[]) => InfrastructureVerdict;
  /** Test files to leave out of the run (build only), and why, one reason
   *  per excluding policy. */
  readonly exclusions: PhaseExclusions;
}

export interface PhaseExclusions {
  /** Project-relative test files, deduplicated, in policy order. */
  readonly files: readonly string[];
  readonly reasons: readonly string[];
}

export interface InfrastructureVerdict {
  /** The claimed causes, deduplicated, in order. */
  readonly causes: readonly string[];
  /** True only when there is at least one failure and every one is claimed:
   *  the only case that is the machine's alone. */
  readonly all: boolean;
}

/** Combine decisions. Pure. A skip at green, a refusal at red, or an
 *  exclusion anywhere but build is a policy defect and is treated as the
 *  strictest reading: a refusal. */
export function combineDecisions(phase: TestPhase, decisions: readonly { readonly name: string; readonly decision: PhaseTestDecision }[]): PhaseRun {
  const refusals: string[] = [];
  const skips: string[] = [];
  const set: Record<string, string> = {};
  const unset = new Set<string>();
  const claims: ((name: string) => boolean)[] = [];
  const prepares: { name: string; prepare: (env: TestEnvChange) => Promise<PreparedTestService> }[] = [];
  const classifiers: ((failure: TestFailure) => string | undefined)[] = [];
  const excluded = new Set<string>();
  const exclusionReasons: string[] = [];
  let everyRefusalUsers = true;
  for (const { name, decision } of decisions) {
    if (decision.action === "run" && decision.exclude !== undefined) {
      if (phase !== "build") {
        refusals.push(`${name} asked to leave test files out at ${phase}: ${decision.exclude.reason}`);
        everyRefusalUsers = false;
        continue;
      }
      for (const file of decision.exclude.files) excluded.add(file);
      exclusionReasons.push(decision.exclude.reason);
    }
    if (decision.action === "run" && decision.prepare !== undefined) prepares.push({ name, prepare: decision.prepare });
    if (decision.action === "run" && decision.infrastructureFailure !== undefined) classifiers.push(decision.infrastructureFailure);
    for (const variable of decision.unsetEnv) unset.add(variable);
    if (decision.action === "refuse" || (decision.action === "skip" && phase === "green")) {
      refusals.push(decision.action === "refuse" ? decision.reason : `${name} asked to skip tests at green: ${decision.reason}`);
      if (decision.action !== "refuse" || decision.route !== "user") everyRefusalUsers = false;
    } else if (decision.action === "skip") {
      skips.push(decision.reason);
      Object.assign(set, decision.env);
      claims.push(decision.skippedTest);
    }
  }
  for (const variable of Object.keys(set)) unset.delete(variable);
  return {
    refusals,
    ...(refusals.length > 0 && everyRefusalUsers ? { refusalRoute: "user" as const } : {}),
    skips,
    env: { set, unset: [...unset].sort() },
    skippedOnPurpose: (resultName) => claims.some((claim) => claim(resultName)),
    prepares,
    exclusions: { files: [...excluded], reasons: exclusionReasons },
    infrastructure: (failures) => {
      const causes = new Set<string>();
      let claimed = 0;
      for (const failure of failures) {
        for (const classify of classifiers) {
          let cause: string | undefined;
          try {
            cause = classify(failure);
          } catch {
            cause = undefined; // a classifier that cannot judge claims nothing
          }
          if (cause !== undefined) {
            causes.add(cause);
            claimed++;
            break;
          }
        }
      }
      return { causes: [...causes], all: failures.length > 0 && claimed === failures.length };
    },
  };
}

/** The outcome of a run inside prepared services. */
export type PreparedRun<T> =
  | { readonly ok: true; readonly value: T; readonly lines: readonly string[] }
  /** `route` is "user" when the service could not start for a reason only
   *  the user can clear (ADR 2026-072); otherwise the gate's own route. */
  | { readonly ok: false; readonly reason: string; readonly route?: typeof USER_ROUTE };

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
        service = await prepare({ set: { ...set }, unset: run.env.unset.filter((variable) => !(variable in set)) });
      } catch (error) {
        return {
          ok: false,
          reason: `the '${name}' test policy could not start what the run needs: ${error instanceof Error ? error.message : String(error)}`,
          ...(routedToUser(error) ? { route: "user" as const } : {}),
        };
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
