/**
 * Path-gate extension (TN-26-001 Phase 2)
 *
 * A `tool_call` hook that enforces the developer-stage blindness matrix for a
 * pipeline role: architect / test-writer / builder / reviewer. For those roles it runs
 * the pure decision core (src/path-policy.ts via src/path-gate.ts), blocks
 * out-of-zone reads/edits/writes/searches, and records each block in the
 * target project's guard log. In a project-local installation, a normal root
 * session is the read-only team lead, and a child session with no bound role
 * (the scout, or anything else unbound) is held to the scout's read-only
 * policy. In the global harness a normal session remains ungated by this
 * extension. The seat is decided by the shared resolveSessionRole
 * (src/session-role.ts), which the Claude Code hook uses too.
 *
 * It also installs a `session_start` hook that REMOVES the role's forbidden
 * tools from the model's visible toolset (pi.setActiveTools), so a directly
 * launched session gets the same "the tool was never there" property a
 * subagent gets free from its frontmatter allowlist. The tool_call refusals
 * become the backstop they were always described as.
 *
 * ── Role source (the key design decision) ────────────────────────────────
 * Subagents run as SEPARATE `pi` child processes (pi-subagents spawns them),
 * so they do not share a process with the orchestrator — but every child
 * inherits the parent's `process.env`, so a parent-set env var is NOT
 * per-agent: it would tag every child, of every role, identically. There is
 * also no per-agent env injected by pi-subagents (no `PI_SUBAGENT_AGENT_NAME`
 * or equivalent), and no `env:` frontmatter field.
 *
 * The mechanism pi ACTUALLY supports per-subagent is `subagentOnlyExtensions`
 * in the agent's frontmatter: extension paths loaded ONLY in that agent's
 * spawned child session (pi-subagents passes them as `--extension` args). So
 * each pipeline agent binds its role by loading a distinct per-role loader
 * from ./path-gate/ (architect.ts / test-writer.ts / builder.ts), each of
 * which calls installPathGate(pi, "<role>"). The role is baked into WHICH
 * extension the agent loads — deterministic, per-subagent, and impossible for
 * a normal session to trip (it never loads those files).
 *
 * Example agent frontmatter (agents/architect.md):
 *   subagentOnlyExtensions: <harness>/hosts/pi/extensions/path-gate/architect.ts
 *
 * ── Fallback (documented limitation) ─────────────────────────────────────
 * This file also auto-loads ambiently (hosts/pi/extensions/*.ts). Its default export
 * binds NO role, so it is inert unless a role is found via the fallbacks:
 *   1. BOUNDED_DEV_STAGE_ROLE env var, then
 *   2. a `.bounded/dev-stage-role` file in the project cwd.
 * Both are PROCESS/CWD-global: they cannot distinguish two roles operating in
 * the same project at once, and env leaks to nested children. They exist only
 * so the gate can be exercised without a full subagent launch; the
 * subagentOnlyExtensions loaders are the real mechanism. Prefer them.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ambientRole,
  evaluateAmbientPathGate,
  evaluatePathGate,
  isAmbientSuppressed,
  isDrivingRole,
  makeRunStartRecorder,
  markBoundRoleInstalled,
  planToolStrip,
  recordToolStrip,
} from "../../../src/path-gate.ts";
import { CONSTRAINTS, declareHost, recordHostDeclaration } from "../../../src/host.ts";
import type { Role } from "../../../src/path-policy.ts";
import { knownModels } from "./model-tier.ts";
import {
  decideLead,
  decideScout,
  isProjectLocalHarness,
  LEAD_PREPARE_TOOL,
  LEAD_PREPARE_USAGE,
  LEAD_SETUP_TOOL,
  parseLeadPrepareArgs,
  prepareLeadRun,
  seatMayHold,
  setupLeadProject,
} from "../../../src/lead-policy.ts";
import { logGuardEvent } from "../../../src/guard-log.ts";
import { LEAD_GUARD, SCOUT_SEAT } from "../../../src/lead-state.ts";
import { resolveSessionRole, type SessionSeat } from "../../../src/session-role.ts";
import { piSeatAction } from "./lib/lead-actions.ts";

// This file lives at <harness>/hosts/pi/extensions/path-gate.ts, so the harness
// root (the `agent/` dir) is FOUR levels up: extensions → pi → hosts → agent.
// Derived rather than configured, and deliberately NOT realpath-resolved: pi
// loads this extension through the ~/.pi/agent symlink, so import.meta.url stays
// in that form and the root comes out as `~/.pi/agent` — the same form the
// architect's skill reads use, so `isHarnessSkillRead` matches (a role may read
// its own SKILL.md). A wrong depth here silently refuses every skill read; the
// value is exported and pinned by hosts/pi/discovery.test.ts.
export const HARNESS_ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const PROJECT_COPY = basename(HARNESS_ROOT) === "harness" && basename(dirname(HARNESS_ROOT)) === ".bounded";

/** pi holds all four: the strip, the path gate, the phase gate and the
 *  role-scoped worker views are all in-process hooks here. */
