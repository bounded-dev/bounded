// Path-gate core (TN-26-001 Phase 2): the testable heart of the tool_call
// path gate, with no pi-runtime dependency.
//
// This is thin wiring over the already-tested pure decision core decide()
// (path-policy.ts). Its one job beyond decide() is the trust-boundary side
// effect: a block is recorded in the target project's guard log so a jammed
// pipeline is inspectable ("a deterministic system that is opaque when it
// jams is just a deterministic jam"). Pure cores never log; this layer does.
//
// The extension (hosts/pi/extensions/path-gate.ts) sources the role at runtime and
// calls evaluatePathGate(); everything decision-shaped lives here so it can
// be unit-tested without spawning pi.

import { logGuardEvent, RUN_START_GUARD } from "./guard-log.ts";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolvedProjectPath } from "./setup-state.ts";

/** The tools whose `path` names a project file or directory. */
const GATED_PATH_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls", "write", "edit", "remove"]);
import { decide, FORBIDDEN_TOOLS, type Ctx, type PathFacts, type Role } from "./path-policy.ts";
import { readGuardLog } from "./guard-log.ts";
import { checkSubagentCall, CONTINUATION_CHECKED, type CommissionHost, type PhaseEvidence } from "./phase-gate.ts";
import { readDevStageModels } from "./dev-stage-models.ts";
import {
  contractFileSuffixes,
  hasContractSuffix,
  pathLayoutOrUnreadable,
  sourceRoots,
  specTechNouns,
  writeProtectionOrUnreadable,
} from "./pack-contrib.ts";
import type { KnownModel } from "./model-tier.ts";
import { designNotePath, resolveTicketDesign, ticketWriteScope } from "./ticket-design.ts";
import { createHash } from "node:crypto";
import { hostPathArgument, piReadVariant, type PathHost } from "./host-paths.ts";

/** The only roles the gate is active for. Anything else ⇒ inactive. */
export const PIPELINE_ROLES = ["architect", "test-writer", "builder", "reviewer"] as const;

const ROLE_SET: ReadonlySet<string> = new Set(PIPELINE_ROLES);

/** Narrow an untrusted role value (env, file, config) to a pipeline Role. */
export function asRole(value: unknown): Role | undefined {
  return typeof value === "string" && ROLE_SET.has(value) ? (value as Role) : undefined;
}

// --- Bound-role registry (dogfood Run 6) ------------------------------------
//
// A subagent installs TWO hooks and neither knows about the other: the BOUND
// one its frontmatter names, and the AMBIENT one, because hosts/pi/extensions/*.ts
// auto-load in every pi session — a child included — and the ambient gate
// resolves its role from `.bounded/dev-stage-role` in the project cwd, which the
// child SHARES with its parent.
//
// So a parent gated as `architect` through that file silently applied
// architect's zone on top of every child's. Both hooks run on each tool call
// and either may block, confining the child to the INTERSECTION. Live result:
// the test-writer was refused permission to write its own tests — "architect
// may not write 'tests/start.test.ts'" — and the run deadlocked at its first
// worker.
//
// Restrictions must never leak DOWNWARD. A child's role is decided by its
// parent at spawn from a file outside the project; that binding is the
// authority, and the ambient guess stands down in any process where a bound
// role was installed.
//
// Stored on globalThis, NOT in a module-level `let`.
//
// The host loads the ambient extension by auto-discovery and the per-role
// loader from an explicit `--extension` path. Those arrive through different
// module registries, so a module-scoped flag set by one is invisible to the
// other — which is exactly what happened on the first attempt at this fix: the
// unit tests passed, and a live spawned test-writer was still refused as
// "architect". globalThis is shared by every module instance in the process,
// which is the scope this actually needs.
//
// Deliberately one-way: nothing should ever re-enable the ambient gate in a
// process that has a bound role. Subagents are separate processes, so the flag
// never crosses between them.
const BOUND_ROLE_KEY = Symbol.for("bounded-harness.path-gate.boundRoleInstalled");
// The role ITSELF, not just the fact of a binding. Other worker tools need the
// same answer the gate acts on: `typecheck` scopes its diagnostics by the
// calling role (packs/ts/scripts/typecheck-scope.ts), and a second, private
// notion of "who am I" is exactly how two enforcement layers drift apart.
const BOUND_ROLE_VALUE_KEY = Symbol.for("bounded-harness.path-gate.boundRole");

