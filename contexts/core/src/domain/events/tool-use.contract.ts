import type { Result } from "../shared/result.ts";
import type { Effect } from "./effect.contract.ts";
import type { Role } from "./role.contract.ts";

/** What kind of tool acts, in words no host owns: kept for allowlists of tools. */
export type ToolKind = "read" | "search" | "edit" | "write" | "shell" | "web" | "subagent" | "other";

/**
 * An agent using a tool: who acts, with what kind of tool, and every precise
 * effect the call has (at least one). Built only by `ToolUse.parse`.
 */
export interface ToolUse {
  readonly __brand: "ToolUse";
  readonly kind: "tool-use";
  /** The acting role, or null when no role is active. */
  readonly role: Role | null;
  readonly tool: ToolKind;
  readonly effects: readonly [Effect, ...Effect[]];
  /** The host's id for this call, when it gives one: a tool result names the same id. */
  readonly callId?: string;
}

export interface ToolUseFactory {
  /** A frozen tool use from its wire form, or why the value is not one. */
  parse(raw: unknown): Result<ToolUse>;
}
