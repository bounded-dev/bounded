// The team lead's commands (ADR 2026-066). The lead sits in the main worktree
// and stays read-only except through these. Each one checks its own
// preconditions, moves the board only as the table below says, and leaves the
// worktree and the board in step or refuses:
//
//   ticket create   creates the issue with the fixed sections        → Backlog
//   queue           a Backlog ticket, with `waiting on #n` labels     → Queued
//   start           worktree, branch, setup, run, bound architect     → In Design
//   (design gate)   passes in the ticket worktree (board-sync.ts)     → Building
//   (deliver gate)  passes in the ticket worktree (board-sync.ts)     → Awaiting Merge
//   merge           local merge, project check, push, close           → Done
//   status, reply   read the architects' state, answer one architect
//   sync-config     restore a ticket's generated config in its worktree,
//                   once the user agrees; Awaiting Merge → Building
//
// Every host reaches these through `parseLeadArgs`, so the accepted shapes
// cannot drift between the shell form and a host's tools. Everything with a
// side effect outside this process — the tracker, git, dependency setup, the
// project check, the architect host — is a dependency, so each transition
// is tested without the network or a host.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { applyBoardOps, boardReady, quarantinedOps, releaseQuarantine, type BoardOp } from "./board-sync.ts";
import {
  architectStatus, claimStale, clearArchitectState, clearPendingLaunch, clearPendingReply, flagLike, readPendingLaunch, releaseLaunchClaim,
  seatNeedsRelaunch, writePendingLaunch, writePendingReply, type ArchitectHost,
} from "./architect-seat.ts";
import { clearDeliverySnapshot, readDeliverySnapshot, worktreeSnapshot } from "./delivery-snapshot.ts";
import { acquireLock, systemProcesses, type ProcessProbe } from "./process-lock.ts";
import { readDevStageModels } from "./dev-stage-models.ts";
import { logGuardEvent, readGuardLog } from "./guard-log.ts";
import { prepareLeadRun } from "./lead-run.ts";
import { backgroundWorkers, isProjectLocalHarness, LEAD_GUARD, preparedTicket, readRunLog, SEAT_RELEASED } from "./lead-state.ts";
import { planModelTier } from "./model-tier.ts";
import { contributionsByPack, projectConfigSyncCommand } from "./pack-contrib.ts";
import { readProjectPacks } from "./project-composition.ts";
import { dependenciesReady, HARNESS_RELATIVE, INSTALLATION_RELATIVE, type SetupResult } from "./setup-state.ts";
import {
  checkTicketFields, ownershipConflict, parseIssueRef, parseTicketBody, renderTicketBody, type TicketFields,
} from "./ticket-body.ts";
import {
  readStartedTicket, readTicketMarker, removeStartedTicket, startedTickets, ticketBranch, ticketWorktreeDirs, ticketWorktreePath,
  writeStartedTicket, writeTicketMarker, type StartedTicket,
} from "./ticket-worktree.ts";
import {
  HANDOFF_PUBLISHED_LABEL, trackerRefusal, WAITING_LABEL_PREFIX, waitingLabel, type Tracker, type TrackerIssue,
} from "./tracker.ts";

/** The branch the lead sits on, merges into and pushes. */
export const MAIN_BRANCH = "main";
/** The remote `main` is pushed to. */
export const REMOTE = "origin";
/** The data socket a pack declares its project's full check in (ADR 2026-066). */
export const PROJECT_CHECK_SOCKET = "projectCheckCommands";

// ── The command line ────────────────────────────────────────────────────────

export interface LeadCommandSpec {
  readonly name: string;
  /** Run only by the user from a terminal; no host gives the lead this command. */
  readonly userOnly?: true;
  /** The one spelling of the command, shared by the CLI, the hosts and the skill. */
  readonly usage: string;
  readonly summary: string;
}

export const LEAD_COMMANDS: readonly LeadCommandSpec[] = [
  {
    name: "ticket create",
    usage: "bounded lead ticket create --title <text> --outcome <text> --acceptance <text> --owns <path> [--owns <path>...] [--depends <issue>...] --decisions <text>",
    summary: "Create a ticket with its outcome, acceptance criteria, owned contract paths, dependencies and the decisions to return; it lands in Backlog.",
  },
  { name: "queue", usage: "bounded lead queue <issue>", summary: "Move a Backlog ticket to Queued; each unreleased dependency becomes a `waiting on #n` label." },
  { name: "start", usage: "bounded lead start <issue>", summary: "Give a Queued ticket its worktree and branch, set it up, prepare its run and start its architect there; it moves to In Design." },
  { name: "status", usage: "bounded lead status", summary: "Show every started ticket's board status and its architect's state, with the report of a finished turn." },
  { name: "reply", usage: "bounded lead reply <issue> <message>", summary: "Continue a ticket's finished architect turn with the user's answer." },
  { name: "merge", usage: "bounded lead merge <issue>", summary: "Merge a delivered ticket into local main, run the project's check, push main and close the ticket; it moves to Done." },
  { name: "board", usage: "bounded lead board <retry|discard>", summary: "Try again, or set aside for good, the board updates that kept failing and were quarantined; status lists them." },
  {
    name: "sync-config", usage: "bounded lead sync-config <issue>",
    summary: "Only after the user agrees: restore a started ticket's generated project config (package manifests, lockfile, installed dependencies) in its own worktree; a delivered ticket reopens to Building until deliver passes again.",
  },
  {
    name: "release", usage: "bounded lead release <issue> [--force]", userOnly: true,
    summary: "For the user, never the lead: clear all of a stuck ticket's seat state — its architect seat, background-worker blocks, launch claim and pending reply — once its recorded processes are gone, or with --force. It is the user's because the harness cannot prove a seat's session is gone.",
  },
];

export type LeadRequest =
  | { readonly command: "ticket-create"; readonly fields: TicketFields }
  | { readonly command: "queue" | "start" | "merge" | "sync-config"; readonly issue: number }
  | { readonly command: "status" }
  | { readonly command: "reply"; readonly issue: number; readonly message: string }
  | { readonly command: "board"; readonly action: "retry" | "discard" }
  | { readonly command: "release"; readonly issue: number; readonly force: boolean };