type GlobalWithRegistry = typeof globalThis & {
  [BOUND_ROLE_KEY]?: boolean;
  [BOUND_ROLE_VALUE_KEY]?: Role;
};

/** Called by a per-role loader; makes the ambient gate inert in this process,
 *  and publishes the bound role for any other tool that must respect it. */
export function markBoundRoleInstalled(role?: Role): void {
  (globalThis as GlobalWithRegistry)[BOUND_ROLE_KEY] = true;
  if (role !== undefined) (globalThis as GlobalWithRegistry)[BOUND_ROLE_VALUE_KEY] = role;
}

/** Whether a bound role has claimed this process. */
export function isAmbientSuppressed(): boolean {
  return (globalThis as GlobalWithRegistry)[BOUND_ROLE_KEY] === true;
}

/** The role a per-role loader bound to this process, if any. */
export function boundRole(): Role | undefined {
  return (globalThis as GlobalWithRegistry)[BOUND_ROLE_VALUE_KEY];
}

/** Test-only: restore the pristine process state. */
export function resetPathGateRegistry(): void {
  delete (globalThis as GlobalWithRegistry)[BOUND_ROLE_KEY];
  delete (globalThis as GlobalWithRegistry)[BOUND_ROLE_VALUE_KEY];
}

/** The ambient fallback role: env var first, then `.bounded/dev-stage-role` in the
 *  project. Both are process/cwd-global — see hosts/pi/extensions/path-gate.ts for why
 *  they are a fallback and not the mechanism. */
export function ambientRole(cwd: string): Role | undefined {
  const fromEnv = asRole(process.env["BOUNDED_DEV_STAGE_ROLE"]);
  if (fromEnv) return fromEnv;
  try {
    return asRole(readFileSync(join(cwd, ".bounded", "dev-stage-role"), "utf8").trim());
  } catch {
    return undefined; // no role file ⇒ no role
  }
}

/**
 * The role this session is acting as, by exactly the rules the path gate
 * applies: the bound role if a per-role loader claimed the process, otherwise
 * the ambient fallback — and nothing at all once a binding exists, because
 * restrictions must never leak downward from a parent to its children.
 *
 * This is the single answer every role-sensitive tool must ask for. Used by
 * the `typecheck` worker tool to scope its diagnostics (hosts/pi/extensions/dev-tools.ts).
 */
export function sessionRole(cwd: string): Role | undefined {
  const bound = boundRole();
  if (bound !== undefined) return bound;
  if (isAmbientSuppressed()) return undefined;
  return ambientRole(cwd);
}

// --- Tool strip (the visible-toolset half of the gate) ----------------------
//
// Refusing a forbidden tool is not the same as not having it. A model that can
// SEE `bash` in its toolset plans around it and reaches for it when stuck, and
// every attempt costs a full turn: a live architect session spent six turns on
// `bash` alone, plus one each on `run_tests` and the rest, all refused.
//
// Subagent-spawned roles never had this problem — their frontmatter `tools:`
// allowlist strips the toolset before the model is ever shown it, which is why
// the refusal text calls the allowlist the primary layer. A DIRECTLY launched
// session (`.bounded/dev-stage-role` + plain `pi`, or `bounded-ticket`) has no
// frontmatter, so the allowlist is documentation there and the gate was doing
// all the work by refusing calls the model had every reason to make.
//
// pi's ExtensionAPI closes this: `getActiveTools()` / `setActiveTools(names)`
// are live once extensions are bound, and `session_start` fires after that
// binding and before the first provider request. Setting the active tools
// rebuilds the system prompt too, so the tool vanishes from the prompt's
// tool list as well as from the provider's schema — the model is never told
// the tool exists.
//
// This is deliberately the SAME data the refusals use (FORBIDDEN_TOOLS), so
// the two layers cannot disagree about what a role may hold.

/** What a session-start strip did: what was hidden, and what is left active. */
export interface ToolStrip {
  readonly hidden: readonly string[];
  readonly active: readonly string[];
}

/**
 * Which of `active` this role may not hold, and what remains.
 *
 * Returns `undefined` when the role already holds nothing forbidden — the
 * caller then makes no call at all, so a normally-launched subagent (already
 * stripped by its frontmatter) is untouched.
 */
