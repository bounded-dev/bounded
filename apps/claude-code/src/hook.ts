// One PreToolUse call, stdin to stdout: read, translate, resolve, decide,
// answer. It fails closed: whatever goes wrong is a deny, never an empty
// answer, which Claude Code would read as allow.
import { type Result, Verdict } from "bounded/domain";
import { type PathResolver, type ToolUse, toToolUse } from "./event.ts";
import { readPayload, translate } from "./translate.ts";

/** What bounded decides about one event. The composition root supplies it. */
export type Decide = (event: ToolUse) => Verdict;

export interface Hook {
  /** Claude Code's project root; the session's cwd falls back to it. */
  readonly projectDir: string;
  readonly role: string | null;
  readonly decide: Decide;
  readonly paths: PathResolver;
}

const FAILED = "Report this to the maintainers of bounded; the call stays refused until it is fixed";

/** A verdict as Claude Code's hook output: nothing for allow, a deny with the reason and redirect for refuse. */
export function respond(verdict: Verdict): string {
  if (verdict.kind === "allow") return "";
  const permissionDecisionReason = `${verdict.reason}\n${verdict.redirect}`;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason } });
}

/** The hook's answer to its stdin. Never throws. */
export function runHook(stdin: string, hook: Hook): string {
  try {
    return respond(verdictFor(stdin, hook));
  } catch (thrown) {
    return respond(Verdict.refuse(`bounded's Claude Code hook failed: ${thrown instanceof Error ? thrown.message : String(thrown)}`, FAILED));
  }
}

function verdictFor(stdin: string, { projectDir, role, decide, paths }: Hook): Verdict {
  const payload = readPayload(stdin);
  if (!payload.ok) return payload.error;
  const call = translate(payload.value);
  if (!call.ok) return call.error;
  const event = toToolUse(call.value, { role, cwd: payload.value.cwd ?? projectDir, paths });
  if (!event.ok) return event.error;
  // decide may be untyped code: hold what it returns to the verdict's form.
  const verdict: Result<Verdict> = Verdict.parse(decide(event.value));
  if (!verdict.ok) throw new Error(verdict.error);
  return verdict.value;
}
