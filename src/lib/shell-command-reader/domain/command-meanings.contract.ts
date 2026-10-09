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
   * (env -C, sudo -D, git -C): null when that directory cannot be known.
   */
  readonly runs: readonly {
    readonly name: ShellWord;
    readonly args: readonly ShellWord[];
    readonly directory?: ShellWord | null;
    /**
     * xargs without a replace string: more arguments come after `args` from
     * its input. They are never operands of the command (so a literal
     * destination is still judged), only a program argument and an
     * unresolved part.
     */
    readonly input?: true;
    /**
     * A replace string (xargs's -I, -i, --replace, BSD -J; find -exec's {}):
     * what replaces it stands where it is written, which is reported, and
     * each word holding it is listed in the run's words as `replacedBy`;
     * every word is still judged as written.
     */
    readonly replace?: ShellWord;
    /** What stands where the replace string is written: xargs's input, (input), when not given; find's found path, (found path). */
    readonly replacedBy?: ShellWord;
    /** The run's words are the last of the command's (a wrapper's, builtin's or git -C's), so words appended to the command, such as xargs's input, are appended to it. */
    readonly trailing?: true;
  }[];
  /** Code a nested shell runs (sh -c '…'), parsed and walked in a shell of its own. */
  readonly scripts: readonly ShellWord[];
  /** Operands naming a path in the repository as <rev>:<path>: the path is read, relative to the repository's root, or to where the command runs when it starts with ./ or ../. */
  readonly repositoryReads: readonly ShellWord[];
  /**
   * A shell's script operands that are its standard input unless they name
   * a project path from where the command runs (`bash /opt/x.sh` may be a
   * link to /dev/stdin): then `(standard input)` code is reported, failing
   * closed. They are read as written either way.
   */
  readonly standardInputUnlessInProject?: readonly ShellWord[];
  /** Words only the shell, or the command at run time, can make sense of (eval's code, env -S's trailing words). */
  readonly unresolved: readonly ShellWord[];
  /** Where later commands run: a directory, or null when it cannot be known (cd -, cd alone, popd). */
  readonly location?: { readonly to: ShellWord | null };
}