export function planToolStrip(role: Role, active: readonly string[]): ToolStrip | undefined {
  const forbidden = FORBIDDEN_TOOLS[role];
  const hidden = active.filter((name) => forbidden.has(name));
  if (hidden.length === 0) return undefined;
  return { hidden, active: active.filter((name) => !forbidden.has(name)) };
}

/**
 * Record a strip in the target project's guard log.
 *
 * The strip is the reason a forbidden tool never appears in the transcript, so
 * without this line the absence is indistinguishable from the model simply not
 * trying — and "a deterministic system that is opaque when it jams is just a
 * deterministic jam" applies to a system that silently DOESN'T jam too.
 */
export function recordToolStrip(cwd: string, role: Role, strip: ToolStrip): void {
  logGuardEvent(cwd, {
    guard: "path-gate",
    verdict: "pass",
    summary: `hid ${strip.hidden.join(", ")} from ${role}`,
    detail: { kind: "tool-strip", role, hidden: [...strip.hidden] },
  });
}

// --- Run start (r15/r16) ----------------------------------------------------
//
// The timing block reported an 80-minute DESIGN phase for a run whose design
// really took about 58: a provider outage sat between the session opening and
// the prompt landing, and the phase measured from the first event in the log,
// which is the session-start tool strip. Wall clock during which nothing was
// asked of the model is not design time.
//
// The gate is the one component that sees the first moment a session does
// work: the first tool call it evaluates. So it stamps a `run-start` event
// there, and phase-durations starts its clock at that marker when it exists.
//
// ONLY THE DRIVING SESSION STAMPS ONE (r16). The reviewer, test-writer and
// builder are each commissioned in their OWN pi child process (pi-subagents),
// and each such child evaluates a first gated tool call too — so before this
// fix every one of them stamped a run-start. r16 logged 14-19 markers per arm,
// and phase-durations picked a late one: kimi's clock started at a reviewer's
// 12:57:35, skewing DESIGN from ~21m to a nonsense 2m45s. The run-start means
// "when did the RUN begin", and the run is the architect's — a worker it later
// spawns did not start the run. So the marker is stamped only from the
// architect's session (`isDrivingRole`).
//
// WHY THE ROLE, NOT "AM I A CHILD". pi-subagents exposes PI_SUBAGENT_CHILD=1 to
// every spawned child, but the architect is itself spawned that way (its parent
// is the orchestrator, the workers' parent is the architect), so that env var
// is 1 for all four pipeline roles and cannot tell the driver from its workers.
// The bound ROLE can, and it is exactly the question the marker means to ask.
//
// ONCE PER SESSION, which is why the latch is a closure handed out by
// `makeRunStartRecorder` and held by the installed hook, exactly as the
// fallback role resolver is: a session is one installPathGate call, so a
// closure is per-session by construction — and unlike module or global state
// it cannot leak between the pi processes a subagent fan-out creates, each of
// which is its own session.
//
// A restart therefore appends a second marker to the same project log; the
// analysis takes the last architect one before the first phase marker (see the
// "The clock" section of phase-durations.ts). Defence in depth lives there
// too: the consumer resolves multiple run-starts to the architect's, so a log
// written before this fix (r16's archived arms) is still read correctly.

/**
 * The DRIVING session of a dev-stage run — the one whose first gated call marks
 * where the run began. That is the architect: it holds the ticket end to end
 * and commissions the other three roles, so its first call necessarily precedes
 * any worker it spawns. The reviewer, test-writer and builder are commissioned
 * BY it and do not start the run, so they stamp no run-start.
 */
export function isDrivingRole(role: Role): boolean {
  return role === "architect";
}

/** Log the run-start marker: this session's first gated tool call. */
export function recordRunStart(cwd: string, role: Role, toolName: string): void {
  logGuardEvent(cwd, {
    guard: RUN_START_GUARD,
    verdict: "pass",
    summary: `first gated tool call (${role}: ${toolName})`,
    detail: { kind: "run-start", role, tool: toolName },
  });
}

/**
 * A once-per-session latch around `recordRunStart`. Call it on every gated
 * tool call; only the first one writes.
 */
export function makeRunStartRecorder(): (cwd: string, role: Role, toolName: string) => void {
  let recorded = false;
  return (cwd, role, toolName) => {
    if (recorded) return;
    recorded = true;
    recordRunStart(cwd, role, toolName);
  };
}

/** Blocking result returned to pi's tool_call hook. */
export interface GateBlock {
  readonly block: true;
  readonly reason: string;
}

