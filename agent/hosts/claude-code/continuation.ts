// Claude Code's half of the commission rule (ADR 2026-034; src/phase-gate.ts).
//
// The core holds the rule: a bounce goes back to the worker that already ran,
// never to a cold relaunch. On this host a finished subagent is continued with
// SendMessage, addressed to the agent id its Agent result reported. With
// background tasks disabled (install.ts) the send resumes the subagent from
// its transcript in the foreground and returns its reply as the tool result.
// The resumed subagent runs under its own definition again: Claude Code
// registers that definition's frontmatter hooks for the resumed run, so the
// role's own path-gate hook (`--role <role>`) judges every call it makes, and
// its `tools:` allowlist still holds. Verified live on Claude Code 2.1.286:
// the resumed worker kept its context, its frontmatter hook fired again with
// the same `agent_type` and `agent_id`, and the reply came back inline.
//
// SendMessage can also reach the main conversation and other Claude Code
// sessions on the machine, which would carry work out of the pipeline past
// every gate. So the architect may send only to a worker this run started,
// identified the one way the model cannot forge: the architect's own
// PostToolUse hook records each Agent result's agent id and role in the guard
// log, which no role may write.
//
// What licenses a cold relaunch here is positive evidence that the worker
// cannot be continued:
//   · a SendMessage to the role's current worker that errored or reported no
//     success;
//   · an Agent launch that failed (PostToolUseFailure) or reported a terminal
//     status other than completed;
//   · the after-call hook itself erroring on that launch, so its outcome can
//     never be known;
//   · a launch with no recorded outcome made before an architect turn whose
//     END the launch wrapper recorded in the worktree's guard log (it
//     finished, failed or was interrupted; lead-state.ts). A different id is
//     never evidence by itself. A ticket worktree runs one architect turn at
//     a time (architect-seat.ts) and no architect may start another
//     (phase-gate.ts), so the recorded end is the end of the launch's maker.
//     Within one architect a launch with no outcome is still running, which
//     is why two parallel launches of one role are refused.
// A background launch (`async_launched`) is a running worker of the role
// requested, addressed by the id it reports.
//
// Pure, apart from the shape of the guard events it reads and writes: the hook
// (path-gate-hook.ts) does the logging.

import type { LoggedGuardEvent } from "../../src/guard-log.ts";
import { CONTINUATION_CHECKED, type CommissionCall, type CommissionHost } from "../../src/phase-gate.ts";
import { asRole, PIPELINE_ROLES } from "../../src/path-gate.ts";
import { architectEndedSince } from "../../src/lead-state.ts";

/** Claude Code's tool for continuing a finished subagent. */
export const SEND_MESSAGE_TOOL = "SendMessage";
/** The Agent tool and its pre-rename name. */
export const AGENT_TOOLS: ReadonlySet<string> = new Set(["Agent", "Task"]);

/** The detail kind of the event that records an Agent result's worker. */
export const WORKER_STARTED = "worker-started";

/**
 * The field the hook puts on the core's commission input to say "this is a
 * continuation of that worker". Only this adapter writes it: the Agent tool
 * mapping (tool-map.ts) copies no field of that name, so a model cannot claim
 * a continuation through an Agent call.
 */
export const CONTINUE_WORKER_FIELD = "continueWorker";

/** An agent id as Claude Code prints it (`a` and hex, optionally dashed
 *  hex groups). SendMessage resolves a NAME before an id, so anything shaped
 *  like a name is never addressed: a peer called like a worker cannot catch it. */
const WORKER_ID = /^a[0-9a-f]{8,64}(?:-[0-9a-f]{1,64}){0,4}$/;

/** The SendMessage fields a continuation may carry. Before hooks see the
 *  input, Claude Code adds `type: "message"`, copies `to` into `recipient`,
 *  and puts a preview of `message` into `content`: on 2.1.288 the message cut
 *  to 50 characters, so `content` is not the message itself. The message
 *  text is no policy input, so `content` is accepted whatever it holds;
 *  `recipient` must still name the worker. Every other field
 *  (notify_when_idle, …) is refused by default. */
