// The host-neutral tool-use event this adapter produces, and the step that
// resolves a translated call's paths into it.
//
// The core is moving to this effects model. Until its ToolUse lands, the
// shape is defined here with the core's names, and only ToolUse, Effect,
// ToolKind and Change are to be swapped for the core's exports at the
// integration (docs/adapter-claude-code.md).
import { ProjectPath, type Refuse, type Result, Role, Verdict } from "bounded/domain";
import type { HostCall } from "./translate.ts";

export type ToolKind = "read" | "search" | "edit" | "write" | "shell" | "web" | "subagent" | "other";
export type Change = "create" | "modify" | "delete";

export type Effect =
  | { readonly kind: "read"; readonly path: ProjectPath }
  | { readonly kind: "list"; readonly root: ProjectPath; readonly filter?: string }
  | { readonly kind: "write"; readonly path: ProjectPath; readonly change: Change }
  | { readonly kind: "execute"; readonly command: string }
  | { readonly kind: "fetch"; readonly url: string }
  | { readonly kind: "delegate"; readonly agent: string }
  /** A tool call whose effects cannot be described, by the tool's name. */
  | { readonly kind: "invoke"; readonly name: string };

/** An agent using a tool: what it is, and everything it does (at least one effect). */
export interface ToolUse {
  readonly kind: "tool-use";
  readonly role: Role | null;
  readonly tool: ToolKind;
  readonly effects: readonly Effect[];
}

/** The port to the file system: a host path, relative to `cwd` unless absolute, as a project-relative one. */
export interface PathResolver {
  resolve(raw: string, cwd: string): Result<{ readonly path: string; readonly exists: boolean }, Refuse>;
}

export interface Resolving {
  /** The role label from the hook's command line, or null for none. */
  readonly role: string | null;
  /** The directory relative host paths are resolved against. */
  readonly cwd: string;
  readonly paths: PathResolver;
}

type Resolved = Result<{ path: ProjectPath; exists: boolean }, Refuse>;

/** The translated call as a frozen event, every path resolved and checked; any refused path refuses the call. */
export function toToolUse(call: HostCall, { role, cwd, paths }: Resolving): Result<ToolUse, Refuse> {
  let checkedRole: Role | null = null;
  if (role !== null) {
    const parsed = Role.parse(role);
    if (!parsed.ok) return { ok: false, error: Verdict.refuse(parsed.error, "Start the hook with --role naming a role label") };
    checkedRole = parsed.value;
  }
  if (call.effects.length === 0) return { ok: false, error: Verdict.refuse("A tool use must have at least one effect", "Report this to the maintainers of bounded") };

  const resolve = (raw: string): Resolved => {
    const found = paths.resolve(raw, cwd);
    if (!found.ok) return found;
    const path = ProjectPath.parse(found.value.path);
    if (!path.ok) return { ok: false, error: Verdict.refuse(path.error, "Use a path inside the project; a link must land inside it too") };
    return { ok: true, value: { path: path.value, exists: found.value.exists } };
  };

  const effects: Effect[] = [];
  for (const effect of call.effects) {
    let made: Effect;
    if (effect.kind === "read" || effect.kind === "write" || effect.kind === "list") {
      const found = resolve(effect.kind === "list" ? effect.root : effect.path);
      if (!found.ok) return found;
      const { path, exists } = found.value;
      if (effect.kind === "read") made = { kind: "read", path };
      else if (effect.kind === "list") made = effect.filter === undefined ? { kind: "list", root: path } : { kind: "list", root: path, filter: effect.filter };
      else made = { kind: "write", path, change: effect.change === "create-or-modify" ? (exists ? "modify" : "create") : effect.change };
    } else made = { ...effect };
    effects.push(Object.freeze(made));
  }
  return { ok: true, value: Object.freeze({ kind: "tool-use", role: checkedRole, tool: call.tool, effects: Object.freeze(effects) }) };
}
