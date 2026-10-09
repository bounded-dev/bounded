// A pi tool call as a host-neutral call: its tool kind and effects, each
// checked as the core checks it, an execute's before the extension reads its
// command (event.ts). Pure, given the locator: all file-system knowledge
// (rewriting, links, existence) comes through `locate`.
import { Command, Effect, type Result } from "bounded/domain";
import type { PiCall, PiEffectJSON, ToolKind } from "./event.ts";
import type { Locate, Located } from "./pi-path.ts";
import { subagentEffects } from "./subagent.ts";

/** What pi's `tool_call` event carries that the translation reads. */
export interface PiToolCall {
  readonly toolName: string;
  readonly input: unknown;
}

type Input = Readonly<Record<string, unknown>>;
type Translation = Result<{ tool: ToolKind; effects: PiEffectJSON[] }>;

const done = (tool: ToolKind, ...effects: PiEffectJSON[]): Translation => ({ ok: true, value: { tool, effects } });

/**
 * pi's built-in tools and the web tools. Their paths start at the session's
 * directory: pi's built-ins ignore any `cwd` argument, so it is ignored here.
 */
function builtIn(toolName: string, input: Input, cwd: string, locate: Locate): Translation | undefined {
  const field = (name: string): unknown => (Object.hasOwn(input, name) ? input[name] : undefined);
  const text = (name: string): Result<string | undefined> => {
    const value = field(name);
    if (value === undefined || typeof value === "string") return { ok: true, value };
    return { ok: false, error: `pi's ${toolName} call has a '${name}' that is not a string` };
  };
  const named = (name: string): Result<string> => {
    const value = text(name);
    if (!value.ok) return value;
    return value.value?.trim() ? { ok: true, value: value.value } : { ok: false, error: `pi's ${toolName} call names no ${name} in '${name}'` };
  };
  const file = (use?: "read"): Result<Located> => {
    const path = named("path");
    return path.ok ? locate(path.value, cwd, use) : path;
  };
  /** The directory a search tool lists, the session's when it names none, with its file-name filter. */
  const listing = (filterField?: string): Result<{ root: Located; effect: PiEffectJSON }> => {
    const path = text("path");
    if (!path.ok) return path;
    const root = locate(path.value ?? ".", cwd);
    if (!root.ok) return root;
    const filter = filterField === undefined ? undefined : text(filterField);
    if (filter !== undefined && !filter.ok) return filter;
    const effect: PiEffectJSON = { kind: "list", root: root.value.path.value, filter: filter?.value?.trim() ? filter.value : null };
    return { ok: true, value: { root: root.value, effect } };
  };

  switch (toolName) {
    case "read": {
      const path = file("read");
      return path.ok ? done("read", { kind: "read", path: path.value.path.value }) : path;
    }
    case "write":
    case "edit": {
      const path = file();
      if (!path.ok) return path;
      const change = toolName === "write" && !path.value.exists ? "create" : "modify";
      return done(toolName, { kind: "write", path: path.value.path.value, change });
    }
    case "ls":
    case "find": {
      const listed = listing(toolName === "find" ? "pattern" : undefined);
      return listed.ok ? done("search", listed.value.effect) : listed;
    }
    case "grep": {
      // grep lists its root and reads what it finds there; its content pattern is not judged.
      const listed = listing("glob");
      return listed.ok ? done("search", listed.value.effect, { kind: "read", path: listed.value.root.path.value }) : listed;
    }
    case "bash":
    case "powershell": {
      const command = named("command");
      if (!command.ok) return command;
      const directory = locate(".", cwd);
      return directory.ok ? done("shell", { kind: "execute", command: command.value, cwd: directory.value.path.value }) : directory;
    }
    case "web_fetch": {
      const url = named("url");
      return url.ok ? done("web", { kind: "fetch", url: url.value }) : url;
    }
    case "web_search":
      // A search names no URL: what it reaches is the provider's business.
      return done("web", { kind: "invoke", name: toolName });
    default:
      return undefined;
  }
}

function translateInput(toolName: string, input: Input, cwd: string, locate: Locate): Translation {
  if (toolName === "subagent") {
    const effects = subagentEffects(toolName, input, cwd, locate);
    return effects.ok ? done("subagent", ...effects.value) : effects;
  }
  // A tool the adapter does not know is invoked by name only: its arguments
  // say nothing reliable about what it touches. Custom tools are to be
  // described by a declared per-tool translation table.
  return builtIn(toolName, input, cwd, locate) ?? done("other", { kind: "invoke", name: toolName });
}

/** Why `effect`, the `index`th of `count`, is not one the core accepts, or undefined; an execute's command is checked, its reading is added later. */
function refusalOf(effect: PiEffectJSON, index: number, count: number): string | undefined {
  const checked = effect.kind === "execute" ? Command.parse(effect.command) : Effect.parse(effect);
  return checked.ok ? undefined : `Effect ${index + 1} of ${count}: ${checked.error}`;
}

/** The call a pi tool call makes, its effects checked as the core checks them, or why it cannot be translated. Never throws. */
export function translate(call: PiToolCall, cwd: string, locate: Locate): Result<PiCall> {
  try {
    const input = call.input;
    if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, error: `pi's ${call.toolName} call has no input object` };
    const translated = translateInput(call.toolName, input as Input, cwd, locate);
    if (!translated.ok) return translated;
    const { tool, effects } = translated.value;
    const refusal = effects.map((effect, index) => refusalOf(effect, index, effects.length)).find((why) => why !== undefined);
    return refusal === undefined ? { ok: true, value: { tool, effects } } : { ok: false, error: refusal };
  } catch (error) {
    return { ok: false, error: `pi's ${call.toolName} call could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
}
