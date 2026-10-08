import { type Command, type Composition, type EffectGuard, type ExecuteEffect, type ListEffect, portKeysFor, type ProjectOpenHandler, type ProjectPath, type ReadEffect, type Result, type WriteEffect } from "bounded/domain";
import { pathGateId } from "../../domain/path-gate-id.ts";
import type { PathKind, ShellCommandEffects, ShellNode } from "../../domain/shell-command.contract.ts";

// The path gate judges calls: reads, listings and writes against its
// protected paths, and shell commands by what their text says they read,
// list and write. To read a shell command it needs two ports a host provides.

export type { PathKind, ShellCommandEffects, ShellNode } from "../../domain/shell-command.contract.ts";

// What this feature contributes to the core: a guard per effect kind it judges, and the work it does when a project opens.
/** Judges a read against the protected paths. */
export type JudgeRead = EffectGuard<ReadEffect, Composition>;
/** Judges a listing against the protected paths. */
export type JudgeList = EffectGuard<ListEffect, Composition>;
/** Judges a write against the protected paths. */
export type JudgeWrite = EffectGuard<WriteEffect, Composition>;
/** Judges a shell command by what its text says it reads, lists and writes. */
export type JudgeExecute = EffectGuard<ExecuteEffect, Composition>;
/** When a project opens: prepares its shell check, from the parser and path kinds the host provides. */
export type PrepareShell = ProjectOpenHandler;

// Out ports: exactly what this feature needs.
/**
 * What is at a path in one project: undefined when it cannot be told.
 * @implementedBy in-memory file-system
 */
export interface PathKinds {
  kindOf(path: ProjectPath): PathKind | undefined;
}

/**
 * A shell parser. `prepare` loads it, once, when the project opens; then
 * `parse` is synchronous, as guards are. Before it is prepared, or if it
 * cannot load, `parse` fails.
 * @implementedBy tree-sitter
 */
export interface ShellParser {
  prepare(): Promise<void>;
  parse(command: Command): Result<readonly ShellNode[]>;
}

/** A project's shell check: a command, run from a directory, as what it reads, lists and writes; or why it cannot be told. */
export interface ShellCheck {
  describe(command: Command, cwd: ProjectPath | null): Result<ShellCommandEffects>;
}

// The path gate's ports for this feature: a host provides them through openProject({ ports }).
/** What is at a path in the project. */
export const pathKindsPort = portKeysFor(pathGateId)<PathKinds>("pathKinds");
/** The shell parser the project's shell check uses. */
export const shellParserPort = portKeysFor(pathGateId)<ShellParser>("shellParser");