export interface GateInput {
  /** Untrusted role source; non-pipeline values leave the gate inactive. */
  readonly role: unknown;
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  /** Target project root — paths resolve against it, guard log lands under it. */
  readonly cwd: string;
  /** Harness config home, so a role may read its own skill instructions. */
  readonly harnessRoot?: string;
  /** The host whose tools will run the call, which decides how a path
   *  argument is rewritten before use (src/host-paths.ts). Default pi. */
  readonly host?: PathHost;
  /** How the host's commission tool is read and a finished worker continued
   *  (src/phase-gate.ts). Required for a `subagent` call; absent ⇒ refused. */
  readonly commissions?: CommissionHost;
  /** Which seat instance is calling, as the host identifies it. Recorded on a
   *  spawn so an adapter can tell a later caller from the one that launched. */
  readonly caller?: string;
  /**
   * Snapshot of the session's available models, for the spawn-time tier check.
   * Absent or empty means "cannot tell": a seat is never refused for want of a
   * registry, only for a tier the registry positively does not know.
   */
  readonly known?: readonly KnownModel[];
}

/**
 * Decide whether a tool call is allowed for the given role, logging a
 * `path-gate` block to <cwd>/.bounded/guard-log.jsonl on denial.
 *
 * Returns `undefined` (allow / inactive) or `{ block, reason }` (deny).
 */
export function evaluatePathGate(ev: GateInput): GateBlock | undefined {
  // Fail closed with a readable reason. A throw escaping here reaches the
  // host's tool_call handler as a generic "hook errored", which tells the
  // agent nothing about what to repair.
  try {
    return evaluateGate(ev);
  } catch (error) {
    const reason = `path-gate: cannot evaluate this call — ${error instanceof Error ? error.message : String(error)}`;
    try {
      logGuardEvent(ev.cwd, { guard: "path-gate", verdict: "block", summary: reason });
    } catch {
      // The refusal stands even when the log cannot be written.
    }
    return { block: true, reason };
  }
}

