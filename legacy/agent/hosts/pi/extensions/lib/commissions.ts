// pi's half of the commission rule (ADR LEG-2026-034; src/phase-gate.ts).
//
// The core holds the rule: a bounce goes back to the worker that already ran,
// never to a cold relaunch. How a finished worker is continued is pi's:
// pi-subagents retains completed children and continues one in place.
//
//   { action: "children.list" }                        → run ids + resumable state
//   { action: "resume", id: "<run-id>", message: "…" } → continue that child
//
// `children.list` is itself a `subagent` call, so the gate sees that the
// architect looked; looking licenses a cold launch, because that is the
// legitimate case where the retained child was not resumable. What is refused
// is respawning WITHOUT looking. Deadlock-free by construction, and it needs
// no knowledge of pi's internal state: the evidence is the architect's own
// tool calls.

import type { CommissionCall, CommissionHost } from "../../../../src/phase-gate.ts";
import { spawnAgentName } from "../../../../src/model-tier.ts";

/** The `subagent` action that lists retained children. */
export const CHILDREN_LIST_ACTION = "children.list";

/**
 * The `action` value that revives a retained child. pi-subagents has no
 * separate "revive" action: `action: "resume"` covers both a live nested run
 * and the revive of a paused, completed or failed one. It does not accept a
 * model: `action='resume' reuses the persisted child model and does not
 * accept a model override` (pi-subagents 0.52.1), so a resume is never tiered.
 */
export const RESUME_ACTION = "resume";

/** Is this `subagent` call reviving an existing child rather than launching one? */
export function isResumeCall(input: Readonly<Record<string, unknown>>): boolean {
  return input["action"] === RESUME_ACTION;
}

/**
 * The run a resume names, as the caller wrote it. `id` is the documented
 * field and `runId` its alias; `dir` is the async run directory, accepted for
 * the same target. Undefined when the call names none of them — which
 * pi-subagents refuses anyway, but which is still logged as a resume of an
 * unnamed run rather than skipped.
 */
export function resumeRunId(input: Readonly<Record<string, unknown>>): string | undefined {
  for (const key of ["id", "runId", "dir"]) {
    const v = input[key];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return undefined;
}

/**
 * The `subagent` input fields that carry MORE THAN ONE child in a single call:
 * `workflowScript` (run as a statement body over `runs.run`/`runs.all`), and
 * the `chain` / `parallel` item arrays the same schema models.
 */
export const PI_MULTI_SPAWN_FIELDS: readonly string[] = ["workflowScript", "chain", "parallel"];

function classify(input: Readonly<Record<string, unknown>>): CommissionCall {
  const action = input["action"];
  if (typeof action !== "string") return { kind: "launch" };
  if (action === CHILDREN_LIST_ACTION) return { kind: "check" };
  if (isResumeCall(input)) {
    // pi-subagents resolves the agent from the persisted run record rather
    // than from the input, so the ordinary resume names no role; a named one
    // is the caller's claim, and recording the claim beats recording nothing.
    const run = resumeRunId(input);
    const role = spawnAgentName(input);
    return { kind: "continue", ...(run !== undefined ? { run } : {}), ...(role !== undefined ? { role } : {}) };
  }
  // status/wait/stop/steer on an existing child: inspection, never refused.
  if (action !== "launch" && action !== "run") return { kind: "other" };
  return { kind: "launch" };
}

export const PI_COMMISSIONS: CommissionHost = {
  classify,
  multiSpawnFields: PI_MULTI_SPAWN_FIELDS,
  checkSummary: CHILDREN_LIST_ACTION,
  continueHow: () =>
    "Continue the existing child instead: " +
    '`{ action: "children.list" }` to find its run id and whether it is resumable, then ' +
    '`{ action: "resume", id: "<run-id>", message: "<the bounce>" }`. ' +
    "If children.list reports it not resumable, launch again and it will be allowed.",
};
