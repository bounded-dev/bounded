import type { Result } from "../shared/result.ts";
import type { ToolUse } from "./tool-use.contract.ts";

/** A tool call that has run: the tool use, whether it succeeded, and its call id when the host gives one. */
export interface ToolResult extends Omit<ToolUse, "__brand" | "kind"> {
  readonly __brand: "ToolResult";
  readonly kind: "tool-result";
  readonly ok: boolean;
}

export interface ToolResultFactory {
  /** A frozen tool result from its wire form, or why the value is not one. Checked like a tool use. */
  parse(raw: unknown): Result<ToolResult>;
}