function evaluateGate(ev: GateInput): GateBlock | undefined {
  const role = asRole(ev.role);
  if (!role) return undefined; // no pipeline role ⇒ gate inactive

  // Commissioning a worker is a phase TRANSITION, and transitions are checked
  // the same way artifacts are. The check runs for any BOUND role, not just the
  // architect: "this session already holds a role" is exactly the condition
  // that makes an unbound `delegate` wrong, and a role that should not hold
  // `subagent` at all is refused a few lines below by the tool policy anyway.
  //
  // Thin by construction — the whole decision is checkSubagentCall(); this
  // layer only performs the side effect the pure core may not, which is writing
  // what happened to the target project's guard log.
  if (ev.toolName === "subagent") {
    let evidence: PhaseEvidence;
    let designProblem: string | undefined;
    try {
      ({ evidence, designProblem } = gatherEvidence(ev.cwd, ev.known));
    } catch (error) {
      const reason = `phase-gate: ${error instanceof Error ? error.message : String(error)}`;
      logGuardEvent(ev.cwd, { guard: "phase-gate", verdict: "block", summary: reason });
      return { block: true, reason };
    }
    // How a commission call is read, and how a finished worker is continued,
    // is the host's (ADR 2026-034). A call that reaches here with no host to
    // read it is refused rather than guessed at.
    if (ev.commissions === undefined) {
      const reason = "phase-gate: this host supplied no commission policy, so the commission is refused rather than judged by guesswork";
      logGuardEvent(ev.cwd, { guard: "phase-gate", verdict: "block", summary: reason });
      return { block: true, reason };
    }
    let verdict = checkSubagentCall(ev.input, evidence, ev.commissions);
    // A broken ticket design refuses only the spawns that need the design;
    // a scout or the PM stays available to help repair it.
    if (designProblem !== undefined && verdict.kind === "block" && verdict.form === undefined) {
      verdict = { ...verdict, reason: `phase-gate: cannot commission the ${verdict.target ?? "worker"} — ${designProblem}` };
    }
    switch (verdict.kind) {
      case "continuation-checked":
        // Consulting the host's record of finished workers is what licenses a
        // later cold launch, so it has to be recorded — the gate's own evidence
        // is the architect's tool calls.
        logGuardEvent(ev.cwd, {
          guard: "phase-gate",
          verdict: "pass",
          summary: ev.commissions.checkSummary,
          detail: { kind: CONTINUATION_CHECKED },
        });
        return undefined;
      case "block":
        logGuardEvent(ev.cwd, {
          guard: "phase-gate",
          verdict: "block",
          summary: verdict.reason,
          detail: {
            kind: "spawn-refused",
            role,
            ...(verdict.target !== undefined ? { target: verdict.target } : {}),
            ...(verdict.form !== undefined
              ? { form: verdict.form.field, roles: [...verdict.form.roles] }
              : {}),
          },
        });
        return { block: true, reason: verdict.reason };
      case "allow":
        // Record the ALLOWED spawn: a second cold launch of this role is refused
        // until the host shows the worker cannot be continued.
        logGuardEvent(ev.cwd, {
          guard: "phase-gate",
          verdict: "pass",
          summary: `commissioned ${verdict.target}`,
          detail: { kind: "spawn", target: verdict.target, ...(ev.caller !== undefined ? { caller: ev.caller } : {}) },
        });
        break;
      case "resumed":
        // A resumed seat is a commissioned seat. r15 made twelve of these and
        // left nothing in the log, so the run's own story could not say which
        // roles were working. Recorded as a pass with whatever the call named:
        // the role when it names one, the run id always.
        logGuardEvent(ev.cwd, {
          guard: "phase-gate",
          verdict: "pass",
          summary: `resumed ${verdict.target} (${verdict.run})`,
          detail: { kind: "resume", target: verdict.target, run: verdict.run },
        });
        break;
      case "allow-multi":
        // Legitimate background fan-out. It is allowed and it is RECORDED: an
        // unexplained cluster of children in a pipeline run should be traceable
        // to the call that started them.
        logGuardEvent(ev.cwd, {
          guard: "phase-gate",
          verdict: "pass",
          summary: `${verdict.form.field} fan-out (no pipeline role)`,
          detail: { kind: "fan-out", role, form: verdict.form.field },
        });
        break;
      case "ignore":
        break;
    }
  }

  const ctx = pathGateCtx(role, ev.cwd, ev.harnessRoot);
  const hosted = hostedInput(role, ev);
  const decision = !("input" in hosted)
    ? { allow: false as const, reason: hosted.reason }
    : resolvedDecision(decide(role, ev.toolName, hosted.input, ctx), role, { ...ev, input: hosted.input }, ctx);
  if (decision.allow) return undefined;

  const rawPath = ev.input["path"];
  logGuardEvent(ev.cwd, {
    guard: "path-gate",
    verdict: "block",
    summary: decision.reason,
    detail: { role, tool: ev.toolName, path: rawPath ?? null },
  });
  return { block: true, reason: decision.reason };
}

/**
 * The call's input with its path rewritten exactly as the host will rewrite
 * it before opening anything (src/host-paths.ts), or the reason it cannot be.
 * On pi a read of a path that does not exist may open another spelling of
 * it; that substitution is refused, since the gate never judged it.
 */
function hostedInput(role: Role, ev: GateInput):
  { readonly input: Readonly<Record<string, unknown>> } | { readonly reason: string } {
  const raw = ev.input["path"];
  if (!GATED_PATH_TOOLS.has(ev.toolName) || typeof raw !== "string" || raw === "") return { input: ev.input };
  const host = ev.host ?? "pi";
  const hosted = hostPathArgument(host, raw);
  if (!hosted.ok) return { reason: `path-gate: ${role} may not use '${raw}': ${hosted.reason}` };
  if (host === "pi" && ev.toolName === "read") {
    const variant = piReadVariant(resolve(ev.cwd, hosted.path));
    if (variant !== undefined) {
      return { reason: `path-gate: ${role} may not read '${raw}': it does not exist, and pi would open '${variant}' instead — pass that file's exact path` };
    }
  }
  return { input: hosted.path === raw ? ev.input : { ...ev.input, path: hosted.path } };
}

/**
 * The Ctx the path gate judges a role's call with: the project's layout
 * (source roots, contract globs, test suffixes, generated globs — ADRs
 * 2026-056…058), its protected names and, for content search, what the
 * filesystem says. Each socket is read independently and an unreadable one
 * is passed as `"unreadable"`, which decide() treats fail-closed. Exported so
 * every host builds the same context (the Claude Code bash policy included).
 */
