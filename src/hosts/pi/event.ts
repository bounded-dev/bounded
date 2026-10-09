// The tool-use event the adapter produces is the core's: built here through
// the core's own parse, so it is checked exactly as the core checks it. The
// adapter is trusted code: it reads each shell command of the model's tool
// call with bounded's reader and puts the reading on its execute effect; the
// core checks the reading's shape (ADR 2026-020).
import type { Effect, EffectJSON, ExecuteEffectJSON, Result, Role, ToolKind } from "bounded/domain";
import { ToolUse } from "bounded/domain";
import type { ReadShellCommand } from "bounded-shell-command-reader/shell-command-reading";

export type { Effect, EffectJSON, ToolKind };

/** An execute effect as translate gives it: the command and its directory, before the extension reads the command. */
export interface ExecuteBeforeReadingJSON {
  readonly kind: "execute";
  readonly command: string;
  readonly cwd: string | null;
}

/** An effect of a translated call: any effect's wire form, an execute's before its reading. */
export type PiEffectJSON = Exclude<EffectJSON, ExecuteEffectJSON> | ExecuteBeforeReadingJSON;

/** A pi tool call translated: its tool kind and effects, before its shell commands are read. */
export interface PiCall {
  readonly tool: ToolKind;
  readonly effects: readonly PiEffectJSON[];
}

/** What building a tool use needs beyond the call: where and how its shell commands are read, and pi's id for the call. */
export interface Reading {
  /** The project's root, an absolute path: each shell command is read in it. */
  readonly projectRoot: string;
  /** Reads each shell command into the reading its execute effect carries; it never rejects. */
  readonly readShellCommand: ReadShellCommand;
  readonly callId?: string;
}

/**
 * A frozen tool use, every shell command read, or why the core refuses it
 * (no effects, blank or NUL-bearing text, a bad path). A command that cannot
 * be read carries an unread reading saying why, which a pack that needs it
 * refuses. Never rejects.
 */
export async function toolUse(role: Role | null, call: PiCall, { projectRoot, readShellCommand, callId }: Reading): Promise<Result<ToolUse>> {
  const effects: EffectJSON[] = [];
  for (const effect of call.effects) {
    if (effect.kind === "execute") effects.push({ ...effect, reading: await readShellCommand.read({ projectRoot, command: effect.command, cwd: effect.cwd }) });
    else effects.push(effect);
  }
  return ToolUse.parse({ kind: "tool-use", role, tool: call.tool, effects, ...(callId === undefined ? {} : { callId }) });
}

export { ToolUse };
