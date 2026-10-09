// bounded-shell-command-reader/shell-command-reading: the composition root
// host adapters read shell commands through (ADR 2026-020). bounded
// publishes it, built into its dist, as bounded/shell-command-reader.
import { type ReadShellCommand, ReadShellCommandHandler, type ReadShellCommandOptions } from "bounded-shell-command-reader/application";
import { TreeSitterShellCommandReader } from "bounded-shell-command-reader/adapters";

export type { PathKind, TreeSitterShellCommandReaderOptions } from "bounded-shell-command-reader/adapters";
export { TreeSitterShellCommandReader } from "bounded-shell-command-reader/adapters";
export type { ReadShellCommand, ReadShellCommandInput, ReadShellCommandOptions, ShellCommandReader } from "bounded-shell-command-reader/application";
export { ReadShellCommandCommand, ReadShellCommandHandler } from "bounded-shell-command-reader/application";

/**
 * bounded's shell command reading for a host adapter: ReadShellCommand over
 * the tree-sitter reader, its grammar loading once per process. A host
 * makes one, starts `prepare()` without waiting for it, and reads every
 * execute effect's command with `read` when it builds the core's event,
 * putting the reading on the effect. Throws a RangeError for a bound that
 * is not a finite number of milliseconds above zero.
 */
export function openShellCommandReading(options: ReadShellCommandOptions = {}): ReadShellCommand {
  return new ReadShellCommandHandler(new TreeSitterShellCommandReader(), options);
}

// Frozen, so code loaded later cannot patch it.
Object.freeze(openShellCommandReading);