export function pathGateCtx(role: Role, cwd: string, harnessRoot?: string): Ctx {
  return {
    cwd,
    ...(harnessRoot !== undefined ? { harnessRoot } : {}),
    ...(role === "architect" ? { ticketScope: ticketWriteScope(cwd) } : {}),
    ...pathLayoutOrUnreadable(cwd),
    writeProtection: writeProtectionOrUnreadable(cwd),
    pathFacts: projectPathFacts(cwd),
  };
}

/**
 * decide() judges the path as written, and is pure. A link inside the project
 * can point anywhere, so an allowed project path is judged again on what its
 * links resolve to: an escape from the project, or into .git, is refused, and
 * a link into another zone is held to that zone's rule. A read of the
 * harness's own skills outside the project is left to decide(), which already
 * resolved it against the harness root.
 */
function resolvedDecision(
  decision: ReturnType<typeof decide>,
  role: Role,
  ev: GateInput,
  ctx: Parameters<typeof decide>[3],
): ReturnType<typeof decide> {
  const raw = ev.input["path"];
  if (!decision.allow || typeof raw !== "string" || !GATED_PATH_TOOLS.has(ev.toolName)) return decision;
  const lexical = relative(ev.cwd, resolve(ev.cwd, raw));
  if (lexical === ".." || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) return decision;
  const real = resolvedProjectPath(ev.cwd, raw);
  if (real === undefined) {
    return { allow: false, reason: `path-gate: ${role} may not use '${raw}': it resolves outside the project or into .git` };
  }
  if (real === (lexical === "" ? "." : lexical)) return decision;
  return decide(role, ev.toolName, { ...ev.input, path: join(ev.cwd, real) }, ctx);
}

/**
 * The AMBIENT gate's decision: identical to `evaluatePathGate`, except that it
 * stands down entirely once a bound role has claimed this process.
 *
 * The ambient hook exists so a session the user starts themselves can be gated
 * from a `.bounded/dev-stage-role` file. That file lives in the project, which every
 * subagent shares — so without this check the parent's role is applied to each
 * child on top of its own, and the child is confined to the intersection.
 */
export function evaluateAmbientPathGate(ev: GateInput): GateBlock | undefined {
  if (isAmbientSuppressed()) return undefined;
  return evaluatePathGate(ev);
}

/**
 * Read the project's current state: what exists, what actually ran, and what
 * each seat is configured to run on.
 *
 * The tier config is read here rather than in the pure core for the same
 * reason the guard log is: the core decides, this layer touches the disk.
 * `readDevStageModels` never throws — absent, unreadable and malformed all
 * come back as "no override" — so a broken config still cannot cost a run.
 */
function gatherEvidence(
  cwd: string,
  known?: readonly KnownModel[],
): { evidence: PhaseEvidence; designProblem?: string } {
  // Only this ticket's own design matters here: its ownership was checked
  // when it was frozen, and the freeze comparison below catches any change.
  // A stale note for ANOTHER ticket must not block this run's spawns.
  const state = resolveTicketDesign(cwd, { siblings: "ignore" });
  const ticket = state.kind === "ready" ? state.design : undefined;
  let specText = "";
  if (state.kind === "legacy" || state.kind === "ready") {
    try {
      specText = readFileSync(join(cwd, designNotePath(cwd)), "utf8");
    } catch {
      specText = ""; // absent
    }
  }
  let events: PhaseEvidence["events"] = [];
  try {
    events = readGuardLog(cwd);
  } catch {
    events = []; // an unreadable log must not silently permit a skip
  }
  const designHashes: Record<string, string> = {};
  if (ticket) {
    for (const path of [ticket.note, ...ticket.contracts]) {
      const body = readFileSync(join(cwd, path), "utf8").replace(/\r\n/g, "\n");
      designHashes[path] = createHash("sha256").update(body, "utf8").digest("hex");
    }
  }
  const suffixes = contractFileSuffixes(cwd);
  const roots = state.kind === "legacy" ? sourceRoots(cwd) : [];
  const selected = state.kind === "legacy" ? undefined :
    state.kind === "ready" ? state.design.ticket : state.ticket;
  const evidence: PhaseEvidence = {
    // An unwritten or refused design owns nothing yet, so every worker that
    // needs one is refused while a scout may still be commissioned.
    contracts: state.kind === "legacy" ? findContracts(cwd, roots, suffixes) : ticket?.contracts ?? [],
    contractSuffixes: suffixes,
    specText,
    events,
    ...(selected !== undefined ? { ticket: selected } : {}),
    designHashes,
    models: readDevStageModels(cwd),
    techNouns: specTechNouns(cwd),
    ...(known !== undefined ? { known } : {}),
  };
  return state.kind === "refused" ? { evidence, designProblem: state.reason } : { evidence };
}