const SEND_FIELDS: ReadonlySet<string> = new Set(["to", "message", "summary", "type", "recipient", "content"]);

export type SendTarget =
  | { readonly ok: true; readonly to: string }
  | { readonly ok: false; readonly reason: string };

/** Read a SendMessage input as a plain continuation, or say why it is not one. */
export function sendTarget(input: Readonly<Record<string, unknown>>): SendTarget {
  const extra = Object.keys(input).find((key) => input[key] !== undefined && !SEND_FIELDS.has(key));
  if (extra !== undefined) {
    return { ok: false, reason: `a continuation carries only 'to' and 'message' ('${extra}' is not allowed)` };
  }
  const to = input["to"];
  const message = input["message"];
  if (typeof to !== "string" || !WORKER_ID.test(to)) {
    return { ok: false, reason: "'to' must be the agent id an Agent result reported" };
  }
  if (typeof message !== "string" || message.trim() === "") {
    return { ok: false, reason: "'message' must carry the bounce" };
  }
  if (input["recipient"] !== undefined && input["recipient"] !== to) {
    return { ok: false, reason: "'recipient' must match 'to'" };
  }
  if (input["type"] !== undefined && input["type"] !== "message") {
    return { ok: false, reason: "only a plain message continues a worker" };
  }
  return { ok: true, to };
}

const detailOf = (e: LoggedGuardEvent): Readonly<Record<string, unknown>> =>
  e.guard === "phase-gate" && typeof e.detail === "object" && e.detail !== null
    ? (e.detail as Readonly<Record<string, unknown>>)
    : {};

/** The role a recorded worker was started as, or undefined if this log never
 *  recorded that worker. */
export function workerRole(worker: string, events: readonly LoggedGuardEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const d = detailOf(events[i]!);
    if (d["kind"] === WORKER_STARTED && d["worker"] === worker && typeof d["target"] === "string") {
      return d["target"];
    }
  }
  return undefined;
}

/** Each role's current worker (see continuableWorker), as `role worker` pairs. */
export function currentWorkers(events: readonly LoggedGuardEvent[]): readonly { readonly role: string; readonly worker: string }[] {
  const out: { role: string; worker: string }[] = [];
  for (const role of PIPELINE_ROLES) {
    const worker = continuableWorker(role, events);
    if (worker !== undefined) out.push({ role, worker });
  }
  return out;
}

/**
 * The worker a bounce to `role` goes to: the one recorded after the role's
 * last launch, unless a continuation of it already failed. Undefined when
 * there is none to continue.
 */
export function continuableWorker(role: string, events: readonly LoggedGuardEvent[]): string | undefined {
  let worker: string | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const d = detailOf(events[i]!);
    if (d["kind"] === CONTINUATION_CHECKED && (d["target"] === undefined || d["target"] === role)) return undefined;
    if (d["kind"] === WORKER_STARTED && d["target"] === role && typeof d["worker"] === "string") {
      worker = d["worker"];
      break;
    }
    if (d["kind"] === "spawn" && d["target"] === role) return undefined;
  }
  return worker;
}


/** Agent-result statuses that say the launch is over and left nothing to
 *  continue. Only these, or a PostToolUseFailure, license a relaunch. */
const ENDED_STATUSES: ReadonlySet<string> = new Set([
  "failed", "error", "errored", "killed", "stopped", "cancelled", "canceled", "aborted",
]);
/** The status of a launch that went to the background and is still running. */
const RUNNING_STATUS = "async_launched";

export type LaunchOutcome =
  /** A worker of the requested role exists — finished, or still running. */
  | { readonly kind: "worker"; readonly role: string; readonly worker: string }
  /** The launch is over and left no worker to continue. */
  | { readonly kind: "ended"; readonly role: string };

/**
 * What an Agent launch of a pipeline role left behind, read from its
 * PostToolUse `tool_response`, or undefined when the result proves nothing
 * either way (then nothing is recorded, and nothing is licensed).
 */
