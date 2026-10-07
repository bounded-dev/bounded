// A pi tool call as a host-neutral tool use. Pure, given the locator: all
// file-system knowledge (rewriting, links, existence) comes through `locate`.
import type { Result } from "bounded/domain";
import { type Effect, type ToolKind, type ToolUse, toolUse } from "./event.ts";
import type { Locate, Located } from "./pi-path.ts";

/** What pi's `tool_call` event carries that the translation reads. */
export interface PiToolCall {
  readonly toolName: string;
  readonly input: unknown;
}

type Input = Readonly<Record<string, unknown>>;
type Translation = Result<{ tool: ToolKind; effects: Effect[] }>;

const done = (tool: ToolKind, ...effects: Effect[]): Translation => ({ ok: true, value: { tool, effects } });

/** Reads one call's input: own fields only, each checked, every refusal naming the tool. */
function reader(toolName: string, input: Input, cwd: string, locate: Locate) {
  const field = (name: string): unknown => (Object.hasOwn(input, name) ? input[name] : undefined);
  const text = (name: string): Result<string | undefined> => {
    const value = field(name);
    if (value === undefined) return { ok: true, value: undefined };
    return typeof value === "string" ? { ok: true, value } : { ok: false, error: `pi's ${toolName} call has a '${name}' that is not a string` };
  };
  const named = (name: string): Result<string> => {
    const value = text(name);
    if (!value.ok) return value;
    return value.value?.trim() ? { ok: true, value: value.value } : { ok: false, error: `pi's ${toolName} call names no ${name} in '${name}'` };
  };
  // A tool's own cwd parameter is where its paths start; it must be in the project too.
  const cwdArgument = text("cwd");
  const base: Result<Located | undefined> = !cwdArgument.ok ? cwdArgument : cwdArgument.value === undefined ? { ok: true, value: undefined } : locate(cwdArgument.value, cwd);
  const located = (raw: string): Result<Located> => (base.ok ? locate(raw, base.value?.absolute ?? cwd) : base);
  /** The located `path` argument, or the directory the call runs in when it has none. */
  const directory = (): Result<Located> => {
    const path = text("path");
    if (!path.ok) return path;
    return located(path.value ?? ".");
  };
  return { field, text, named, base, located, directory };
}

function translateInput(toolName: string, input: Input, cwd: string, locate: Locate): Translation {
  const read = reader(toolName, input, cwd, locate);
  if (!read.base.ok) return read.base;
  const file = (): Result<Located> => {
    const path = read.named("path");
    return path.ok ? read.located(path.value) : path;
  };
  const list = (filterField?: string): Translation => {
    const root = read.directory();
    const filter = filterField === undefined ? { ok: true as const, value: undefined } : read.text(filterField);
    if (!root.ok) return root;
    if (!filter.ok) return filter;
    const listing: Effect = filter.value?.trim() ? { kind: "list", root: root.value.path, filter: filter.value } : { kind: "list", root: root.value.path };
    return toolName === "grep" ? done("search", listing, { kind: "read", path: root.value.path }) : done("search", listing);
  };

  switch (toolName) {
    case "read": {
      const path = file();
      return path.ok ? done("read", { kind: "read", path: path.value.path }) : path;
    }
    case "write":
    case "edit": {
      const path = file();
      if (!path.ok) return path;
      const change = toolName === "write" && !path.value.exists ? "create" : "modify";
      return done(toolName, { kind: "write", path: path.value.path, change });
    }
    case "ls":
      return list();
    case "find":
      return list("pattern");
    case "grep":
      return list("glob");
    case "bash":
    case "powershell": {
      const command = read.named("command");
      return command.ok ? done("shell", { kind: "execute", command: command.value }) : command;
    }
    case "subagent":
      return delegate(toolName, read.field);
    case "web_fetch": {
      const url = read.named("url");
      return url.ok ? done("web", { kind: "fetch", url: url.value }) : url;
    }
    case "web_search":
      // A search names no URL: what it reaches is the provider's business.
      return done("web", { kind: "invoke", name: toolName });
    default:
      return other(toolName, read);
  }
}

/** pi-subagents names its agents singly, in parallel `tasks` or in a `chain`. */
function delegate(toolName: string, field: (name: string) => unknown): Translation {
  const steps = [field("tasks"), field("chain")].flatMap((list) => (Array.isArray(list) ? list : []));
  const agents = [field("agent"), ...steps.map((step) => (typeof step === "object" && step !== null && Object.hasOwn(step, "agent") ? (step as Input).agent : undefined))];
  const named = agents.filter((agent): agent is string => typeof agent === "string" && agent.trim() !== "");
  if (named.length === 0) return { ok: false, error: `pi's ${toolName} call names no agent` };
  return done("subagent", ...named.map((agent): Effect => ({ kind: "delegate", agent })));
}

/**
 * A tool the adapter does not know is invoked by name, so a guard can allow
 * or refuse it by name, and writes its `path` if it names one: an unknown
 * tool is assumed to change what it points at.
 */
function other(toolName: string, read: ReturnType<typeof reader>): Translation {
  const path = read.text("path");
  if (!path.ok) return path;
  const invoke: Effect = { kind: "invoke", name: toolName };
  if (path.value === undefined) return done("other", invoke);
  const located = read.located(path.value);
  if (!located.ok) return located;
  return done("other", invoke, { kind: "write", path: located.value.path, change: located.value.exists ? "modify" : "create" });
}

/** The tool use a pi tool call makes, or why it cannot be translated. Never throws. */
export function translate(call: PiToolCall, cwd: string, locate: Locate): Result<ToolUse> {
  try {
    const input = call.input;
    if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, error: `pi's ${call.toolName} call has no input object` };
    const translated = translateInput(call.toolName, input as Input, cwd, locate);
    return translated.ok ? toolUse(null, translated.value.tool, translated.value.effects) : translated;
  } catch (error) {
    return { ok: false, error: `pi's ${call.toolName} call could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
}