export type ParsedLead = { readonly ok: true; readonly request: LeadRequest } | { readonly ok: false; readonly reason: string };

const usageOf = (name: string): string => `usage: ${LEAD_COMMANDS.find((c) => c.name === name)!.usage}`;

function parseTicketCreate(args: readonly string[]): ParsedLead {
  const single = new Map<string, string>();
  const owns: string[] = [];
  const depends: number[] = [];
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]!;
    const value = args[i + 1];
    if (value === undefined) return { ok: false, reason: `${flag} needs a value — ${usageOf("ticket create")}` };
    if (flag === "--owns") owns.push(value);
    else if (flag === "--depends") {
      const issue = parseIssueRef(value);
      if (issue === undefined) return { ok: false, reason: `--depends takes an issue number, not '${value}'` };
      depends.push(issue);
    } else if (["--title", "--outcome", "--acceptance", "--decisions"].includes(flag)) {
      if (single.has(flag)) return { ok: false, reason: `${flag} is given twice` };
      single.set(flag, value);
    } else return { ok: false, reason: `unknown option '${flag}' — ${usageOf("ticket create")}` };
  }
  const fields: TicketFields = {
    title: single.get("--title") ?? "", outcome: single.get("--outcome") ?? "",
    acceptance: single.get("--acceptance") ?? "", decisions: single.get("--decisions") ?? "", owns, depends,
  };
  const check = checkTicketFields(fields);
  return check.ok ? { ok: true, request: { command: "ticket-create", fields } } : { ok: false, reason: check.reason };
}

/** `bounded lead <args>`, and nothing else. */
export function parseLeadArgs(args: readonly string[]): ParsedLead {
  const [first, ...rest] = args;
  if (first === "ticket" && rest[0] === "create") return parseTicketCreate(rest.slice(1));
  if (first === "status") return rest.length === 0 ? { ok: true, request: { command: "status" } } : { ok: false, reason: usageOf("status") };
  if (first === "queue" || first === "start" || first === "merge" || first === "sync-config") {
    const issue = rest.length === 1 ? parseIssueRef(rest[0]!) : undefined;
    return issue === undefined ? { ok: false, reason: usageOf(first) } : { ok: true, request: { command: first, issue } };
  }
  if (first === "release") {
    const force = rest.length === 2 && rest[1] === "--force";
    const issue = rest.length === 1 || force ? parseIssueRef(rest[0]!) : undefined;
    return issue === undefined ? { ok: false, reason: usageOf("release") } : { ok: true, request: { command: "release", issue, force } };
  }
  if (first === "board") {
    const action = rest[0];
    return rest.length === 1 && (action === "retry" || action === "discard")
      ? { ok: true, request: { command: "board", action } } : { ok: false, reason: usageOf("board") };
  }
  if (first === "reply") {
    const issue = rest.length === 2 ? parseIssueRef(rest[0]!) : undefined;
    const message = rest[1]?.trim() ?? "";
    if (issue === undefined || message === "") return { ok: false, reason: usageOf("reply") };
    // A host's command line could read it as an option (ADR 2026-066).
    if (flagLike(message)) return { ok: false, reason: "a reply may not begin with '-'; reword it" };
    return { ok: true, request: { command: "reply", issue, message } };
  }
  return { ok: false, reason: `usage: ${LEAD_COMMANDS.map((c) => c.usage).join("\n       ")}` };
}

// ── Dependencies ────────────────────────────────────────────────────────────

/** One git invocation in `cwd`. */
export type GitRun = (args: readonly string[], cwd: string) => { readonly status: number; readonly stdout: string; readonly stderr: string };

export const gitCommandLine: GitRun = (args, cwd) => {
  const run = spawnSync("git", [...args], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { status: run.status ?? 1, stdout: run.stdout ?? "", stderr: run.stderr ?? (run.error?.message ?? "") };
};

export interface LeadDeps {
  readonly tracker: (cwd: string) => Tracker;
  readonly git: GitRun;
  /** The architect launch for the installation's host. */
  readonly host: (main: string) => Promise<ArchitectHost>;
  /** Install a fresh ticket worktree's dependencies from its lockfiles. */
  readonly setup: (worktree: string) => Promise<SetupResult>;
  /** The project's full check, in `cwd`. */
  readonly check: (cwd: string) => { readonly ok: boolean; readonly output: string };
  /** Which processes run, by pid and start time (locks and architect turns). */
  readonly processes?: ProcessProbe;
  /** Whether a worktree's dependencies are installed (default: the setup probes). */
  readonly ready?: (worktree: string) => boolean;
  /** Restore a ticket worktree's generated config (default: the composed
   *  `projectConfigSyncCommand`, run from {@link LeadDeps.packsDir}). */
  readonly syncConfig?: (worktree: string) => { readonly ok: boolean; readonly output: string } | Promise<{ readonly ok: boolean; readonly output: string }>;
  /** Where the lead reads pack data and scripts (default: the main
   *  worktree's `.bounded/harness/packs`, the source the project check uses). */
  readonly packsDir?: string;
}

/** The lock every lead command holds in the main worktree, so no two interleave. */
export const LEAD_LOCK_RELATIVE = ".bounded/lead/lock";

/** The project's full check: each composed pack's declared command, in order. */
export function projectCheck(cwd: string): { readonly ok: boolean; readonly output: string } {
  let commands: string[][];
  try {
    commands = contributionsByPack(PROJECT_CHECK_SOCKET, readProjectPacks(cwd), join(cwd, HARNESS_RELATIVE, "packs"))
      .flatMap(({ pack, value }) => {
        if (!Array.isArray(value) || value.some((argv) => !Array.isArray(argv) || argv.length === 0 ||
            argv.some((word) => typeof word !== "string" || word === ""))) {
          throw new Error(`pack '${pack}' field '${PROJECT_CHECK_SOCKET}' must be a list of argv lists`);
        }
        return value as string[][];
      });
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) };
  }
  if (commands.length === 0) return { ok: false, output: "no composed capability declares the project's check" };
  const outputs: string[] = [];
  for (const [command, ...args] of commands) {
    const run = spawnSync(command!, args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    outputs.push(`$ ${[command, ...args].join(" ")}`, `${run.stdout ?? ""}${run.stderr ?? ""}`.trim());
    if (run.status !== 0) return { ok: false, output: outputs.join("\n") };
  }
  return { ok: true, output: outputs.join("\n") };
}

