// Claude Code PreToolUse hook: the path gate and the phase gate for one role
// (ADR 2026-034, Tier B on the second host).
//
//   node path-gate-hook.ts [--project-local] [--role <seat>] [--harness-root <dir>]  < payload.json
//
// Claude Code runs this once per tool call, feeding the call as JSON on stdin,
// and reads a decision back: nothing on stdout means "allow", a JSON object
// with `permissionDecision: "deny"` means "refuse, and tell the model why",
// and an allowed `bounded gates …` comes back as `permissionDecision: "allow"` with
// `updatedInput` rewriting the command to `BOUNDED_HOST=claude-code
// BOUNDED_DEV_STAGE_ROLE=<role> BOUNDED_COMMAND_TIMEOUT_MS=<ms> …` — the one
// place the bound role, the host and the call's deadline cross into the
// gate's own process, where `sessionRole()` reads the role before any role
// file, the CLI records which host ran it, and a gate that splits its work
// across calls (mutation-score) keeps each call inside the deadline.
// It is the analogue of pi's `tool_call` hook (hosts/pi/extensions/path-gate.ts), and
// like that hook it is thin wiring: the whole decision is the shared cores —
// decide() through evaluatePathGate(), checkSubagentCall() for a spawn, and
// this host's bash policy for the one tool pi forbids and Claude Code needs.
//
// ── Role source ─────────────────────────────────────────────────────────────
// Bound, from `--role`, when the hook is installed by a generated subagent
// definition (`.claude/agents/<role>.md` carries it in its own `hooks:`, which
// fire only inside that subagent — the exact counterpart of pi's
// `subagentOnlyExtensions`). The role is decided by WHICH definition loaded,
// from outside the project, and nothing the model does can change it.
//
// `--role scout` binds the read-only scout (lead-hook.ts). Project-local, with
// no --role, the main session is the read-only team lead; the role file
// cannot silently promote it. In a ticket worktree (ADR 2026-066) the
// top-level session is the architect only when `bounded lead start` launched
// it with the seat in its environment (launchedSeat below); any other
// top-level session there is read-only. Outside an initialized project,
// `.bounded/dev-stage-role` remains the legacy ambient fallback; no role
// there means the gate is inactive. The seat itself is decided by the shared
// resolveSessionRole (src/session-role.ts), which pi uses too.
//
// Frontmatter and settings hooks both fire in an ordinary subagent. A
// project-local settings hook stands down only for a child (`agent_id`, the
// documented child identifier) whose `agent_type` names a generated
// definition that carries its own hook bound to that seat. Every other child
// — a forked skill, a built-in agent — is held to the scout's read-only
// policy: project-local hooks fail closed for unbound work (ADR 2026-048).
// `agent_type` alone is not enough: a directly launched top-level `--agent`
// session may carry it.
//
// ── Failure mode: OPEN only for local reads, CLOSED for everything else ─────
// A hook that crashes must not brick the session, but a gate that fails open
// on anything it never judged is no gate. Any error — malformed stdin, an
// unreadable project, a bug here — writes one line to stderr and records an
// `error` event in the guard log, so a run that went ungated is at least
// visibly so. Then only the local read tools (Read, Grep, Glob, LS) are
// allowed; every other call, including MCP tools, skills, an unknown tool,
// or a payload too broken to name one, is DENIED with a reason that says the
// hook errored. (pi's hook refuses every call on error.) Logging itself
// never throws.
//
// ── Run start ───────────────────────────────────────────────────────────────
// pi stamps `run-start` from the driving session's first tool call, once per
// session, with a closure. This hook is a fresh process per call, so the
// once-latch is the log itself: stamp when the role is driving and the log
// holds no run-start yet. Same marker, same consumer (phase-durations.ts).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { logGuardEvent, readGuardLog, RUN_START_GUARD } from "../../src/guard-log.ts";
import { isMainModule } from "../../src/is-main-module.ts";
import {
  asRole,
  evaluatePathGate,
  isDrivingRole,
  pathGateCtx,
  PIPELINE_ROLES,
  recordRunStart,
  sessionRole,
} from "../../src/path-gate.ts";
import { COMMAND_TIMEOUT_ENV, CONSTRAINTS, declareHost, HOST_ENV, recordHostDeclaration } from "../../src/host.ts";
import { forbiddenWhy, ROLE_TOOLS, type Role } from "../../src/path-policy.ts";
import { CONTINUATION_CHECKED } from "../../src/phase-gate.ts";
import {
  AGENT_TOOLS,
  CLAUDE_COMMISSIONS,
  CONTINUE_WORKER_FIELD,
  continuableWorker,
  currentWorkers,
  SEND_MESSAGE_TOOL,
  sendSucceeded,
  sendTarget,
  launchOutcome,
  earlierCallerEnded,
  WORKER_STARTED,
  workerRole,
} from "./continuation.ts";
import { readDevStageModels } from "../../src/dev-stage-models.ts";
import { MODEL_TIER_GUARD, planModelTier, tierSummary } from "../../src/model-tier.ts";
import { decideBash, shellWords } from "./bash-policy.ts";
import { defaultHarnessRoot } from "./render-agents.ts";
import { BASH_TOOL, claudeTaskModel, mapToolCall, unplainAgentField } from "./tool-map.ts";
import { resolveSessionRole } from "../../src/session-role.ts";
import { projectReadAllowed } from "../../src/setup-state.ts";
import { claudeProjectRead } from "./project-read.ts";
import { allowWith, deny, shellQuote, type HookPayload } from "./hook-output.ts";
import { boundDefinitionInForce, evaluateLead, evaluateScout } from "./lead-hook.ts";
import { LAUNCHED_SEAT_ENV } from "./architect-launch.ts";
import { readTicketMarker } from "../../src/ticket-worktree.ts";

