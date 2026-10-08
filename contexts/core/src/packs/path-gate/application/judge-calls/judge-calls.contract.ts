import { type Command, portKeysFor, type ProjectPath, type Result } from "bounded/domain";
import { pathGateId } from "../../domain/path-gate-id.ts";
import type { PathKind, ShellCommandEffects, ShellNode } from "../../domain/shell-command.contract.ts";

// The path gate judges calls: reads, listings and writes against its
// protected paths, and shell commands by what their text says they read,
// list and write. To read a shell command it needs two ports a host provides.

export type { PathKind, ShellCommandEffects, ShellNode } from "../../domain/shell-command.contract.ts";

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
