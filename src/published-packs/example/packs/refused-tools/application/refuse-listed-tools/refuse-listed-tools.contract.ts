import type { Composition, Guard, ToolUse } from "bounded/domain";

// The refused-tools pack refuses whole tool calls: a tool use whose tool kind
// a contributed rule names. It needs no port: the call carries its kind.

/** Judges a whole tool call against the refused tool kinds. */
export type RefuseListedTools = Guard<ToolUse, Composition>;