/** What one hook run says back to Claude Code. Exit is always 0. */
export interface HookOutcome {
  readonly stdout: string;
  readonly stderr: string;
}

const DENY_PREFIX = "path-gate-hook";

interface Flags {
  readonly role?: string;
  readonly harnessRoot?: string;
  readonly projectLocal: boolean;
}

function parseFlags(argv: readonly string[]): Flags {
  let role: string | undefined;
  let harnessRoot: string | undefined;
  let projectLocal = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = i + 1 < argv.length ? argv[i + 1] : undefined;
    if (arg === "--role") {
      role = next;
      i++;
    } else if (arg === "--harness-root") {
      harnessRoot = next;
      i++;
    } else if (arg.startsWith("--role=")) role = arg.slice("--role=".length);
    else if (arg.startsWith("--harness-root=")) harnessRoot = arg.slice("--harness-root=".length);
    else if (arg === "--project-local") projectLocal = true;
  }
  return {
    projectLocal,
    ...(role !== undefined ? { role } : {}),
    ...(harnessRoot !== undefined ? { harnessRoot } : {}),
  };
}

type Payload = HookPayload;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRecord(raw: string): Readonly<Record<string, unknown>> {
  const rec: unknown = JSON.parse(raw);
  if (!isRecord(rec)) throw new Error("payload is not a JSON object");
  return rec;
}

/** The tool the payload names — read first and on its own, so the failure
 *  mode can be chosen by tool even when the rest of the payload is bad. */