/**
 * The concrete directories a set of source-root globs names on disk (ADR
 * 2026-056): each `*` segment expands to the real, non-hidden directories at
 * that level, and links are not followed. Project-relative, sorted.
 */
export function expandSourceRoots(project: string, roots: readonly string[]): string[] {
  const out = new Set<string>();
  const expand = (prefix: string, rest: readonly string[]): void => {
    if (rest.length === 0) {
      if (prefix !== "") out.add(prefix);
      return;
    }
    const [head, ...tail] = rest as [string, ...string[]];
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(join(project, prefix), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      if (head === "*" || head.toLowerCase() === entry.name.toLowerCase()) {
        expand(prefix === "" ? entry.name : `${prefix}/${entry.name}`, tail);
      }
    }
  };
  for (const root of roots) expand("", root.split("/"));
  return [...out].sort();
}

/** Project-relative contract paths (by the composed packs' suffixes), found
 *  under the composed source roots only (ADR 2026-056) — every contract glob
 *  is `<root>/**\/*<suffix>`. Hidden directories and links are skipped, so
 *  nothing outside a root is walked and the core names no stack's
 *  directories. No root, no contract. */
function findContracts(project: string, roots: readonly string[], suffixes: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 16) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!e.name.startsWith(".")) walk(join(dir, e.name), depth + 1);
      } else if (e.isFile() && hasContractSuffix(e.name, suffixes)) {
        out.push(relative(project, join(dir, e.name)).split(sep).join("/"));
      }
    }
  };
  for (const root of expandSourceRoots(project, roots)) walk(join(project, root), 0);
  return out.sort();
}

/** The most entries `tree` lists before it gives up. */
const TREE_ENTRY_LIMIT = 50_000;

/**
 * The filesystem facts the pure policy asks for on a content search
 * (Ctx.pathFacts): what a path is, following links, and what lies below a
 * directory — every non-directory name and every link, links not followed and
 * `.git` skipped — or undefined when the listing is incomplete (unreadable,
 * or larger than TREE_ENTRY_LIMIT). A path that resolves outside the project
 * is reported absent, never inspected.
 */
export function projectPathFacts(project: string): PathFacts {
  const inside = (rel: string): string | undefined => {
    const abs = resolve(project, rel);
    const back = relative(project, abs);
    return back === ".." || back.startsWith(`..${sep}`) || isAbsolute(back) ? undefined : abs;
  };
  return {
    kind(rel) {
      const abs = inside(rel);
      if (abs === undefined) return "absent";
      try {
        const stat = statSync(abs);
        return stat.isDirectory() ? "directory" : "file";
      } catch {
        return "absent";
      }
    },
    tree(rel) {
      const lexical = inside(rel);
      if (lexical === undefined) return undefined;
      // Walk the filesystem's own spelling of the directory, so a case- or
      // Unicode-folded argument is listed as what it really is.
      let abs: string;
      let root: string;
      try {
        abs = realpathSync.native(lexical);
        root = realpathSync.native(project);
      } catch {
        return undefined;
      }
      const back = relative(root, abs);
      if (back === ".." || back.startsWith(`..${sep}`) || isAbsolute(back)) return undefined;
      const fileNames: string[] = [];
      const links: string[] = [];
      const oddNames: string[] = [];
      const stack = [abs];
      let seen = 0;
      while (stack.length > 0) {
        const dir = stack.pop()!;
        let entries: import("node:fs").Dirent[];
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          return undefined;
        }
        for (const entry of entries) {
          if (++seen > TREE_ENTRY_LIMIT) return undefined;
          const shown = relative(root, join(dir, entry.name)).split(sep).join("/");
          if (/[^\x00-\x7F]/.test(entry.name)) oddNames.push(shown);
          if (entry.isSymbolicLink()) {
            links.push(shown);
          } else if (entry.isDirectory()) {
            if (entry.name.toLowerCase() !== ".git") stack.push(join(dir, entry.name));
          } else {
            fileNames.push(entry.name);
          }
        }
      }
      return { fileNames, links: links.sort(), oddNames: oddNames.sort() };
    },
  };
}