const BOUNDED_HOST = declareHost("pi", CONSTRAINTS);

/** Resolve an ambient fallback role once per session (env, then role file).
 *  The resolution itself is `ambientRole` in ../src/path-gate.ts — shared with
 *  the other role-sensitive tools so they cannot disagree about who is acting. */
function makeFallbackResolver(): (cwd: string) => Role | undefined {
  let resolved = false;
  let role: Role | undefined;
  return (cwd: string): Role | undefined => {
    if (resolved) return role;
    resolved = true;
    role = ambientRole(cwd);
    return role;
  };
}

/**
 * Install the path gate. Pass `boundRole` from a per-role subagentOnly loader
 * for the deterministic per-subagent path; omit it for the ambient default,
 * which falls back to env / role file (and stays inactive when neither is set).
 */
export interface PathGateOptions {
  /** Whether this is a project-local installation's own copy. Derived from
   *  this file's location; a test may say so explicitly. */
  readonly projectCopy?: boolean;
}

export function installPathGate(pi: ExtensionAPI, boundRole?: Role, options: PathGateOptions = {}): void {
  const projectCopy = options.projectCopy ?? PROJECT_COPY;
  // A bound role claims the process, which makes the ambient hook inert — see
  // the registry in src/path-gate.ts. Without this, a subagent gets its
  // parent's role (read from the shared `.bounded/dev-stage-role`) applied on top of
  // its own and is confined to the intersection of the two zones. That
  // deadlocked dogfood Run 6 at its first worker: the test-writer was refused
  // permission to write its own tests as "architect".
  if (boundRole) markBoundRoleInstalled(boundRole);

  const fallback = boundRole ? undefined : makeFallbackResolver();

  // The copied harness makes a plain project-local pi session the team lead.
  // pi-subagents marks child processes; a pipeline child also carries a
  // per-role loader, which claims the process (isAmbientSuppressed). A child
  // with neither is held read-only rather than left ungated.
  const seatFor = (cwd: string): SessionSeat => resolveSessionRole({
    ...(boundRole !== undefined ? { boundSeat: boundRole } : {}),
    projectLocal: projectCopy && isProjectLocalHarness(cwd),
    child: process.env["PI_SUBAGENT_CHILD"] === "1",
    judgedElsewhere: boundRole === undefined && isAmbientSuppressed(),
    // A global harness never applies the legacy role file inside a project installation.
    ambientRole: () => (isProjectLocalHarness(cwd) ? undefined : fallback!(cwd)),
  });
  const leadSession = (cwd: string): boolean => seatFor(cwd).kind === "lead";

  if (projectCopy) pi.registerTool({
    name: LEAD_PREPARE_TOOL,
    label: "Prepare ticket run",
    description: `Open or resume the active ticket's run (the shell form is \`${LEAD_PREPARE_USAGE}\`). Pass new: true after final delivery to start another ticket; include ticket for a tracked issue or omit it for the next local number.`,
    parameters: Type.Object({
      ticket: Type.Optional(Type.String({ description: "Positive issue number, if tracked externally" })),
      new: Type.Optional(Type.Boolean({ description: "Start the next local work item after final delivery" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!leadSession(ctx.cwd)) {
        return { content: [{ type: "text" as const, text: "team-lead: only the project-local lead may prepare a ticket run" }], details: { ok: false } };
      }
      const args = parseLeadPrepareArgs([...(params.new === true ? ["--new"] : []), ...(params.ticket !== undefined ? [params.ticket] : [])]);
      if (!args.ok) {
        return { content: [{ type: "text" as const, text: `team-lead: ${args.reason}` }], details: { ok: false } };
      }
      const result = prepareLeadRun(ctx.cwd, args.ticket, args.fresh);
      return {
        content: [{ type: "text" as const, text: result.ok ? result.summary : result.reason }],
        details: result,
      };
    },
  });

  if (projectCopy) pi.registerTool({
    name: LEAD_SETUP_TOOL,
    label: "Install project dependencies",
    description: "Install exactly the project's and local harness's lockfile-pinned dependencies: before the first ticket run, or to repair a completed setup whose dependency trees are missing. Project package lifecycle scripts never run.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _onUpdate, ctx) {
      if (!leadSession(ctx.cwd)) {
        return { content: [{ type: "text" as const, text: "team-lead: only the project-local lead may set up dependencies" }], details: { ok: false } };
      }
      const result = await setupLeadProject(ctx.cwd, { host: "pi", signal });
      return { content: [{ type: "text" as const, text: result.summary }], details: result };
    },
  });

  // Per-SESSION state, in the same shape as the fallback resolver above: one
  // installPathGate call is one session, so a closure is the scope this needs.
  const noteRunStart = makeRunStartRecorder();

  // Take the forbidden tools AWAY, rather than refusing them one turn at a
  // time. See the tool-strip block in ../src/path-gate.ts for why: a refused
  // tool the model can still see costs a turn per attempt, and a directly
  // launched session has no frontmatter allowlist to strip it first.
  //
  // `session_start` is the earliest point the tool actions are live — they
  // throw during extension LOAD ("Action methods cannot be called during
  // extension loading") — and it still fires before the first provider
  // request, so the model never sees the tool at all.
  pi.on("session_start", (_event, ctx) => {
    const seat = seatFor(ctx.cwd);
    if (seat.kind === "none") {
      // Do not advertise a project-only control in unrelated pi sessions.
      if (projectCopy) {
        const active = pi.getActiveTools();
        if (active.includes(LEAD_PREPARE_TOOL) || active.includes(LEAD_SETUP_TOOL)) {
          pi.setActiveTools(active.filter((name) => name !== LEAD_PREPARE_TOOL && name !== LEAD_SETUP_TOOL));
        }
      }
      return;
    }
    if (seat.kind === "lead" || seat.kind === "scout") {
      const holder = seat.kind;
      const active = pi.getActiveTools();
      const kept = active.filter((name) => seatMayHold(holder, piSeatAction(name, {}), ctx.cwd));
      if (kept.length !== active.length) pi.setActiveTools(kept);
      recordHostDeclaration(ctx.cwd, BOUNDED_HOST);
      return;
    }
    const role = seat.role;
    // The ambient hook stands down wherever a bound role claimed the process,
    // for exactly the reason it stands down on tool calls: otherwise a
    // subagent's toolset loses its PARENT's forbidden tools too, and a
    // test-writer would be stripped of nothing while a builder lost run_tests.
    if (!boundRole && isAmbientSuppressed()) return;

    // Say which host this is and what it holds, before the first tool call:
    // a `bounded gates` transcript from a bare shell otherwise reads exactly like
    // a blind run (ADR 2026-034). pi enforces every constraint the stage has.
    recordHostDeclaration(ctx.cwd, BOUNDED_HOST);

    // Defence in depth over a gate that already refuses these calls: if the
    // host cannot strip, the session must still start and still be gated.
    try {
      const active = pi.getActiveTools();
      const strip = planToolStrip(role, active);
      const kept = (strip?.active ?? active).filter((name) => name !== LEAD_PREPARE_TOOL && name !== LEAD_SETUP_TOOL);
      if (kept.length !== active.length) pi.setActiveTools([...kept]);
      if (strip) recordToolStrip(ctx.cwd, role, strip);
    } catch {
      // The tool_call gate below is unaffected and still refuses every one.
    }
  });

  // A hook that errors fails CLOSED: an unjudged call is refused, and the
  // refusal is recorded so a run that hit it is visibly so.
  pi.on("tool_call", async (event, ctx) => {
    try {
      return judgeCall(event, ctx);
    } catch (error) {
      const reason = `path-gate: the hook errored (${error instanceof Error ? error.message : String(error)}), so this ${event.toolName} call is refused rather than let through ungated`;
      logGuardEvent(ctx.cwd, { guard: "path-gate", verdict: "error", summary: reason, detail: { host: "pi", kind: "hook-error", tool: event.toolName } });
      return { block: true, reason };
    }
  });

  function judgeCall(
    event: { readonly toolName: string; readonly input: unknown },
    ctx: Parameters<typeof knownModels>[0] & { readonly cwd: string },
  ): { block: true; reason: string } | undefined {
    const seat = seatFor(ctx.cwd);
    if (seat.kind === "none") return undefined;
    if (seat.kind === "lead" || seat.kind === "scout") {
      const action = piSeatAction(event.toolName, event.input as Readonly<Record<string, unknown>>);
      const decision = seat.kind === "lead" ? decideLead(action, ctx.cwd) : decideScout(action, ctx.cwd);
      if (decision.allow) return undefined;
      logGuardEvent(ctx.cwd, {
        guard: seat.kind === "lead" ? LEAD_GUARD : "path-gate",
        verdict: "block",
        summary: decision.reason,
        detail: { tool: event.toolName, ...(seat.kind === "scout" ? { role: SCOUT_SEAT } : {}) },
      });
      return { block: true, reason: decision.reason };
    }
    const role = seat.role;
    if (event.toolName === LEAD_PREPARE_TOOL || event.toolName === LEAD_SETUP_TOOL) {
      return { block: true, reason: "team-lead: the architect and workers cannot redraw the run boundary" };
    }

    // The first gated call is where the run demonstrably starts, so it is
    // marked before it is judged — a refused first call still started the run.
    // Recorded only by the hook that will actually evaluate the call: the
    // ambient hook stands down where a bound role claimed the process (see
    // evaluateAmbientPathGate), and a second marker from a stood-down hook
    // would be a second run-start for one session.
    //
    // And only from the DRIVING session (the architect). The reviewer,
    // test-writer and builder each run in their own pi child and evaluate a
    // first gated call too; before r16 every one stamped a marker and the clock
    // picked a late one, starting DESIGN inside the design phase. A worker the
    // architect spawns did not start the run, so it marks nothing.
    const evaluating = boundRole !== undefined || !isAmbientSuppressed();
    if (evaluating && isDrivingRole(role)) {
      noteRunStart(ctx.cwd, role, event.toolName);
    }

    // Re-declare the host on every gated call, not only at session start: a
    // bare `bounded gates` from another terminal writes `host none` mid-session,
    // and every pi event after it would otherwise sit under a line that says
    // nothing was enforced. The declaration dedupes against the log's latest
    // host line, so this is one small read per call and a write on change.
    if (evaluating) recordHostDeclaration(ctx.cwd, BOUNDED_HOST);

    const input = event.input as Readonly<Record<string, unknown>>;
    const ev = {
      role,
      toolName: event.toolName,
      input,
      cwd: ctx.cwd,
      harnessRoot: HARNESS_ROOT,
      // Only a `subagent` call consults it, and the gate treats an empty
      // snapshot as "cannot tell", so reading it on every call is safe as well
      // as simpler than deciding here which calls will want it.
      known: knownModels(ctx),
    };

    // Suppression is checked per CALL, not at install: extensions load in an
    // arbitrary order, and the ambient one may well arrive first.
    return boundRole ? evaluatePathGate(ev) : evaluateAmbientPathGate(ev);
  }
}

export default function (pi: ExtensionAPI): void {
  installPathGate(pi);
}