function toolNameOf(rec: Readonly<Record<string, unknown>>): string {
  const toolName = rec["tool_name"];
  if (typeof toolName !== "string") throw new Error("payload has no tool_name");
  return toolName;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function narrowPayload(rec: Readonly<Record<string, unknown>>, toolName: string): Payload {
  const toolInput = rec["tool_input"] ?? {};
  if (!isRecord(toolInput)) throw new Error("payload tool_input is not an object");
  const event = nonEmpty(rec["hook_event_name"]);
  const cwd = nonEmpty(rec["cwd"]);
  const agentType = nonEmpty(rec["agent_type"]);
  const agentId = nonEmpty(rec["agent_id"]);
  const caller = callerOf(rec);
  const toolUseId = nonEmpty(rec["tool_use_id"]);
  return {
    ...(caller !== undefined ? { caller } : {}),
    ...(toolUseId !== undefined ? { toolUseId } : {}),
    ...(event !== undefined ? { event } : {}),
    toolName,
    toolInput,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(agentType !== undefined ? { agentType } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
  };
}

/**
 * The only calls an errored hook lets through: a local read (Read, Grep, Glob,
 * LS) whose every path passes the dependency-free pre-setup check — inside the
 * project once links are resolved, outside .git, no search of the project
 * root. That check knows no role, so an errored hook may still let a blind
 * role read the other side; it never lets anyone read outside the project or
 * into .git. Every other call, including an unknown tool, MCP tools, skills,
 * a read that fails the check, or a payload whose tool or input cannot be
 * read, is refused rather than waved through ungated.
 */
export function errorOpenRead(
  toolName: string | undefined,
  rec: Readonly<Record<string, unknown>> | undefined,
  fallbackCwd: string,
): boolean {
  if (rec === undefined) return false;
  const input = rec["tool_input"];
  if (!isRecord(input)) return false;
  const read = claudeProjectRead(toolName, input);
  if (read === undefined) return false;
  const base = nonEmpty(rec["cwd"]) ?? fallbackCwd;
  const project = nonEmpty(process.env["CLAUDE_PROJECT_DIR"]) ?? base;
  return projectReadAllowed(project, base, read);
}

/** The env var `sessionRole()` reads first (src/path-gate.ts), which is how
 *  the bound role reaches the `bounded gates` process the shell starts. */
const ROLE_ENV = "BOUNDED_DEV_STAGE_ROLE";

/** Claude Code's Bash tool: the timeout a call gets when it names none, and
 *  the most it may name. Past it, Claude Code kills the command. Claude Code
 *  reads both from its environment when set (`BASH_DEFAULT_TIMEOUT_MS`,
 *  `BASH_MAX_TIMEOUT_MS`), and the hook runs in that environment. */
export const BASH_DEFAULT_TIMEOUT_MS = 120_000;
export const BASH_MAX_TIMEOUT_MS = 600_000;

function positiveMs(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return undefined;
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** How long Claude Code lets this Bash call run: its own `timeout` when it
 *  names a usable one, else the default, never past the maximum. */
export function bashDeadlineMs(timeout: unknown, env: Readonly<Record<string, string | undefined>> = process.env): number {
  const max = positiveMs(env["BASH_MAX_TIMEOUT_MS"]) ?? BASH_MAX_TIMEOUT_MS;
  const fallback = positiveMs(env["BASH_DEFAULT_TIMEOUT_MS"]) ?? BASH_DEFAULT_TIMEOUT_MS;
  const asked = typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0 ? Math.floor(timeout) : fallback;
  return Math.min(asked, max);
}

/** The env prefix an allowed `bounded gates` call is given: the host, so the CLI
 *  records `claude-code` rather than `none`; the bound role; and the call's
 *  deadline, so a gate that can split its work stops before it is killed.
 *  The call's timeout itself is left as the model set it. */
export function gateEnvPrefix(role: Role, deadlineMs: number = BASH_DEFAULT_TIMEOUT_MS): string {
  return `${HOST_ENV}=claude-code ${ROLE_ENV}=${role} ${COMMAND_TIMEOUT_ENV}=${deadlineMs}`;
}

/** A subagent bound by its definition holds every constraint: `tools:` is the
 *  strip, this hook is the path and phase gate, and the role env prefix gives
 *  the gates their scoped views. */
const CLAUDE_CODE_BOUND = declareHost("claude-code", CONSTRAINTS);
/** An ambient session (role from `.bounded/dev-stage-role`) has no allowlist — the
 *  hook judges what it maps and the rest of the toolset stays. */
const CLAUDE_CODE_AMBIENT = declareHost("claude-code", ["path-gate", "phase-gate", "scoped-views"]);

/**
 * One hook run, as a function: argv + stdin → what to print. `fallbackCwd` is
 * the process cwd, used only when the payload names none or cannot be read —
 * Claude Code runs hooks in the project directory, so an error event still
 * lands in the right guard log.
 */
export function runHook(argv: readonly string[], rawStdin: string, fallbackCwd: string): HookOutcome {
  const flags = parseFlags(argv);
  let cwd = fallbackCwd;
  let toolName: string | undefined;
  let rec: Readonly<Record<string, unknown>> | undefined;
  try {
    rec = parseRecord(rawStdin);
    toolName = toolNameOf(rec);
    const payload = narrowPayload(rec, toolName);
    const projectDir = process.env["CLAUDE_PROJECT_DIR"] ?? payload.cwd ?? fallbackCwd;
    const boundSeat = flags.role ?? launchedSeat(flags, payload, projectDir);
    // A bound role's definition also registers this hook after Agent and
    // SendMessage calls: that is how a started worker's agent id reaches the
    // guard log, and how a failed continuation licenses a relaunch
    // (continuation.ts). Nothing after a call is ever refused here.
    if (payload.event === "PostToolUse" || payload.event === "PostToolUseFailure") {
      const role = asRole(boundSeat);
      if (role !== undefined) {
        const at = payload.cwd ?? fallbackCwd;
        try {
          recordCommissionOutcome(role, payload, rec, at);
        } catch (err) {
          // The outcome of this launch can now never be known, so it is
          // recorded as not continuable rather than left to deadlock the role.
          licenseUnknownOutcome(role, payload, at, err);
        }
      }
      return { stdout: "", stderr: "" };
    }
    if (payload.event !== undefined && payload.event !== "PreToolUse") return { stdout: "", stderr: "" };
    cwd = payload.cwd ?? fallbackCwd;
    const harnessRoot = flags.harnessRoot ?? defaultHarnessRoot();

    // One shared resolution decides the seat (src/session-role.ts). In a
    // project installation a role file left by an older run cannot turn the
    // user's next session into an architect: the main session is the lead.
    // A bound subagent's call seen by the project-wide or ambient hook is
    // judged by its own definition's hook; judging it again here would confine
    // it to the intersection of two seats, so this hook stands down.
    const seat = resolveSessionRole({
      ...(boundSeat !== undefined ? { boundSeat } : {}),
      projectLocal: flags.projectLocal,
      child: payload.agentId !== undefined,
      ticketWorktree: flags.projectLocal && readTicketMarker(projectDir) !== undefined,
      judgedElsewhere: flags.projectLocal
        ? payload.agentId !== undefined && boundDefinitionInForce(projectDir, payload.agentType)
        : payload.agentType !== undefined || payload.agentId !== undefined,
      ambientRole: () => sessionRole(cwd),
    });
    switch (seat.kind) {
      case "lead":
        return { stdout: evaluateLead(payload, cwd, harnessRoot), stderr: "" };
      case "scout":
        return { stdout: evaluateScout(payload, cwd), stderr: "" };
      case "none":
        if (seat.note === undefined) return { stdout: "", stderr: "" };
        logGuardEvent(cwd, {
          guard: "path-gate",
          verdict: "error",
          summary: `${DENY_PREFIX}: --role ${seat.note}`,
          detail: { host: "claude-code", kind: "hook-error", role: flags.role },
        });
        return { stdout: "", stderr: `${DENY_PREFIX}: --role ${seat.note}\n` };
      case "role":
        return { stdout: evaluate(seat.role, seat.bound, payload, cwd, harnessRoot, flags.projectLocal), stderr: "" };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const closed = !errorOpenRead(toolName, rec, fallbackCwd);
    const outcome = closed ? "call refused" : "call allowed";
    logGuardEvent(cwd, {
      guard: "path-gate",
      verdict: "error",
      summary: `${DENY_PREFIX}: error, ${outcome}: ${message}`,
      detail: { host: "claude-code", kind: "hook-error", ...(toolName !== undefined ? { tool: toolName } : {}) },
    });
    if (closed) {
      const what = toolName ?? "unreadable";
      const reason = `${DENY_PREFIX}: the hook errored (${message}), so this ${what} call is refused rather than let through ungated`;
      return { stdout: deny(reason), stderr: `${DENY_PREFIX}: error, refusing the ${what} call: ${message}\n` };
    }
    return { stdout: "", stderr: `${DENY_PREFIX}: error, allowing the call: ${message}\n` };
  }
}

/** Rebuild the already-validated gate argv with the copied project's CLI.
 * Quoting every word also handles a model spelling `"bounded" gates ...`. */
function localGateCommand(command: string, harnessRoot: string): string {
  const words = shellWords(command);
  if (!words.ok || words.argv[0] !== "bounded" || words.argv[1] !== "gates") {
    throw new Error("a validated gate command could not be reconstructed");
  }
  return [join(harnessRoot, "scripts", "bounded"), ...words.argv.slice(1)].map(shellQuote).join(" ");
}

/**
 * After an Agent or SendMessage call by a role that commissions workers:
 * record the worker an Agent result started (its agent id is the address a
 * later continuation must use), and record a continuation that did not go
 * through, which licenses a fresh launch of that role (continuation.ts).
 */
function recordCommissionOutcome(
  role: Role,
  payload: Payload,
  rec: Readonly<Record<string, unknown>>,
  cwd: string,
): void {
  if (!ROLE_TOOLS[role].includes("subagent")) return;
  const response = rec["tool_response"];
  if (AGENT_TOOLS.has(payload.toolName)) {
    const asked = payload.toolInput["subagent_type"];
    if (typeof asked !== "string" || asRole(asked) === undefined) return;
    // A failed launch is over and left nothing; otherwise the result says.
    const outcome = payload.event === "PostToolUseFailure"
      ? { kind: "ended" as const, role: asked }
      : launchOutcome(payload.toolInput, response);
    if (outcome === undefined) return; // proves nothing: record nothing, license nothing
    if (outcome.kind === "worker") {
      logGuardEvent(cwd, {
        guard: "phase-gate",
        verdict: "pass",
        summary: `${outcome.role} is worker ${outcome.worker}`,
        detail: { kind: WORKER_STARTED, role, target: outcome.role, worker: outcome.worker },
      });
      return;
    }
    logGuardEvent(cwd, {
      guard: "phase-gate",
      verdict: "pass",
      summary: `the ${asked} launch ended with no worker to continue — a fresh ${asked} may be launched`,
      detail: { kind: CONTINUATION_CHECKED, role, target: asked },
    });
    return;
  }
  if (payload.toolName !== SEND_MESSAGE_TOOL) return;
  if (payload.event === "PostToolUse" && sendSucceeded(response)) return;
  const target = sendTarget(payload.toolInput);
  if (!target.ok) return;
  const events = readGuardLog(cwd);
  const workerOf = workerRole(target.to, events);
  // Only a failed send to the role's CURRENT worker says that role cannot be
  // continued; a stale worker failing says nothing about its successor.
  if (workerOf === undefined || continuableWorker(workerOf, events) !== target.to) return;
  logGuardEvent(cwd, {
    guard: "phase-gate",
    verdict: "pass",
    summary: `${CLAUDE_COMMISSIONS.checkSummary}: ${workerOf} ${target.to} — a fresh ${workerOf} may be launched`,
    detail: { kind: CONTINUATION_CHECKED, role, target: workerOf, worker: target.to },
  });
}

/** After-call recording failed: an Agent launch of a pipeline role whose
 *  outcome is now unknowable licenses a relaunch, and the error is logged. */
export function licenseUnknownOutcome(role: Role, payload: Payload, cwd: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  logGuardEvent(cwd, {
    guard: "path-gate",
    verdict: "error",
    summary: `${DENY_PREFIX}: recording the outcome of ${payload.toolName} failed: ${message}`,
    detail: { host: "claude-code", kind: "hook-error", tool: payload.toolName },
  });
  const asked = payload.toolInput["subagent_type"];
  if (!AGENT_TOOLS.has(payload.toolName) || typeof asked !== "string" || asRole(asked) === undefined) return;
  logGuardEvent(cwd, {
    guard: "phase-gate",
    verdict: "pass",
    summary: `the outcome of the ${asked} launch could not be recorded — a fresh ${asked} may be launched`,
    detail: { kind: CONTINUATION_CHECKED, role, target: asked },
  });
}

/**
 * The seat of a session `bounded lead start` launched (architect-launch.ts):
 * the project-wide hook, a top-level call (no agent id), the launch's seat in
 * this process's environment, inside a worktree the start command marked as a
 * ticket's. The model cannot change the environment of the process running
 * it, and outside a marked ticket worktree the variable means nothing.
 */
export function launchedSeat(flags: { readonly projectLocal: boolean }, payload: Payload, projectDir: string): string | undefined {
  if (!flags.projectLocal || payload.agentId !== undefined) return undefined;
  const seat = process.env[LAUNCHED_SEAT_ENV];
  if (seat !== "architect" || readTicketMarker(projectDir) === undefined) return undefined;
  return seat;
}

/** The seat instance making a call: a subagent's agent id, else the session. */
function callerOf(rec: Readonly<Record<string, unknown>>): string | undefined {
  const agent = nonEmpty(rec["agent_id"]);
  if (agent !== undefined) return `agent:${agent}`;
  const session = nonEmpty(rec["session_id"]);
  return session === undefined ? undefined : `session:${session}`;
}

/**
 * A SendMessage by a bound role. It is how this host continues a finished
 * worker, so it is allowed only to a role that commissions workers, only as a
 * plain message, and only to a worker the guard log says this pipeline
 * started — never the main conversation or another session. Then it is the
 * core's continuation, recorded like any other commission.
 */
function evaluateContinuation(role: Role, payload: Payload, cwd: string, harnessRoot: string): string {
  const refuse = (reason: string): string => {
    logGuardEvent(cwd, {
      guard: "phase-gate",
      verdict: "block",
      summary: reason,
      detail: { kind: "spawn-refused", role, tool: SEND_MESSAGE_TOOL },
    });
    return deny(reason);
  };
  if (!ROLE_TOOLS[role].includes("subagent")) {
    return refuse(`path-gate: ${role} may not use '${SEND_MESSAGE_TOOL}': ${forbiddenWhy(role, "subagent")}`);
  }
  const target = sendTarget(payload.toolInput);
  if (!target.ok) return refuse(`phase-gate: ${SEND_MESSAGE_TOOL} here only continues a worker — ${target.reason}`);
  const events = readGuardLog(cwd);
  const workerOf = workerRole(target.to, events);
  // Only each role's current worker: the one recorded after its last launch,
  // whose continuation has not failed. Never `main`, another session, or a
  // worker a later launch replaced.
  if (workerOf === undefined || continuableWorker(workerOf, events) !== target.to) {
    const current = currentWorkers(events).map((w) => `${w.role} ${w.worker}`);
    return refuse(
      `phase-gate: ${SEND_MESSAGE_TOOL} here only continues a role's current worker, and '${target.to}' is not one — ` +
        (current.length > 0 ? `current workers: ${current.join(", ")}` : "no worker can be continued; commission one with the Agent tool"),
    );
  }
  const blocked = evaluatePathGate({
    role,
    toolName: "subagent",
    input: { [CONTINUE_WORKER_FIELD]: target.to, agent: workerOf },
    cwd,
    harnessRoot,
    host: "claude-code",
    commissions: CLAUDE_COMMISSIONS,
  });
  return blocked === undefined ? "" : deny(blocked.reason);
}

function evaluate(role: Role, bound: boolean, payload: Payload, cwd: string, harnessRoot: string, projectLocal: boolean): string {
  // Say which host this is and what it holds (ADR 2026-034). The strip is the
  // agent definition's `tools:` allowlist, so only a BOUND role has it; an
  // ambient session keeps every Claude Code tool and the hook judges what it
  // maps. Recorded on change, so the line appears once per stretch of a run.
  recordHostDeclaration(cwd, bound ? CLAUDE_CODE_BOUND : CLAUDE_CODE_AMBIENT);

  // The first call the driving role makes is where the run demonstrably
  // starts — marked before it is judged, as in pi, because a refused first
  // call still started the run.
  if (isDrivingRole(role) && !readGuardLog(cwd).some((e) => e.guard === RUN_START_GUARD)) {
    recordRunStart(cwd, role, payload.toolName);
  }

  if (payload.toolName === SEND_MESSAGE_TOOL) return evaluateContinuation(role, payload, cwd, harnessRoot);

  const calls = mapToolCall({ tool_name: payload.toolName, tool_input: payload.toolInput }, cwd);
  let allowed = "";
  for (const call of calls) {
    if (call.toolName === BASH_TOOL) {
      const raw = call.input["command"];
      const command = typeof raw === "string" ? raw : "";
      // The same context the file tools are judged with (layout, protected
      // names, ticket scope), so an `rm` obeys exactly a pi `remove`'s rules.
      const decision = decideBash(role, command, pathGateCtx(role, cwd, harnessRoot));
      if (!decision.allow) {
        // decide() logs its own blocks through evaluatePathGate; the bash
        // policy is pure, so its refusal is recorded here.
        logGuardEvent(cwd, {
          guard: "path-gate",
          verdict: "block",
          summary: decision.reason,
          detail: { role, tool: BASH_TOOL, command },
        });
        return deny(decision.reason);
      }
      // A gate run inherits the bound role through its environment: the
      // policy has already refused every construct that could make the
      // prefix mean anything but an env assignment. git, sleep and rm pass
      // through untouched — nothing in them reads a role.
      if (decision.carrier === "bounded gates") {
        const envPrefix = gateEnvPrefix(role, bashDeadlineMs(payload.toolInput["timeout"]));
        allowed = allowWith({
          ...payload.toolInput,
          command: projectLocal
            ? `${envPrefix} ${localGateCommand(command, harnessRoot)}`
            : `${envPrefix} ${command}`,
        });
      }
      continue;
    }
    if (call.toolName === "subagent") {
      const unbound = unboundSpawn(call.input);
      if (unbound !== undefined) {
        logGuardEvent(cwd, {
          guard: "phase-gate",
          verdict: "block",
          summary: unbound.reason,
          detail: { kind: "spawn-refused", role, ...(unbound.target !== undefined ? { target: unbound.target } : {}) },
        });
        return deny(unbound.reason);
      }
      // A commission starts a fresh, unnamed foreground worker and nothing
      // else: a name, a background run, another worktree or directory would
      // hide, detach or move the seat (the lead's allowlist, tool-map.ts).
      const extra = unplainAgentField(payload.toolInput);
      if (extra !== undefined) {
        const reason = `phase-gate: a commission must start a fresh, unnamed foreground subagent ('${extra}' is not allowed)`;
        logGuardEvent(cwd, {
          guard: "phase-gate",
          verdict: "block",
          summary: reason,
          detail: { kind: "spawn-refused", role, field: extra },
        });
        return deny(reason);
      }
      // A launch with no recorded outcome, made by an earlier architect that
      // has since been replaced, can never be continued: its run ended before
      // the after-call hook could say what it left. A different caller's
      // relaunch is licensed (continuation.ts); the same caller's is not,
      // because to it that launch is still running.
      const target = call.input["agent"];
      if (typeof target === "string") {
        if (earlierCallerEnded(target, payload.caller, readGuardLog(cwd))) {
          logGuardEvent(cwd, {
            guard: "phase-gate",
            verdict: "pass",
            summary: `the last ${target} was launched by an architect that has since ended, and left no recorded outcome — a fresh ${target} may be launched`,
            detail: { kind: CONTINUATION_CHECKED, role, target },
          });
        }
      }
      // The tier is policy (ADR 2026-022): the same core that plans pi's
      // injection plans it here. This host only translates the pi pattern
      // into the Agent tool's model vocabulary and rewrites the call — the
      // hook holds no tier opinion of its own. A configured tier this host
      // cannot run is a refusal, not a silent session-default seat (the
      // r15 lesson: a seat running on a model nobody chose).
      const plan = planModelTier(call.input, readDevStageModels(cwd));
      if (plan.kind === "inject") {
        const hostModel = claudeTaskModel(plan.model);
        if (hostModel === undefined) {
          const reason =
            `model-tier: ${plan.key} '${plan.model}' names no model this host can run — ` +
            "Claude Code seats take anthropic models; change .bounded/dev-stage-models.json or drive this ticket under pi";
          logGuardEvent(cwd, {
            guard: MODEL_TIER_GUARD,
            verdict: "block",
            summary: reason,
            detail: { role, kind: "unresolvable-tier", key: plan.key, model: plan.model },
          });
          return deny(reason);
        }
        logGuardEvent(cwd, {
          guard: MODEL_TIER_GUARD,
          verdict: "pass",
          summary: `${tierSummary(plan)} — as '${hostModel}' on this host`,
          detail: { role, kind: "tier-injected", key: plan.key, model: plan.model, hostModel },
        });
        allowed = allowWith({ ...payload.toolInput, model: hostModel });
      }
    }
    const blocked = evaluatePathGate({
      role,
      toolName: call.toolName,
      input: call.input,
      cwd,
      harnessRoot,
      host: "claude-code",
      commissions: CLAUDE_COMMISSIONS,
      ...(payload.caller !== undefined ? { caller: payload.caller } : {}),
    });
    if (blocked !== undefined) return deny(blocked.reason);
  }
  return allowed;
}

/**
 * On this host only the four generated definitions carry a tool strip and a
 * bound hook. Any other `subagent_type` — `general-purpose`, `Explore`, a
 * user's own agent, pi's `delegate` — starts with every tool and no hook: a
 * full-toolset proxy for the caller, which is exactly what the phase gate's
 * `delegate` refusal exists to prevent. So a commission is judged first by
 * WHAT it names: not a pipeline role ⇒ refused, before the phase gate sees
 * it. Logged as the phase gate's own spawn-refused block.
 */
function unboundSpawn(
  input: Readonly<Record<string, unknown>>,
): { readonly reason: string; readonly target?: string } | undefined {
  const named = input["agent"];
  const target = typeof named === "string" ? named : undefined;
  if (target !== undefined && asRole(target) !== undefined) return undefined;
  const who = target === undefined ? "an Agent call with no subagent_type" : `'${target}'`;
  const reason =
    `phase-gate: ${who} holds no role binding — inside the developer stage every subagent is a bound role, ` +
    `and on Claude Code only the generated definitions (${PIPELINE_ROLES.join(", ")}) carry the tool strip and ` +
    "the path-gate hook; any other subagent_type runs with every tool and no hook. Commission the role that owns the work.";
  return { reason, ...(target !== undefined ? { target } : {}) };
}

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return ""; // no stdin ⇒ malformed payload ⇒ refused, loudly
  }
}

if (isMainModule(import.meta.url)) {
  const out = runHook(process.argv.slice(2), readStdin(), process.cwd());
  if (out.stdout !== "") process.stdout.write(out.stdout);
  if (out.stderr !== "") process.stderr.write(out.stderr);
  process.exit(0); // never non-zero: a hook failure is a fail-open, not a block
}
