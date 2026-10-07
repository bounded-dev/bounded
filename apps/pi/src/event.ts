// The tool-use event the adapter produces, in the effects shape the core is
// moving to. It is defined here, with the core's names, until the core
// exports it; then this file becomes a re-export of `bounded/domain`.
import type { ProjectPath, Result, Role, ToolKind } from "bounded/domain";

export type { ToolKind };

/** One thing a tool call does. A call does at least one. */
export type Effect =
  | { readonly kind: "read"; readonly path: ProjectPath }
  | { readonly kind: "list"; readonly root: ProjectPath; readonly filter?: string }
  | { readonly kind: "write"; readonly path: ProjectPath; readonly change: "create" | "modify" | "delete" }
  | { readonly kind: "execute"; readonly command: string }
  | { readonly kind: "fetch"; readonly url: string }
  | { readonly kind: "delegate"; readonly agent: string }
  /** A call whose effects cannot be described: an unknown tool, an MCP tool, a skill, a web search. */
  | { readonly kind: "invoke"; readonly name: string };

export interface ToolUse {
  readonly kind: "tool-use";
  readonly role: Role | null;
  readonly tool: ToolKind;
  readonly effects: readonly [Effect, ...Effect[]];
}

/** The text an effect carries, by name, for those that carry one. */
function textOf(effect: Effect): readonly [name: string, text: string] | undefined {
  switch (effect.kind) {
    case "execute":
      return ["command", effect.command];
    case "fetch":
      return ["url", effect.url];
    case "delegate":
      return ["agent", effect.agent];
    case "invoke":
      return ["name", effect.name];
    default:
      return undefined;
  }
}

/** A frozen tool use, or why it is not one: no effects, or blank or NUL-bearing text. */
export function toolUse(role: Role | null, tool: ToolKind, effects: readonly Effect[]): Result<ToolUse> {
  const frozen = effects.map((effect) => Object.freeze({ ...effect }));
  const [first, ...rest] = frozen;
  if (first === undefined) return { ok: false, error: "A tool use has at least one effect" };
  for (const effect of frozen) {
    const [name, text] = textOf(effect) ?? ["", "-"];
    if (text.trim() === "") return { ok: false, error: `A ${effect.kind} effect names its ${name}` };
    if (text.includes("\0")) return { ok: false, error: `A ${effect.kind} effect's ${name} must not contain a NUL character` };
  }
  return { ok: true, value: Object.freeze({ kind: "tool-use", role, tool, effects: Object.freeze([first, ...rest] as const) }) };
}