/**
 * The default config sync, run in a ticket's worktree: the one composed
 * pack's `projectConfigSyncCommand` (ADR 2026-072), its script read from the
 * same packs directory as the socket, its output captured. Any refusal —
 * no such command, more than one, a malformed one — comes back as the output.
 */
export async function syncTicketConfig(worktree: string, packsDir: string): Promise<{ readonly ok: boolean; readonly output: string }> {
  try {
    const { command } = projectConfigSyncCommand(readProjectPacks(worktree), packsDir);
    const { captureProjectCommand } = await import("../packs/command.ts");
    return captureProjectCommand(command, worktree, [], packsDir);
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) };
  }
}

/** The production dependencies, with the installation's tracker opened by `tracker`. */
export function leadDeps(tracker: (cwd: string) => Tracker, setupHost?: string): LeadDeps {
  return {
    tracker,
    git: gitCommandLine,
    host: installedArchitectHost,
    setup: async (worktree) => {
      const { runProjectSetup } = await import("./setup-state.ts");
      return runProjectSetup(worktree, setupHost !== undefined ? { host: setupHost } : {});
    },
    check: projectCheck,
  };
}

// ── Running a command ───────────────────────────────────────────────────────

export interface LeadOutcome {
  readonly ok: boolean;
  readonly text: string;
}

const done = (text: string): LeadOutcome => ({ ok: true, text: `team-lead: ${text}` });
const refused = (text: string): LeadOutcome => ({ ok: false, text: `team-lead: ${text}` });

function installationHost(main: string): string | undefined {
  try {
    const host = (JSON.parse(readFileSync(join(main, INSTALLATION_RELATIVE), "utf8")) as { host?: unknown }).host;
    return typeof host === "string" ? host : undefined;
  } catch {
    return undefined;
  }
}

/** The architect launch adapter for the host this project was installed for. */
export async function installedArchitectHost(main: string): Promise<ArchitectHost> {
  const host = installationHost(main);
  if (host === "claude-code") return (await import("../hosts/claude-code/architect-seat.ts")).CLAUDE_ARCHITECT_HOST;
  if (host === "pi") return (await import("../hosts/pi/architect-seat.ts")).PI_ARCHITECT_HOST;
  throw new Error(`the installation names no supported host ('${String(host)}')`);
}

const git = (deps: LeadDeps, cwd: string, ...args: string[]) => deps.git(args, cwd);
const gitOut = (deps: LeadDeps, cwd: string, ...args: string[]): string | undefined => {
  const run = deps.git(args, cwd);
  return run.status === 0 ? run.stdout.trim() : undefined;
};
const tail = (text: string, lines = 30): string => text.trimEnd().split("\n").slice(-lines).join("\n");

