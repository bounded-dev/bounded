// Claude Code's PreToolUse payload, read and translated into host-neutral
// effects. Pure: no file system, no process. Paths stay as Claude Code gave
// them; event.ts resolves them through a port.
import { isAbsolute, join } from "node:path";
import { type Refuse, type Result, Verdict } from "bounded/domain";
import picomatch from "picomatch";
import type { Change, ToolKind } from "./event.ts";
import { isRecord } from "./json.ts";

/** The payload fields the translation reads. `cwd` is the session's directory, when absolute. */
export interface Payload {
  readonly tool_name: string;
  readonly tool_input: Readonly<Record<string, unknown>>;
  readonly cwd: string | null;
}

/** An effect with its paths still in the host's words. A Write's change depends on whether the file exists. */
export type HostEffect =
  | { readonly kind: "read"; readonly path: string }
  | { readonly kind: "list"; readonly root: string; readonly filter?: string }
  | { readonly kind: "write"; readonly path: string; readonly change: Change | "create-or-modify" }
  | { readonly kind: "execute"; readonly command: string; readonly cwd?: string }
  | { readonly kind: "fetch"; readonly url: string }
  | { readonly kind: "delegate"; readonly agent: string }
  | { readonly kind: "invoke"; readonly name: string };

export interface HostCall {
  readonly tool: ToolKind;
  readonly effects: readonly HostEffect[];
}

const ok = <T>(value: T): Result<T, Refuse> => ({ ok: true, value });
const NOT_A_CALL = "The hook's input is not a PreToolUse call: an object with tool_name and tool_input";
const REGISTRATION = "Register bounded's hook for PreToolUse only, as the install helper does";
const refuse = (tool: string, key: string, problem: string): { ok: false; error: Refuse } => ({
  ok: false,
  error: Verdict.refuse(`Claude Code's ${tool} call ${problem}`, `Retry the call with its ${key} given as text`),
});

/** The hook's stdin, or why it cannot be read. Only the fields the translation needs are kept. */
export function readPayload(stdin: string): Result<Payload, Refuse> {
  if (stdin.trim() === "") return { ok: false, error: Verdict.refuse("The hook was given no input", REGISTRATION) };
  let raw: unknown;
  try {
    raw = JSON.parse(stdin);
  } catch (thrown) {
    return { ok: false, error: Verdict.refuse(`The hook's input is not JSON: ${thrown instanceof Error ? thrown.message : String(thrown)}`, REGISTRATION) };
  }
  if (!isRecord(raw)) return { ok: false, error: Verdict.refuse(NOT_A_CALL, REGISTRATION) };
  const { hook_event_name: event, tool_name, tool_input, cwd } = raw;
  if (event !== undefined && event !== "PreToolUse") return { ok: false, error: Verdict.refuse(`The hook is registered for ${String(event)}; it answers only PreToolUse`, REGISTRATION) };
  if (typeof tool_name !== "string" || tool_name === "" || !isRecord(tool_input)) return { ok: false, error: Verdict.refuse(NOT_A_CALL, REGISTRATION) };
  return ok({ tool_name, tool_input, cwd: typeof cwd === "string" && cwd.startsWith("/") ? cwd : null });
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
    case "Agent":
    case "Task": {
      const agent = optional("subagent_type");
      return agent.ok ? ok({ tool: "subagent", effects: [{ kind: "delegate", agent: agent.value ?? "general-purpose" }] }) : agent;
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
 * A search of `root` limited by `filter`. A filter that is absolute or climbs
 * with '..' reaches outside its root, so its fixed part (picomatch's base) is
 * folded into the root, which is then resolved like any path. Climbing after
 * a wildcard, or in a negated filter, cannot be judged and is refused.
 */
function listing(tool: string, key: string, root: string, filter: string | undefined): Result<{ kind: "list"; root: string; filter?: string }, Refuse> {
  if (filter === undefined) return ok({ kind: "list", root });
  const { base, glob, negated } = picomatch.scan(filter);
  const climbs = (part: string): boolean => part.split("/").includes("..");
  if (!isAbsolute(base) && !climbs(base) && !climbs(glob)) return ok({ kind: "list", root, filter });
  if (negated || climbs(glob)) return refuse(tool, key, `has a ${key} that climbs with '..' where its reach cannot be judged`);
  const folded = isAbsolute(base) ? base : join(root, base);
  return ok(glob === "" ? { kind: "list", root: folded } : { kind: "list", root: folded, filter: glob });
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
