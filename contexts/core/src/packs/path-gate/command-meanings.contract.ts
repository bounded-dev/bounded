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
  /** Copies (moves when `moves`) from `sources` to `destination`, a file or a directory to put them in. */
  readonly transfers: readonly { readonly sources: readonly ShellWord[]; readonly destination: ShellWord; readonly moves: boolean }[];
  /** Commands it runs with arguments given literally (builtin, command, exec, xargs, find -exec). */
  readonly runs: readonly { readonly name: ShellWord; readonly args: readonly ShellWord[] }[];
  /** Words only the shell, or the command at run time, can make sense of (eval's code, paths relative to git -C). */
  readonly unresolved: readonly ShellWord[];
  /** Where later commands run: a directory, or null when it cannot be known (cd -, cd alone, popd). */
  readonly location?: { readonly to: ShellWord | null };
}
