import type { Result } from "../shared/result.ts";
import type { CallId } from "./call-id.contract.ts";
import type { Effect } from "./effect.contract.ts";
import type { Role } from "./role.contract.ts";
import type { ToolKind, ToolUseJSON } from "./tool-use.contract.ts";

/** The brand only ToolResult itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const toolResultBrand: unique symbol;

/** A tool call that has run: the tool use, whether it succeeded, and its call id when the host gives one. */
export interface ToolResult {
  readonly __brand: "ToolResult";
  readonly [toolResultBrand]: true;
  readonly kind: "tool-result";
  readonly role: Role | null;
  readonly toolKind: ToolKind;
  readonly effects: readonly [Effect, ...Effect[]];
  readonly callId?: CallId;
  readonly ok: boolean;
  equals(other: ToolResult): boolean;
  toJSON(): ToolResultJSON;
}

/** A tool result's wire form: a tool use's, with kind "tool-result" and whether it succeeded. */
export interface ToolResultJSON extends Omit<ToolUseJSON, "kind"> {
  readonly kind?: "tool-result";
  readonly ok: boolean;
}

export interface ToolResultFactory {
  /** A frozen tool result from its wire form, or why the value is not one. Checked like a tool use. */
  parse(raw: unknown): Result<ToolResult>;
}