/** The lead's own place: the main worktree of an installed project, on main. */
function leadPlace(main: string, deps: LeadDeps): string | undefined {
  if (!isProjectLocalHarness(main)) return "no project-local Bounded installation here";
  if (readTicketMarker(main) !== undefined) return "this is a ticket worktree; the lead works from the main worktree";
  const branch = gitOut(deps, main, "rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== MAIN_BRANCH) return `the lead works on ${MAIN_BRANCH}, and this worktree is on '${branch ?? "no branch"}'`;
  return undefined;
}

/** The architect's model on this host, or a refusal when the configured tier cannot run here. */
function architectModel(main: string, host: ArchitectHost): { readonly model?: string } | { readonly error: string } {
  const plan = planModelTier({ agent: "architect" }, readDevStageModels(main));
  if (plan.kind !== "inject") return {};
  const model = host.model(plan.model);
  return model === undefined
    ? { error: `${plan.key} '${plan.model}' names no model ${host.name} can run — change .bounded/dev-stage-models.json` }
    : { model };
}

function openingBrief(issue: TrackerIssue, worktree: string, main: string): string {
  return [
    `Ticket #${issue.number}: ${issue.title}`,
    "",
    `You are this ticket's architect. You run in its own worktree (${relative(main, worktree)}, branch ${ticketBranch(issue.number)}), and its run is prepared.`,
    "Load the developer-stage skill and deliver the ticket through its gates. The board follows the gates; you never touch the tracker.",
    "When you need a decision from the user, and when you finish, end your turn with your report and the decisions you need: the team lead relays them and continues this session with the answer.",
    "",
    issue.body.trim(),
  ].join("\n");
}

export async function runLeadCommand(main: string, request: LeadRequest, deps: LeadDeps): Promise<LeadOutcome> {
  const place = leadPlace(main, deps);
  if (place !== undefined) return refused(place);
  // One lead command at a time: two starts must never both pass the
  // ownership check. A lock whose owner has gone is cleared (process-lock.ts).
  const lock = acquireLock(join(main, LEAD_LOCK_RELATIVE), deps.processes ?? systemProcesses);
  if (!lock.ok) return refused(`another lead command is running (${lock.reason}); wait for it to finish`);
  try {
    return await runLocked(main, request, deps);
  } finally {
    lock.release();
  }
}

async function runLocked(main: string, request: LeadRequest, deps: LeadDeps): Promise<LeadOutcome> {
  // The escape hatch needs nothing else to work: not even the tracker.
  if (request.command === "release") return release(main, request.issue, request.force, deps);
  let tracker: Tracker;
  try {
    tracker = deps.tracker(main);
    boardReady(main, tracker);
    // A board update a gate could not make in a ticket worktree lands before
    // anything else reads the board.
    for (const worktree of ticketWorktreeDirs(main)) applyBoardOps(worktree, tracker, []);
  } catch (error) {
    return refused(trackerRefusal(error));
  }
  let outcome: LeadOutcome;
  try {
    outcome = await dispatch(main, request, deps, tracker);
  } catch (error) {
    outcome = refused(error instanceof Error && error.name === "TrackerError" ? trackerRefusal(error)
      : `${request.command} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  logGuardEvent(main, {
    guard: LEAD_GUARD, verdict: outcome.ok ? "pass" : "block", summary: outcome.text.split("\n")[0]!,
    detail: { kind: "lead-command", command: request.command, ...("issue" in request ? { issue: request.issue } : {}) },
  });
  return outcome;
}

async function dispatch(main: string, request: LeadRequest, deps: LeadDeps, tracker: Tracker): Promise<LeadOutcome> {
  switch (request.command) {
    case "ticket-create": return ticketCreate(main, request.fields, tracker);
    case "queue": return queue(main, request.issue, tracker);
    case "start": return start(main, request.issue, deps, tracker);
    case "status": return status(main, deps, tracker);
    case "reply": return reply(main, request.issue, request.message, deps, tracker);
    case "merge": return merge(main, request.issue, deps, tracker);
    case "board": return boardQuarantine(main, request.action, tracker);
    case "sync-config": return syncConfig(main, request.issue, deps, tracker);
    case "release": return release(main, request.issue, request.force, deps);

  }
}

/** The main worktree and every ticket worktree: the places board updates queue. */
const boardPlaces = (main: string): readonly string[] => [main, ...ticketWorktreeDirs(main)];

/** One line per quarantined board update, with the two ways out. */
function quarantineLines(main: string): string[] {
  const lines: string[] = [];
  for (const place of boardPlaces(main)) {
    for (const q of quarantinedOps(place)) {
      const what = q.op.op === "status" ? `set #${q.op.issue} to ${q.op.status}` : q.op.op === "comment" ? `comment on #${q.op.issue}`
        : q.op.op === "close" ? `close #${q.op.issue}` : `${q.op.op} '${q.op.label}' on #${q.op.issue}`;
      lines.push(`board update quarantined (${relative(main, place) || "main worktree"}): ${what} failed ${q.attempts} times (${q.error.slice(0, 160)}) — retry with bounded lead board retry, or drop it with bounded lead board discard`);
    }
  }
  return lines;
}

function boardQuarantine(main: string, action: "retry" | "discard", tracker: Tracker): LeadOutcome {
  let count = 0;
  for (const place of boardPlaces(main)) {
    const released = releaseQuarantine(place, action === "retry");
    count += released;
    if (action === "retry" && released > 0) {
      try {
        applyBoardOps(place, tracker, []);
      } catch (error) {
        return refused(`the retried board updates are pending again: ${trackerRefusal(error)}`);
      }
    }
  }
  const left = quarantineLines(main);
  if (count === 0) return done("no board update is quarantined");
  return done(action === "retry"
    ? `retried ${count} quarantined board update(s)${left.length > 0 ? `; ${left.length} failed again and are quarantined` : ""}`
    : `discarded ${count} quarantined board update(s); the board may need fixing by hand`);
}

/**
 * The user's escape hatch: clear all of a ticket's seat state — the
 * architect seat, background-worker blocks, a launch claim and a pending
 * reply — once its recorded processes are gone, or with `force`. Then
 * `bounded lead start` relaunches its architect into the same worktree.
 */
function release(main: string, issueNumber: number, force: boolean, deps: LeadDeps): LeadOutcome {
  const ticket = readStartedTicket(main, issueNumber);
  if (ticket === undefined) return refused(`#${issueNumber} is not started`);
  const probe = deps.processes ?? systemProcesses;
  const seat = architectStatus(ticket.worktree, probe);
  const workers = backgroundWorkers(readGuardLog(ticket.worktree), probe);
  const pending = readPendingLaunch(main);
  const claimLive = pending?.issue === issueNumber && pending.claimedBy !== undefined && !claimStale(pending, probe);
  if (!force && (seat.kind === "running" || workers.length > 0 || claimLive)) {
    const what = [
      ...(seat.kind === "running" ? [`its architect (turn ${seat.turn})`] : []),
      ...workers.map((w) => `worker ${w.worker}`),
      ...(claimLive ? ["an architect launch under way"] : []),
    ];
    return refused(`#${issueNumber} still has ${what.join(", ")} recorded as running in a live session, and the harness cannot prove ` +
      `it has stopped; if you are sure it is stuck, run bounded lead release ${issueNumber} --force`);
  }
  clearArchitectState(ticket.worktree);
  logGuardEvent(ticket.worktree, {
    guard: LEAD_GUARD, verdict: "pass", summary: `seat released by the user${force ? " (forced)" : ""}`,
    detail: { kind: SEAT_RELEASED, issue: issueNumber, force },
  });
  if (pending?.issue === issueNumber) clearPendingLaunch(main);
  clearPendingReply(main, issueNumber);
  logGuardEvent(main, {
    guard: LEAD_GUARD, verdict: "pass", summary: `team-lead: the user released #${issueNumber}'s seat${force ? " (forced)" : ""}`,
    detail: { kind: SEAT_RELEASED, issue: issueNumber, force, seat: seat.kind, workers: workers.map((w) => w.worker) },
  });
  return done(`#${issueNumber}'s seat is released; the lead relaunches its architect with bounded lead start ${issueNumber}`);
}

/** Whether the worktree still holds exactly what its deliver gate passed on. */
function deliveredTreeIntact(worktree: string): boolean {
  const delivered = readDeliverySnapshot(worktree);
  if (delivered === undefined) return false;
  try {
    const now = worktreeSnapshot(worktree);
    return now.tree === delivered.tree && now.index === delivered.index;
  } catch {
    return false;
  }
}

/** Apply board updates; a failure leaves them pending and says so. */
function board(main: string, tracker: Tracker, ops: readonly BoardOp[]): string | undefined {
  try {
    applyBoardOps(main, tracker, ops);
    return undefined;
  } catch (error) {
    return `the board update is pending: ${trackerRefusal(error)}`;
  }
}

function ticketCreate(main: string, fields: TicketFields, tracker: Tracker): LeadOutcome {
  for (const dependency of fields.depends) {
    const dep = tracker.viewIssue(dependency);
    if (dep.state !== "open" && !dep.labels.includes(HANDOFF_PUBLISHED_LABEL)) {
      return refused(`dependency #${dependency} is closed without a published handoff; name an open ticket`);
    }
  }
  const created = tracker.createIssue(fields.title, renderTicketBody(fields));
  const pending = board(main, tracker, [{ op: "status", issue: created.number, status: "Backlog" }]);
  return pending === undefined ? done(`created #${created.number} (${created.url}) in Backlog`)
    : refused(`created #${created.number} (${created.url}), but ${pending}`);
}

function queue(main: string, issueNumber: number, tracker: Tracker): LeadOutcome {
  const issue = tracker.viewIssue(issueNumber);
  if (issue.state !== "open") return refused(`#${issueNumber} is closed`);
  if (issue.status !== "Backlog") return refused(`#${issueNumber} is ${issue.status ?? "not on the board"}, not Backlog`);
  const body = parseTicketBody(issue.body);
  if (!body.ok) return refused(`#${issueNumber}: ${body.reason}`);
  const waiting: number[] = [];
  for (const dependency of body.depends) {
    const dep = tracker.viewIssue(dependency);
    if (dep.state === "open" && !dep.labels.includes(HANDOFF_PUBLISHED_LABEL)) waiting.push(dependency);
  }
  const ops: BoardOp[] = [
    ...waiting.map((n): BoardOp => ({ op: "add-label", issue: issueNumber, label: waitingLabel(n) })),
    { op: "status", issue: issueNumber, status: "Queued" },
  ];
  const pending = board(main, tracker, ops);
  const note = waiting.length > 0 ? `, waiting on ${waiting.map((n) => `#${n}`).join(", ")}` : "";
  return pending === undefined ? done(`#${issueNumber} queued${note}`) : refused(`#${issueNumber}: ${pending}`);
}

/**
 * `start` is a sequence of steps, each skipped when already done, so a start
 * that a crash interrupted is finished by running it again. The record is
 * written first (phase "starting"), inside the lead's lock, so a second
 * ticket's ownership check always sees this one.
 */
async function start(main: string, issueNumber: number, deps: LeadDeps, tracker: Tracker): Promise<LeadOutcome> {
  const issue = tracker.viewIssue(issueNumber);
  if (issue.state !== "open") return refused(`#${issueNumber} is closed`);
  const worktree = ticketWorktreePath(main, issueNumber);
  const record = readStartedTicket(main, issueNumber);
  const pending = readPendingLaunch(main);
  if (pending !== undefined && pending.issue !== issueNumber) {
    return refused(`#${pending.issue} is waiting for its architect; start that one first, then this ticket`);
  }
  if (record?.phase !== "starting" && record !== undefined) {
    if (pending?.issue === issueNumber) {
      const host = await deps.host(main);
      if (pending.claimedBy !== undefined && !claimStale(pending, deps.processes ?? systemProcesses)) {
        return refused(`#${issueNumber}'s architect launch is under way; wait for it to bind, or for its claim to go stale`);
      }
      // A claim that never bound (its session gone, or too old) is released here.
      releaseLaunchClaim(main);
      return done(`#${issueNumber} is waiting for its architect. ${host.launchInstruction(pending)}`);
    }
    // A seat whose session has gone cannot be continued (a host continues a
    // subagent only in the session that started it): launch a fresh architect
    // into the same worktree, ticket and branch.
    const seat = architectStatus(worktree, deps.processes ?? systemProcesses);
    if (seatNeedsRelaunch(seat)) {
      const host = await deps.host(main);
      const unsafe = host.preflight(worktree);
      if (unsafe !== undefined) return refused(`#${issueNumber}'s architect was not relaunched, because its gate would not hold: ${unsafe}`);
      const model = architectModel(main, host);
      if ("error" in model) return refused(model.error);
      const launch = {
        issue: issueNumber, worktree, createdAt: new Date().toISOString(), ...model,
        brief: `${openingBrief(issue, worktree, main)}\n\nResuming: this ticket's earlier architect stopped with its session. Its worktree, design note and guard log hold the work so far; read them, then carry on from there.`,
      };
      writePendingLaunch(main, launch);
      return done(`#${issueNumber}'s architect will be relaunched in its existing worktree. ${host.launchInstruction(launch)}`);
    }
    return refused(seat.kind === "running"
      ? `#${issueNumber}'s architect is still running; check it with bounded lead status`
      : `#${issueNumber}'s architect has stopped; continue it with bounded lead reply ${issueNumber} <message>`);
  }
  // Resuming: the record says a start began, or the board and the worktree
  // show one that left no record.
  const resuming = record !== undefined || (issue.status === "In Design" && existsSync(worktree));
  if (!resuming && issue.status !== "Queued") {
    return refused(`#${issueNumber} is ${issue.status ?? "not on the board"}; only a Queued ticket starts`);
  }
  const waiting = issue.labels.filter((l) => l.startsWith(WAITING_LABEL_PREFIX));
  if (waiting.length > 0) return refused(`#${issueNumber} is still ${waiting.join(", ")}: its dependency's design handoff is not published`);
  const body = parseTicketBody(issue.body);
  if (!body.ok) return refused(`#${issueNumber}: ${body.reason}`);
  if (!resuming && existsSync(worktree)) return refused(`#${issueNumber} already has a worktree at ${relative(main, worktree)}`);
  for (const other of startedTickets(main)) {
    if (other.issue === issueNumber) continue;
    const conflict = ownershipConflict(body.owns, other.owns);
    if (conflict !== undefined) {
      return refused(`#${issueNumber} owns '${conflict[0]}', which overlaps '${conflict[1]}' owned by started ticket #${other.issue}; two parallel tickets may not own the same contract path`);
    }
  }
  let host: ArchitectHost;
  try {
    host = await deps.host(main);
  } catch (error) {
    return refused(error instanceof Error ? error.message : String(error));
  }
  const model = architectModel(main, host);
  if ("error" in model) return refused(model.error);

  const branch = ticketBranch(issueNumber);
  const started: StartedTicket = {
    phase: "starting", issue: issueNumber, title: issue.title, branch, worktree, owns: body.owns, startedAt: record?.startedAt ?? new Date().toISOString(),
  };
  writeStartedTicket(main, started);
  const rollback = (why: string): LeadOutcome => {
    if (resuming) {
      return refused(`#${issueNumber} is not started yet — ${why}; fix that and run bounded lead start ${issueNumber} again to finish it`);
    }
    git(deps, main, "worktree", "remove", "--force", worktree);
    git(deps, main, "branch", "-D", branch);
    removeStartedTicket(main, issueNumber);
    return refused(`#${issueNumber} not started — ${why}; its worktree and branch were removed`);
  };

  if (!existsSync(worktree)) {
    const hasBranch = gitOut(deps, main, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`) !== undefined;
    const added = hasBranch
      ? git(deps, main, "worktree", "add", worktree, branch)
      : git(deps, main, "worktree", "add", "-b", branch, worktree, MAIN_BRANCH);
    if (added.status !== 0) {
      removeStartedTicket(main, issueNumber);
      return refused(`git could not create the ticket worktree: ${tail(added.stderr, 5)}`);
    }
  }
  writeTicketMarker(worktree, { issue: issueNumber, branch, main, owns: body.owns });
  if (!(deps.ready ?? dependenciesReady)(worktree)) {
    const setup = await deps.setup(worktree);
    if (!setup.ok) return rollback(setup.summary);
  }
  if (preparedTicket(worktree) !== String(issueNumber)) {
    const prepared = prepareLeadRun(worktree, String(issueNumber));
    if (!prepared.ok) return rollback(prepared.reason);
  }
  if (issue.status !== "In Design") {
    try {
      tracker.setStatus(issueNumber, "In Design");
    } catch (error) {
      return rollback(trackerRefusal(error));
    }
  }
  // The architect is the host's own subagent: the core leaves one pending
  // launch, and the host adapter binds the next architect launch to it.
  const unsafe = host.preflight(worktree);
  if (unsafe !== undefined) {
    const back = resuming ? undefined : board(main, tracker, [{ op: "status", issue: issueNumber, status: "Queued" }]);
    const out = rollback(`its architect's gate would not hold: ${unsafe}`);
    return back === undefined ? out : refused(`${out.text}; ${back}`);
  }
  let instruction = "";
  if (architectStatus(worktree, deps.processes ?? systemProcesses).kind === "none") {
    const launch = { issue: issueNumber, worktree, brief: openingBrief(issue, worktree, main), ...model, createdAt: new Date().toISOString() };
    writePendingLaunch(main, launch);
    instruction = ` ${host.launchInstruction(launch)}`;
  }
  writeStartedTicket(main, { ...started, phase: "started" });
  return done(`#${issueNumber} ${resuming ? "start finished" : "started"} in ${relative(main, worktree)} on ${branch}. It is In Design.${instruction}`);
}

async function status(main: string, deps: LeadDeps, tracker: Tracker): Promise<LeadOutcome> {
  const started = startedTickets(main);
  const quarantined = quarantineLines(main);
  if (started.length === 0) return done(["no ticket is started", ...quarantined].join("\n"));
  const lines: string[] = [...quarantined];
  for (const ticket of started) {
    const issue = tracker.viewIssue(ticket.issue);
    if (ticket.phase === "starting") {
      lines.push(`#${ticket.issue} ${issue.title} — its start did not finish; run bounded lead start ${ticket.issue} to finish it`);
      continue;
    }
    const labels = issue.labels.filter((l) => l.startsWith("blocked: ") || l.startsWith(WAITING_LABEL_PREFIX));
    lines.push(`#${ticket.issue} ${issue.title} — ${issue.status ?? "not on the board"}${labels.length > 0 ? ` (${labels.join(", ")})` : ""}`);
    if (issue.status === "Awaiting Merge" && !deliveredTreeIntact(ticket.worktree)) {
      lines.push(`  the worktree changed after delivery; its architect must rerun deliver (bounded lead reply ${ticket.issue} <message>)`);
    }
    const architect = architectStatus(ticket.worktree, deps.processes ?? systemProcesses);
    const pending = readPendingLaunch(main);
    switch (architect.kind) {
      case "none":
        lines.push(pending?.issue !== ticket.issue ? "  architect: never launched"
          : pending.claimedBy !== undefined && claimStale(pending, deps.processes ?? systemProcesses)
            ? `  architect: its launch never bound to the worktree; run bounded lead start ${ticket.issue} to launch it again`
            : pending.claimedBy !== undefined ? "  architect: launch under way"
            : `  architect: waiting to be launched — ${(await deps.host(main)).launchInstruction(pending)}`);
        break;
      case "running":
        lines.push(`  architect: running turn ${architect.turn} since ${architect.since}` +
          (architect.unrecognised === true ? " (its session could not be recognised, so it counts as running until its stop is recorded or the user releases it)" : ""));
        break;
      case "ended":
        lines.push(architect.sessionGone
          ? `  architect: turn ${architect.turn} stopped, and its session has ended; relaunch it with bounded lead start ${ticket.issue}`
          : `  architect: turn ${architect.turn} stopped and reported to you; continue it with bounded lead reply ${ticket.issue} <message>`);
        break;
      case "lost":
        lines.push(`  architect: turn ${architect.turn} ended with its session; relaunch it with bounded lead start ${ticket.issue}`);
        break;
    }
    for (const w of backgroundWorkers(readGuardLog(ticket.worktree), deps.processes ?? systemProcesses)) {
      lines.push(`  gates held: worker ${w.worker} resumed in the background at ${w.since} and has no recorded stop` +
        (w.unrecognised === true ? " (its session could not be recognised, so the hold stays until its stop is recorded or the user releases it)" : ""));
    }
    if (architect.kind === "lost" || (architect.kind === "ended" && architect.sessionGone) ||
        (architect.kind === "running" && architect.unrecognised === true) ||
        backgroundWorkers(readGuardLog(ticket.worktree), deps.processes ?? systemProcesses).length > 0 ||
        (pending?.issue === ticket.issue && pending.claimedBy !== undefined)) {
      lines.push(`  if it stays stuck, the user (not the lead) can clear its seat with bounded lead release ${ticket.issue}: ` +
        "the harness cannot prove its session is gone, so clearing it is the user's call");
    }
  }
  return done(`started tickets:\n${lines.join("\n")}`);
}

async function reply(main: string, issueNumber: number, message: string, deps: LeadDeps, tracker: Tracker): Promise<LeadOutcome> {
  const ticket = readStartedTicket(main, issueNumber);
  if (ticket === undefined) return refused(`#${issueNumber} is not started; start it first`);
  if (ticket.phase === "starting") return refused(`#${issueNumber}'s start did not finish; run bounded lead start ${issueNumber} first`);
  const issue = tracker.viewIssue(issueNumber);
  if (issue.state !== "open") return refused(`#${issueNumber} is closed`);
  if (flagLike(message)) return refused("a reply may not begin with '-'; reword it");
  let host: ArchitectHost;
  try {
    host = await deps.host(main);
  } catch (error) {
    return refused(error instanceof Error ? error.message : String(error));
  }
  const architect = architectStatus(ticket.worktree, deps.processes ?? systemProcesses);
  if (architect.kind === "none") return refused(`#${issueNumber}'s architect was never launched; launch it as bounded lead start ${issueNumber} says`);
  if (architect.kind === "running") return refused(`#${issueNumber}'s architect is still running; one architect turn runs per worktree`);
  if (seatNeedsRelaunch(architect)) {
    return refused(`#${issueNumber}'s architect ran in a session that has ended, and cannot be continued; relaunch it with bounded lead start ${issueNumber}`);
  }
  const unsafe = host.preflight(ticket.worktree);
  if (unsafe !== undefined) return refused(`#${issueNumber}'s architect was not continued, because its gate would not hold: ${unsafe}`);
  // A reply to a delivered ticket reopens it: the architect may change the
  // tree, so the delivery no longer stands until deliver passes again.
  const reopen = issue.status === "Awaiting Merge";
  if (reopen) {
    const pending = board(main, tracker, [{ op: "status", issue: issueNumber, status: "Building" }]);
    if (pending !== undefined) return refused(`#${issueNumber} was not reopened: ${pending}`);
    clearDeliverySnapshot(ticket.worktree);
  }
  const pendingReply = { issue: issueNumber, worktree: ticket.worktree, agent: architect.agent, message, createdAt: new Date().toISOString() };
  writePendingReply(main, pendingReply);
  return done(`#${issueNumber}'s reply is ready${reopen ? "; the ticket is reopened to Building until deliver passes again" : ""}. ${host.replyInstruction(pendingReply)}`);
}

/**
 * Bring the local main level with the fetched remote, or say why not: a
 * clean main that is strictly behind is fast-forwarded (`--ff-only`); a main
 * holding commits the remote lacks is refused in product terms (issue #55
 * tracks combining them). Undefined when main is level.
 */
function bringLevel(main: string, deps: LeadDeps): string | undefined {
  const local = gitOut(deps, main, "rev-parse", MAIN_BRANCH);
  const remote = gitOut(deps, main, "rev-parse", `${REMOTE}/${MAIN_BRANCH}`);
  if (local === undefined || remote === undefined) return `${MAIN_BRANCH} or ${REMOTE}/${MAIN_BRANCH} cannot be read`;
  if (local === remote) return undefined;
  if (git(deps, main, "merge-base", "--is-ancestor", local, remote).status !== 0) {
    return `the main line holds work the harness did not make, and the harness cannot combine it safely with ${REMOTE}/${MAIN_BRANCH}; ` +
      "this is a harness gap (#55), and nothing was merged";
  }
  const forwarded = git(deps, main, "merge", "--ff-only", `${REMOTE}/${MAIN_BRANCH}`);
  if (forwarded.status !== 0) return `${MAIN_BRANCH} could not be brought level with ${REMOTE}/${MAIN_BRANCH}: ${tail(`${forwarded.stdout}${forwarded.stderr}`, 5)}`;
  return undefined;
}

/**
 * Restore a started ticket's generated config in its own worktree (ADR
 * 2026-072), the lead's step once the user agrees: never while its architect
 * or a background worker may still change that tree. A delivered ticket is
 * reopened to Building first, as a reply does, because the sync may change
 * what deliver passed on.
 */
async function syncConfig(main: string, issueNumber: number, deps: LeadDeps, tracker: Tracker): Promise<LeadOutcome> {
  const ticket = readStartedTicket(main, issueNumber);
  if (ticket === undefined) return refused(`#${issueNumber} is not started; its config lives in its worktree, which start creates`);
  if (ticket.phase === "starting") return refused(`#${issueNumber}'s start did not finish; run bounded lead start ${issueNumber} first`);
  const probe = deps.processes ?? systemProcesses;
  const architect = architectStatus(ticket.worktree, probe);
  if (architect.kind === "running") return refused(`#${issueNumber}'s architect is still running; restore its config once its turn stops`);
  const held = backgroundWorkers(readGuardLog(ticket.worktree), probe);
  if (held.length > 0) {
    return refused(`#${issueNumber} still has ${held.map((w) => `worker ${w.worker}`).join(", ")} running in the background; restore its config once it stops`);
  }
  const issue = tracker.viewIssue(issueNumber);
  if (issue.state !== "open") return refused(`#${issueNumber} is closed`);
  const reopen = issue.status === "Awaiting Merge";
  if (reopen) {
    const pending = board(main, tracker, [{ op: "status", issue: issueNumber, status: "Building" }]);
    if (pending !== undefined) return refused(`#${issueNumber} was not reopened, so its config was not restored: ${pending}`);
    clearDeliverySnapshot(ticket.worktree);
  }
  const sync = deps.syncConfig ?? ((worktree: string) => syncTicketConfig(worktree, deps.packsDir ?? join(main, HARNESS_RELATIVE, "packs")));
  const result = await sync(ticket.worktree);
  const reopened = reopen ? "; the ticket is reopened to Building until deliver passes again" : "";
  if (!result.ok) return refused(`#${issueNumber}'s generated config was not restored${reopened}:\n${tail(result.output)}`);
  return done(`#${issueNumber}'s generated config is restored in ${relative(main, ticket.worktree)}${reopened}:\n${tail(result.output)}`);
}

async function merge(main: string, issueNumber: number, deps: LeadDeps, tracker: Tracker): Promise<LeadOutcome> {
  const ticket = readStartedTicket(main, issueNumber);
  if (ticket === undefined) return refused(`#${issueNumber} is not started`);
  if (ticket.phase === "starting") return refused(`#${issueNumber}'s start did not finish; run bounded lead start ${issueNumber} first`);
  const architect = architectStatus(ticket.worktree, deps.processes ?? systemProcesses);
  if (architect.kind === "running") return refused(`#${issueNumber}'s architect is still running`);
  // A worker resumed in the background may still change the tree being merged.
  const held = backgroundWorkers(readGuardLog(ticket.worktree), deps.processes ?? systemProcesses);
  if (held.length > 0) {
    return refused(`#${issueNumber} still has ${held.map((w) => `worker ${w.worker}`).join(", ")} running in the background; merge waits for its stop`);
  }
  const issue = tracker.viewIssue(issueNumber);
  if (issue.status !== "Awaiting Merge") return refused(`#${issueNumber} is ${issue.status ?? "not on the board"}; only a ticket whose deliver gate passed merges`);
  const log = readRunLog(ticket.worktree);
  if (log.kind !== "read" || log.state !== "delivered") return refused(`#${issueNumber}'s worktree records no final delivery`);
  const delivered = readDeliverySnapshot(ticket.worktree);
  if (delivered === undefined) return refused(`#${issueNumber}'s worktree records no delivered tree; rerun deliver`);
  if (!deliveredTreeIntact(ticket.worktree)) return refused(`#${issueNumber}: the worktree changed after delivery; rerun deliver`);

  if ((gitOut(deps, main, "status", "--porcelain") ?? "x") !== "") return refused(`${MAIN_BRANCH} has uncommitted changes; it must be clean to merge`);
  const fetched = git(deps, main, "fetch", REMOTE, MAIN_BRANCH);
  if (fetched.status !== 0) return refused(`git fetch failed: ${tail(fetched.stderr, 5)}`);
  const level = bringLevel(main, deps);
  if (level !== undefined) return refused(level);
  // Re-read after the fast-forward: an undo returns here, not to the
  // pre-fetch commit (ADR 2026-072).
  const local = gitOut(deps, main, "rev-parse", MAIN_BRANCH);
  if (local === undefined) return refused(`${MAIN_BRANCH} cannot be read`);

  if ((gitOut(deps, ticket.worktree, "status", "--porcelain") ?? "") !== "") {
    if (git(deps, ticket.worktree, "add", "-A").status !== 0) return refused(`could not stage #${issueNumber}'s delivered work`);
    const committed = git(deps, ticket.worktree, "commit", "-q", "-m", `#${issueNumber}: ${issue.title}`);
    if (committed.status !== 0) return refused(`could not commit #${issueNumber}'s delivered work: ${tail(committed.stderr, 5)}`);
  }
  if (gitOut(deps, ticket.worktree, "rev-parse", "HEAD^{tree}") !== delivered.tree) {
    return refused(`#${issueNumber}: the branch does not hold the delivered tree; rerun deliver`);
  }

  const merged = git(deps, main, "merge", "--no-ff", "--no-edit", "-m", `Merge #${issueNumber}: ${issue.title}`, ticket.branch);
  if (merged.status !== 0) {
    git(deps, main, "merge", "--abort");
    return refused(`#${issueNumber} does not merge cleanly into ${MAIN_BRANCH}; the merge was aborted: ${tail(`${merged.stdout}${merged.stderr}`, 8)}`);
  }
  const undo = (why: string): LeadOutcome => {
    git(deps, main, "reset", "--hard", local);
    return refused(`${why}; the merge was undone and ${MAIN_BRANCH} is back at ${local.slice(0, 12)}`);
  };
  const check = deps.check(main);
  if (!check.ok) return undo(`the project check failed on ${MAIN_BRANCH} after merging #${issueNumber}:\n${tail(check.output)}`);
  const pushed = git(deps, main, "push", REMOTE, `${MAIN_BRANCH}:${MAIN_BRANCH}`);
  if (pushed.status !== 0) return undo(`pushing ${MAIN_BRANCH} was refused: ${tail(pushed.stderr, 5)}`);

  const pending = board(main, tracker, [
    { op: "status", issue: issueNumber, status: "Done" },
    { op: "close", issue: issueNumber },
  ]);
  const cleanup: string[] = [];
  if (git(deps, main, "worktree", "remove", "--force", ticket.worktree).status !== 0) cleanup.push("its worktree could not be removed");
  if (git(deps, main, "branch", "-d", ticket.branch).status !== 0) cleanup.push(`branch ${ticket.branch} could not be deleted`);
  removeStartedTicket(main, issueNumber);
  const extra = cleanup.length > 0 ? ` (${cleanup.join("; ")})` : "";
  return pending === undefined
    ? done(`#${issueNumber} merged into ${MAIN_BRANCH}, checked, pushed to ${REMOTE}/${MAIN_BRANCH} and closed as Done${extra}`)
    : refused(`#${issueNumber} merged, checked and pushed, but ${pending}${extra}`);
}
