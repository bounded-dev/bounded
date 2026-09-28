// The project-local entry seats coordinate a run without editing product files
// (ADR 2026-048). Each host adapter translates its own tool calls into the
// neutral actions below; this policy judges only those actions, so it names no
// host tool, field or command.

import { LEAD_SEAT, SCOUT_SEAT, isProjectLocalHarness, preparedTicket } from "./lead-state.ts";
import { decide } from "./path-policy.ts";
import { join } from "node:path";
import { resolvedProjectPath, runProjectSetup, SETUP_REFUSED, setupPermitted } from "./setup-state.ts";

export { ACTIVE_TICKET_RELATIVE } from "./ticket-design.ts";
export { isProjectLocalHarness, preparedTicket } from "./lead-state.ts";
export { LEAD_PREPARE_USAGE, parseLeadPrepareArgs, prepareLeadRun } from "./lead-run.ts";

/** Host tool names for the two run-control tools a host may register. */
export const LEAD_PREPARE_TOOL = "lead_prepare";
export const LEAD_SETUP_TOOL = "lead_setup";

/** The project reads the path policy judges, in its own vocabulary. */
export type ProjectReadTool = "read" | "grep" | "find" | "ls";

/** One tool call, as a host adapter describes it to the policy. */
export type SeatAction =
  /** Read, search or list inside the project. */
  | { readonly kind: "read"; readonly tool: ProjectReadTool; readonly input: Readonly<Record<string, unknown>> }
  /** Look something up without touching the project: the web, instructions, the gate catalogue. */
  | { readonly kind: "lookup"; readonly tool: string }
  /** Watch or wait on commissioned seats, or report back to the commissioning seat. */
  | { readonly kind: "observe"; readonly tool: string }
  /** Start one seat on one task. */
  | { readonly kind: "commission"; readonly role: unknown; readonly task: unknown }
  /** Select the ticket and open, resume or change its run. */
  | { readonly kind: "prepare" }
  /** Install the project's pinned dependencies. */
  | { readonly kind: "setup" }
  /** A call whose shape the host adapter already found unacceptable. */
  | { readonly kind: "refused"; readonly reason: string }
  /** Anything else: outside every read-only seat's toolset. */
  | { readonly kind: "other"; readonly tool: string };

export type SeatDecision =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: string };

const ALLOW: SeatDecision = { allow: true };
const refuse = (seat: string, why: string): SeatDecision => ({ allow: false, reason: `${seat}: ${why}` });
const COMMISSIONABLE: ReadonlySet<unknown> = new Set([SCOUT_SEAT, "architect"]);

/**
 * Project reads are held to the architect's read zone, for every read-only
 * seat, judged on the path as written and again on the path its links resolve
 * to: a link out of the project, or into .git, is refused (ADR 2026-048).
 */
function judgeRead(seat: string, action: Extract<SeatAction, { kind: "read" }>, cwd: string): SeatDecision {
  const result = decide("architect", action.tool, action.input, { cwd });
  if (!result.allow) return refuse(seat, result.reason);
  const raw = action.input["path"];
  if (typeof raw !== "string") return ALLOW;
  const real = resolvedProjectPath(cwd, raw);
  if (real === undefined) return refuse(seat, `'${raw}' resolves outside the project or into .git`);
  const resolved = decide("architect", action.tool, { ...action.input, path: join(cwd, real) }, { cwd });
  return resolved.allow ? ALLOW : refuse(seat, resolved.reason);
}

/** The lead may inspect, look things up, prepare a ticket, or commission one bound seat. */
export function decideLead(action: SeatAction, cwd: string): SeatDecision {
  switch (action.kind) {
    case "read":
      return judgeRead(LEAD_SEAT, action, cwd);
    case "lookup":
    case "observe":
    case "prepare":
      return ALLOW;
    case "setup":
      return setupAvailable(cwd) ? ALLOW : { allow: false, reason: SETUP_REFUSED };
    case "refused":
      return refuse(LEAD_SEAT, action.reason);
    case "other":
      return refuse(LEAD_SEAT, `'${action.tool}' is outside the read-only lead toolset`);
    case "commission":
      if (!COMMISSIONABLE.has(action.role)) return refuse(LEAD_SEAT, "only scout and architect may be commissioned by the lead");
      if (typeof action.task !== "string" || action.task.trim() === "") {
        return refuse(LEAD_SEAT, "a scout or architect commission needs a task");
      }
      if (action.role === "architect" && preparedTicket(cwd) === undefined) {
        return refuse(LEAD_SEAT, "prepare the ticket's run boundary before commissioning its architect");
      }
      return ALLOW;
  }
}

/** The scout reads what the lead may read and reports back; nothing else. */
export function decideScout(action: SeatAction, cwd: string): SeatDecision {
  switch (action.kind) {
    case "read":
      return judgeRead(SCOUT_SEAT, action, cwd);
    case "observe":
      return ALLOW;
    case "refused":
      return refuse(SCOUT_SEAT, action.reason);
    case "other":
    case "lookup":
      return refuse(SCOUT_SEAT, `'${action.tool}' is outside the read-only scout toolset`);
    default:
      return refuse(SCOUT_SEAT, `${action.kind} is outside the read-only scout toolset`);
  }
}

/** Whether a seat should see a tool at all, before any call. Setup is shown
 *  only while it could be allowed, which the caller decides with `cwd`. */
export function seatMayHold(seat: "lead" | "scout", action: SeatAction, cwd: string): boolean {
  if (seat === "scout") return action.kind === "read" || action.kind === "observe";
  if (action.kind === "setup") return setupAvailable(cwd);
  return action.kind !== "refused" && action.kind !== "other";
}

/** Install the composed, lockfile-pinned dependency trees (ADR 2026-051).
 *  The shared setup checks permission itself and logs every outcome. */
export async function setupLeadProject(
  cwd: string,
  options: { readonly host?: string; readonly signal?: AbortSignal } = {},
): Promise<{ readonly ok: boolean; readonly summary: string }> {
  if (!isProjectLocalHarness(cwd)) return { ok: false, summary: SETUP_REFUSED };
  return runProjectSetup(cwd, options);
}

/** Setup may run before the first run, or to repair a completed setup whose dependencies are missing. */
export function setupAvailable(cwd: string): boolean {
  return isProjectLocalHarness(cwd) && setupPermitted(cwd);
}