export function launchOutcome(
  toolInput: Readonly<Record<string, unknown>>,
  response: unknown,
): LaunchOutcome | undefined {
  const asked = toolInput["subagent_type"];
  if (typeof asked !== "string" || asRole(asked) === undefined) return undefined;
  if (typeof response !== "object" || response === null) return undefined;
  const r = response as Readonly<Record<string, unknown>>;
  const worker = r["agentId"];
  const type = r["agentType"];
  const status = r["status"];
  if (typeof worker === "string" && WORKER_ID.test(worker)) {
    if (type === asked) return { kind: "worker", role: asked, worker };
    // A background launch reports its id before it has a type: a running worker.
    if (type === undefined && status === RUNNING_STATUS) return { kind: "worker", role: asked, worker };
  }
  if (typeof status === "string" && ENDED_STATUSES.has(status)) return { kind: "ended", role: asked };
  return undefined;
}

/**
 * The caller that made `role`'s last launch, when that launch has no recorded
 * outcome — no worker and no licence after it. Undefined otherwise.
 */
export function unresolvedLaunchCaller(role: string, events: readonly LoggedGuardEvent[]): string | undefined {
  return unresolvedLaunch(role, events)?.caller;
}

/** `role`'s last launch when it has no recorded outcome: its caller and its
 *  place in the log. */
function unresolvedLaunch(role: string, events: readonly LoggedGuardEvent[]): { readonly caller: string; readonly index: number } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const d = detailOf(events[i]!);
    if (d["target"] !== role) continue;
    if (d["kind"] === WORKER_STARTED || d["kind"] === CONTINUATION_CHECKED) return undefined;
    // A launch recorded with no caller cannot be told apart: no way out by caller.
    if (d["kind"] === "spawn") return typeof d["caller"] === "string" ? { caller: d["caller"], index: i } : undefined;
  }
  return undefined;
}

/**
 * May `caller` relaunch `role` whose last launch has no recorded outcome?
 * Only when an architect turn's end is recorded after that launch
 * (lead-state.ts). A ticket worktree runs one architect turn at a time
 * (architect-seat.ts) and no architect starts another, so an end recorded
 * after the stuck launch is the end of the process that made it — even when
 * the next turn continues the same session, and so carries the same caller.
 * Different ids are never evidence by themselves.
 */
export function earlierCallerEnded(role: string, _caller: string | undefined, events: readonly LoggedGuardEvent[]): boolean {
  const stuck = unresolvedLaunch(role, events);
  if (stuck === undefined) return false;
  const agent = stuck.caller.startsWith("agent:") ? stuck.caller.slice("agent:".length) : undefined;
  return architectEndedSince(events, stuck.index, agent);
}

/** Did a SendMessage's PostToolUse response report a delivered continuation? */
export function sendSucceeded(response: unknown): boolean {
  return typeof response === "object" && response !== null &&
    (response as Readonly<Record<string, unknown>>)["success"] === true;
}

function classify(input: Readonly<Record<string, unknown>>): CommissionCall {
  const worker = input[CONTINUE_WORKER_FIELD];
  if (typeof worker !== "string") return { kind: "launch" };
  const role = input["agent"];
  return { kind: "continue", run: worker, ...(typeof role === "string" ? { role } : {}) };
}

export const CLAUDE_COMMISSIONS: CommissionHost = {
  classify,
  multiSpawnFields: [],
  checkSummary: "SendMessage could not continue the worker",
  continueHow: (role, events) => {
    const worker = continuableWorker(role, events);
    const send = worker === undefined
      ? `SendMessage with \`to\` set to the agent id the ${role}'s Agent result reported and \`message\` set to the bounce`
      : `\`SendMessage\` with \`{ to: "${worker}", message: "<the bounce>" }\` — ${worker} is the ${role} that already ran`;
    return `Continue it instead: ${send}. It resumes with its context and its own role binding, and its reply comes back as the result. If SendMessage reports that it cannot be resumed, launch again and it will be allowed.`;
  },
};
