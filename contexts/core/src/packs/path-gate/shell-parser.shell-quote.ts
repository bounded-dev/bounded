import { type ParseEntry, parse } from "shell-quote";
import type { ShellParser, ShellToken } from "./shell-command.contract.ts";

// The shell parser behind the path gate's port: shell-quote (pinned; ADR
// 2026-009). Variables are kept as written, never expanded, so they stay
// unresolved; globs are unresolved; comments name nothing.

const token = (entry: ParseEntry): ShellToken | undefined => {
  if (typeof entry === "string") return { kind: "word", text: entry };
  if ("comment" in entry) return undefined;
  if (entry.op === "glob") return { kind: "unresolved", text: entry.pattern };
  return { kind: "operator", operator: entry.op };
};

export const shellQuoteParser: ShellParser = (command) => {
  let entries: ParseEntry[];
  try {
    entries = parse(command, (name) => `$${name}`);
  } catch (thrown) {
    return { ok: false, error: `the command cannot be parsed: ${thrown instanceof Error ? thrown.message : String(thrown)}` };
  }
  return { ok: true, value: entries.map(token).filter((t): t is ShellToken => t !== undefined) };
};
