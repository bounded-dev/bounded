// The tool-use event the adapter produces is the core's: built here through
// the core's own parse, so it is checked exactly as the core checks it.
import type { Effect, EffectJSON, Result, Role, ToolKind } from "bounded/domain";
import { ToolUse } from "bounded/domain";

export type { Effect, EffectJSON, ToolKind };

/** A frozen tool use, or why the core refuses it (no effects, blank or NUL-bearing text, a bad path). */
export function toolUse(role: Role | null, tool: ToolKind, effects: readonly EffectJSON[]): Result<ToolUse> {
  return ToolUse.parse({ kind: "tool-use", role, tool, effects });
}

export { ToolUse };
