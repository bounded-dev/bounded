// Claude Code's PreToolUse (or PostToolUse, PostToolUseFailure) payload, read and translated into host-neutral
// effects. Pure: no file system, no process. Paths stay as Claude Code gave
// them; event.ts resolves them through a port.
import { isAbsolute, join } from "node:path";
import { type Change, type Refuse, type Result, type ToolKind, Verdict } from "bounded/domain";
import picomatch from "picomatch";
import { isRecord } from "./json.ts";

/** The payload fields the translation reads. `cwd` is the session's directory, when absolute. */
export interface Payload {
  readonly tool_name: string;
  readonly tool_input: Readonly<Record<string, unknown>>;
  readonly cwd: string | null;
  /** Claude Code's tool_use_id, when it gives one: the id that pairs this call with its result. */
  readonly callId?: string;
}

/** The hook events bounded answers. */
export type HookEvent = "PreToolUse" | "PostToolUse" | "PostToolUseFailure";

/** An effect with its paths still in the host's words. A Write's change depends on whether the file exists. */
export type HostEffect =
  | { readonly kind: "read"; readonly path: string }
  | { readonly kind: "list"; readonly root: string; readonly filter?: string }
  | { readonly kind: "write"; readonly path: string; readonly change: Change | "create-or-modify" }
  | { readonly kind: "execute"; readonly command: string; readonly cwd?: string }
  | { readonly kind: "fetch"; readonly url: string }
  | { readonly kind: "delegate"; readonly agent: string; readonly isolated?: true; readonly finishUnreported?: true }
  | { readonly kind: "invoke"; readonly name: string };

export interface HostCall {
  readonly tool: ToolKind;
  readonly effects: readonly HostEffect[];
}

const ok = <T>(value: T): Result<T, Refuse> => ({ ok: true, value });
const NOT_A_CALL = "The hook's input is not a PreToolUse call: an object with tool_name and tool_input";
const REGISTRATION = "Register bounded's hook for PreToolUse, PostToolUse and PostToolUseFailure, as the install helper does";
const refuse = (tool: string, key: string, problem: string): { ok: false; error: Refuse } => ({
  ok: false,
  error: Verdict.refuse(`Claude Code's ${tool} call ${problem}`, `Retry the call with its ${key} given as text`),
});

/** The hook's stdin for `expected`, or why it cannot be read. Only the fields the translation needs are kept. */
export function readPayload(stdin: string, expected: HookEvent = "PreToolUse"): Result<Payload, Refuse> {
  if (stdin.trim() === "") return { ok: false, error: Verdict.refuse("The hook was given no input", REGISTRATION) };
  let raw: unknown;
  try {
    raw = JSON.parse(stdin);
  } catch (thrown) {
    return { ok: false, error: Verdict.refuse(`The hook's input is not JSON: ${thrown instanceof Error ? thrown.message : String(thrown)}`, REGISTRATION) };
  }
  if (!isRecord(raw)) return { ok: false, error: Verdict.refuse(NOT_A_CALL, REGISTRATION) };
  const { hook_event_name: event, tool_name, tool_input, cwd, tool_use_id: id } = raw;
  if (event !== undefined && event !== expected) return { ok: false, error: Verdict.refuse(`The hook is registered for ${String(event)}; it answers only ${expected}`, REGISTRATION) };
  if (typeof tool_name !== "string" || tool_name === "" || !isRecord(tool_input)) return { ok: false, error: Verdict.refuse(NOT_A_CALL, REGISTRATION) };
  return ok({ tool_name, tool_input, cwd: typeof cwd === "string" && cwd.startsWith("/") ? cwd : null, ...(typeof id === "string" && id !== "" ? { callId: id } : {}) });
}

