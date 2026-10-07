// One hook call, stdin to stdout. PreToolUse: read, translate, resolve,
// decide, answer. It fails closed: whatever goes wrong is a deny, never an
// empty answer, which Claude Code would read as allow; a deny the hook makes
// itself is also recorded. PostToolUse and PostToolUseFailure (a call that
// failed, such as a command exiting 1): the finished call is checked after
// the fact, and what bounded undid, or could not check, is told to Claude.
import { type Refuse, type Result, ToolResult, Verdict } from "bounded/domain";
import { type PathResolver, type ToolUse, toToolUse } from "./event.ts";
import { isRecord } from "./json.ts";
import { type Payload, readPayload, translate } from "./translate.ts";

/** The project a decision is for. */
export interface Project {
  /** Claude Code's project root, CLAUDE_PROJECT_DIR. */
  readonly projectDir: string;
}

/** What bounded decides about one event; the core's judging is asynchronous. The composition root supplies it. */
export type Decide = (event: ToolUse, project: Project) => Verdict | Promise<Verdict>;

/** A refusal the hook made itself, before the core judged anything: what the project's decision log records. */
export interface AdapterRefusal {
  readonly tool: string;
  readonly reason: string;
  readonly redirect: string;
  readonly role: string | null;
  readonly input: unknown;
}

/** After a call ran: what bounded undid, to tell Claude; null when nothing. */
export type AfterTool = (result: ToolResult, project: Project) => Promise<{ readonly message: string | null }>;

/** Records a refusal the hook made itself. Its outcome never changes or delays the answer. */
export type RecordRefusal = (refusal: AdapterRefusal, project: Project) => Promise<unknown>;

export interface Hook {
  /** Claude Code's project root; the session's cwd falls back to it. */
  readonly projectDir: string;
  readonly role: string | null;
  readonly decide: Decide;
  readonly paths: PathResolver;
  /** How long decide may take before the call is denied: below Claude Code's timeout for the hook. */
  readonly deadlineMs: number;
  /** Checks a finished call; without it, PostToolUse and PostToolUseFailure answer nothing. */
  readonly afterTool?: AfterTool;
  readonly record?: RecordRefusal;
}

/** The redirect for every failure of the hook itself. */
export const FAILED = "Report this to the maintainers of bounded; the call stays refused until it is fixed";

/** A verdict as Claude Code's hook output: nothing for allow, a deny with the reason and redirect for refuse. */
export function respond(verdict: Verdict): string {
  if (verdict.kind === "allow") return "";
  const permissionDecisionReason = `${verdict.reason}\n${verdict.redirect}`;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason } });
}

/** The hook's answer to its stdin. Never rejects. */
export async function runHook(stdin: string, hook: Hook): Promise<string> {
  const event = peek(stdin, "hook_event_name");
  if (event === "PostToolUse" || event === "PostToolUseFailure") return afterToolUse(stdin, hook, event);
  const refused = (verdict: Refuse): Refuse => record(verdict, stdin, hook);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<Verdict>((settle) => {
    timer = setTimeout(
      () => settle(refused(Verdict.refuse(`bounded did not decide within ${hook.deadlineMs} ms`, "Retry the call; if it keeps timing out, report it to the maintainers of bounded"))),
      hook.deadlineMs,
    );
  });
  try {
    return respond(await Promise.race([verdictFor(stdin, hook, refused), deadline]));
  } catch (thrown) {
    return respond(refused(Verdict.refuse(`bounded's Claude Code hook failed: ${message(thrown)}`, FAILED)));
  } finally {
    clearTimeout(timer);
  }
}

async function verdictFor(stdin: string, { projectDir, role, decide, paths }: Hook, refused: (verdict: Refuse) => Refuse): Promise<Verdict> {
  const payload = readPayload(stdin);
  if (!payload.ok) return refused(payload.error);
  const event = toolUseOf(payload.value, { projectDir, role, paths });
  if (!event.ok) return refused(event.error);
  // decide may be untyped code: hold what it returns to the verdict's form.
  const verdict: Result<Verdict> = Verdict.parse(await decide(event.value, { projectDir }));
  if (!verdict.ok) throw new Error(verdict.error);
  return verdict.value;
}

/** The redirect recorded when checking a finished call fails. */
const CHECK_BY_HAND = "Check the protected files against version control";

/** What Claude Code shows Claude after a call: a block's reason after PostToolUse, added context after PostToolUseFailure (it cannot block). */
function tell(event: "PostToolUse" | "PostToolUseFailure", message: string): string {
  return event === "PostToolUse" ? JSON.stringify({ decision: "block", reason: message }) : JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: message } });
}

/** Answers a finished call: nothing when nothing was undone, else what was, or that checking failed (which is also recorded). */
async function afterToolUse(stdin: string, hook: Hook, event: "PostToolUse" | "PostToolUseFailure"): Promise<string> {
  const { afterTool, projectDir, deadlineMs } = hook;
  if (afterTool === undefined) return "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const payload = readPayload(stdin, event);
    if (!payload.ok) throw new Error(payload.error.reason);
    const use = toolUseOf(payload.value, hook);
    const response = peek(stdin, "tool_response");
    const result = ToolResult.parse({
      ...(use.ok ? use.value : { role: null, tool: "other", effects: [{ kind: "invoke", name: payload.value.tool_name }] }),
      kind: "tool-result",
      ok: event === "PostToolUse" && !(isRecord(response) && response.success === false),
      ...(payload.value.callId === undefined ? {} : { callId: payload.value.callId }),
    });
    if (!result.ok) throw new Error(result.error);
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${deadlineMs} ms`)), deadlineMs);
    });
    const checked = await Promise.race([afterTool(result.value, { projectDir }), late]);
    return checked.message === null ? "" : tell(event, checked.message);
  } catch (thrown) {
    const reason = `bounded could not check protected files after this call: ${message(thrown)}. Check them against version control.`;
    record(Verdict.refuse(reason, CHECK_BY_HAND), stdin, hook);
    return tell(event, reason);
  } finally {
    clearTimeout(timer);
  }
}

function toolUseOf(payload: Payload, { projectDir, role, paths }: Pick<Hook, "projectDir" | "role" | "paths">): Result<ToolUse, Refuse> {
  const call = translate(payload);
  if (!call.ok) return call;
  return toToolUse(call.value, { role, cwd: payload.cwd ?? projectDir, paths, ...(payload.callId === undefined ? {} : { callId: payload.callId }) });
}

/** Hands `verdict` to the hook's recorder, without waiting or letting it fail the answer, and returns it. */
function record(verdict: Refuse, stdin: string, { record, role, projectDir }: Hook): Refuse {
  if (record === undefined) return verdict;
  const tool = peek(stdin, "tool_name");
  const refusal: AdapterRefusal = { tool: typeof tool === "string" && tool !== "" ? tool : "unknown", reason: verdict.reason, redirect: verdict.redirect, role, input: peek(stdin, "tool_input") ?? null };
  Promise.resolve()
    .then(() => record(refusal, { projectDir }))
    .catch(() => {});
  return verdict;
}

/** One top-level field of the hook's input, read without trusting it; undefined when absent or unreadable. */
function peek(stdin: string, field: string): unknown {
  try {
    const raw: unknown = JSON.parse(stdin);
    return isRecord(raw) && Object.hasOwn(raw, field) ? raw[field] : undefined;
  } catch {
    return undefined;
  }
}

const message = (thrown: unknown): string => (thrown instanceof Error ? thrown.message : String(thrown));
