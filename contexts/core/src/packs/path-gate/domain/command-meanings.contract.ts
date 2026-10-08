import type { ShellWord } from "./shell-command.contract.ts";

/**
 * How a write changes its path: created, deleted, written (a create when the
 * file is missing, else a modify), or created only when missing (touch: an
 * existing file's content is not changed).
 */
export type MeaningChange = "create" | "delete" | "write" | "create-if-missing";

/** What a command does with its arguments: the paths it reads, lists and writes, moves, where it goes, and commands it runs. */
export interface CommandMeaning {
  readonly reads: readonly ShellWord[];
  readonly lists: readonly ShellWord[];
  readonly writes: readonly { readonly word: ShellWord; readonly change: MeaningChange }[];
  /** Copies (moves when `moves`) from `sources` to `destination`, a file or a directory to put them in: sources are read either way, and deleted when moved. */
  readonly transfers: readonly { readonly sources: readonly ShellWord[]; readonly destination: ShellWord; readonly moves: boolean }[];
  /**
   * Commands it runs with arguments given literally (builtin, command, exec,
   * xargs, find -exec, sudo, env …), from `directory` when it sets one
   * (env -C, sudo -D): null when that directory cannot be known.
   */
  readonly runs: readonly { readonly name: ShellWord; readonly args: readonly ShellWord[]; readonly directory?: ShellWord | null }[];
  /** Code a nested shell runs (sh -c '…'), parsed and walked in a shell of its own. */
  readonly scripts: readonly ShellWord[];
  /** Operands naming a path in the repository as <rev>:<path>: the path is read, relative to the repository's root, or to where the command runs when it starts with ./ or ../. */
  readonly repositoryReads: readonly ShellWord[];
  /** Words only the shell, or the command at run time, can make sense of (eval's code, paths relative to git -C). */
  readonly unresolved: readonly ShellWord[];
  /** Where later commands run: a directory, or null when it cannot be known (cd -, cd alone, popd). */
  readonly location?: { readonly to: ShellWord | null };
}