/** One Claude Code tool call as a host-neutral call, or why it cannot be checked. */
export function translate({ tool_name: name, tool_input: input }: Payload): Result<HostCall, Refuse> {
  // A field the tool needs, as text: missing or blank, there is nothing to check.
  const required = (key: string): Result<string, Refuse> => {
    const value = input[key];
    return typeof value === "string" && value.trim() !== "" ? ok(value) : refuse(name, key, `has no ${key} to check`);
  };
  // A field the tool may leave out; given, it must be text.
  const optional = (key: string): Result<string | undefined, Refuse> => {
    const value = input[key];
    if (value === undefined) return ok(undefined);
    return typeof value === "string" && value.trim() !== "" ? ok(value) : refuse(name, key, `has a ${key} that is not text`);
  };
  const one = (tool: ToolKind, key: string, effect: (value: string) => HostEffect): Result<HostCall, Refuse> => {
    const value = required(key);
    return value.ok ? ok({ tool, effects: [effect(value.value)] }) : value;
  };

  switch (name) {
    case "Read":
      return one("read", "file_path", (path) => ({ kind: "read", path }));
    case "NotebookRead":
      return one("read", "notebook_path", (path) => ({ kind: "read", path }));
    // A Write, or an Edit with an empty old_string, creates a missing file.
    case "Write":
      return one("write", "file_path", (path) => ({ kind: "write", path, change: "create-or-modify" }));
    case "Edit":
      return one("edit", "file_path", (path) => ({ kind: "write", path, change: "create-or-modify" }));
    case "NotebookEdit":
      return one("edit", "notebook_path", (path) => ({ kind: "write", path, change: "modify" }));
    case "MultiEdit":
      return multiEdit(input);
    case "LS":
      return one("search", "path", (root) => ({ kind: "list", root }));
    // Glob and Grep search the session's directory when given no path: '.' resolves against it.
    case "Glob":
    case "Grep": {
      const [path, key] = [optional("path"), name === "Glob" ? "pattern" : "glob"];
      if (!path.ok) return path;
      const filter = optional(key);
      if (!filter.ok) return filter;
      const list = listing(name, key, path.value ?? ".", filter.value);
      if (!list.ok) return list;
      // Grep reads the files it searches; its regex is not an effect.
      return ok({ tool: "search", effects: name === "Glob" ? [list.value] : [list.value, { kind: "read", path: list.value.root }] });
    }
    // Tools that run a shell command, in the session's directory.
    case "Bash":
    case "PowerShell":
    case "Monitor":
      return one("shell", "command", (command) => ({ kind: "execute", command, cwd: "." }));
    // Task is the Agent tool's earlier name; Claude Code's default agent is general-purpose.
    // What the call says about the run it starts (ADR 2026-019): isolation in a worktree makes it
    // isolated; a teammate spawn (a name, without isolation) is a run whose finish is not reported.
    // run_in_background is not read: in fork mode it does not say what happens.
    case "Agent":
    case "Task": {
      const agent = optional("subagent_type");
      if (!agent.ok) return agent;
      const isolation = input.isolation;
      if (isolation !== undefined && isolation !== "worktree") {
        return { ok: false, error: Verdict.refuse(`Claude Code's ${name} call has an isolation bounded does not translate: only 'worktree' is known`, "Retry the call with isolation 'worktree', or without isolation") };
      }
      const flags = isolation === "worktree" ? { isolated: true as const } : input.name !== undefined ? { finishUnreported: true as const } : {};
      return ok({ tool: "subagent", effects: [{ kind: "delegate", agent: agent.value ?? "general-purpose", ...flags }] });
    }
    case "WebFetch":
      return one("web", "url", (url) => ({ kind: "fetch", url }));
    // Tools whose effects cannot be described are an invoke of the tool by name:
    // a search names no URL to fetch, and an unknown tool's effects are unknown.
    // Never an execute, which is strictly a shell command.
    case "WebSearch":
      return ok({ tool: "web", effects: [{ kind: "invoke", name }] });
    default:
      return ok({ tool: "other", effects: [{ kind: "invoke", name }] });
  }
}

/**
 * Whether an Agent (or Task) call's tool_response says the agent's run
 * finished: only `status: "completed"` with `harnessNoteCount` a number equal
 * to 0. A run stopped at its turn limit also says completed, with a harness
 * note; a background run returns at launch (`async_launched`). Anything else,
 * known or not, is not finished: only a run seen to end counts.
 */
export function agentRunFinished(response: unknown): boolean {
  return isRecord(response) && response.status === "completed" && typeof response.harnessNoteCount === "number" && response.harnessNoteCount === 0;
}

/**
 * A search of `root` limited by `filter`. A filter that is absolute or climbs
 * with '..' reaches outside its root, so its fixed part (picomatch's base) is
 * folded into the root, which is then resolved like any path. Whatever cannot
 * be judged that way is refused, conservatively: an escape, a '/' inside a
 * brace or extglob group, a character class that can match '.', '..' anywhere
 * in the part that is a pattern, or a negated filter that climbs.
 */
function listing(tool: string, key: string, root: string, filter: string | undefined): Result<{ kind: "list"; root: string; filter?: string }, Refuse> {
  if (filter === undefined) return ok({ kind: "list", root });
  const hidden = hiddenReach(filter);
  if (hidden !== null) return refuse(tool, key, `has a ${key} with ${hidden}, so its reach cannot be judged`);
  const { base, glob, negated } = picomatch.scan(filter);
  const climbs = base.split("/").includes("..");
  if (glob.includes("..") || (negated && (climbs || isAbsolute(base)))) return refuse(tool, key, `has a ${key} that climbs with '..' where its reach cannot be judged`);
  if (!isAbsolute(base) && !climbs) return ok({ kind: "list", root, filter });
  const folded = isAbsolute(base) ? base : join(root, base);
  return ok(glob === "" ? { kind: "list", root: folded } : { kind: "list", root: folded, filter: glob });
}

/** Glob syntax that could hide a climb or an absolute path, named; null when there is none. */
function hiddenReach(filter: string): string | null {
  if (filter.includes("\\")) return "an escape ('\\')";
  let depth = 0;
  for (const char of filter) {
    if (char === "{" || char === "(") depth++;
    else if ((char === "}" || char === ")") && depth > 0) depth--;
    else if (char === "/" && depth > 0) return "a '/' inside a group";
  }
  for (const [, inner = ""] of filter.matchAll(/\[([^\]]*)\]/g)) {
    const ranges = [...inner.matchAll(/(.)-(.)/g)].some(([, from = "", to = ""]) => from <= "." && "." <= to);
    if (inner.includes(".") || /^[!^]/.test(inner) || inner.includes("[:") || ranges) return "a character class that can match '.'";
  }
  return null;
}

/** MultiEdit edits its file_path and any path an edit names itself, each once; each may create. */
function multiEdit(input: Readonly<Record<string, unknown>>): Result<HostCall, Refuse> {
  const paths = new Set<string>();
  const text = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
  if (input.file_path !== undefined && !text(input.file_path)) return refuse("MultiEdit", "file_path", "has no file_path to check");
  if (text(input.file_path)) paths.add(input.file_path);
  for (const edit of Array.isArray(input.edits) ? input.edits : []) {
    const path: unknown = isRecord(edit) ? edit.file_path : undefined;
    if (path === undefined) continue;
    if (!text(path)) return refuse("MultiEdit", "file_path", "has an edit whose file_path is not text");
    paths.add(path);
  }
  if (paths.size === 0) return refuse("MultiEdit", "file_path", "has no file_path to check");
  return ok({ tool: "edit", effects: [...paths].map((path): HostEffect => ({ kind: "write", path, change: "create-or-modify" })) });
}
