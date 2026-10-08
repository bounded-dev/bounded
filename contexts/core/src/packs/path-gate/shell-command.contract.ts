import type { PathKind, Result } from "bounded/domain";

// What the path gate needs from a shell parser, and what it makes of a
// command: a syntax tree, then a translation into the paths the command
// reads, lists and writes. Neither decides anything; the guards judge.

/** A word of a command: literal text (quotes and escapes removed), or text only the shell can resolve, with the commands it runs (substitutions). */
export type ShellWord =
  | { readonly kind: "literal"; readonly text: string }
  | { readonly kind: "unresolved"; readonly text: string; readonly commands: readonly ShellNode[] };

/**
 * A redirection: its operator as written ('>', '>>', '&>', '<', '>&', '<<',
 * '<<<' …) and its target. A heredoc's body and a here-string are text, not
 * paths, though commands substituted in them still run.
 */
export interface ShellRedirect {
  readonly operator: string;
  readonly target: ShellWord;
}

/** A parsed command line, as the shell would run it. */
export type ShellNode =
  /** A simple command; `name` is null for a bare assignment. Assignment values may run commands. */
  | { readonly kind: "command"; readonly name: ShellWord | null; readonly args: readonly ShellWord[]; readonly redirects: readonly ShellRedirect[]; readonly assignments: readonly ShellWord[] }
  /** Two parts joined by ';', '&&', '||' or '&'. */
  | { readonly kind: "list"; readonly left: ShellNode; readonly operator: ";" | "&&" | "||" | "&"; readonly right: ShellNode }
  /** Commands joined by '|': each stage runs in a subshell of its own. */
  | { readonly kind: "pipeline"; readonly stages: readonly ShellNode[] }
  /** '( … )', or anything run in the background: a cd inside does not leak. */
  | { readonly kind: "subshell"; readonly body: readonly ShellNode[] }
  /** '{ …; }', or any construct with redirections around it: runs in the same shell. */
  | { readonly kind: "group"; readonly body: readonly ShellNode[]; readonly redirects: readonly ShellRedirect[] }
  /** if, while, until, for, case, functions: what is inside may or may not run, so a cd inside leaves where later commands run unknown. */
  | { readonly kind: "conditional"; readonly body: readonly ShellNode[] }
  /** Text the parser could not read: nothing in it is resolved. */
  | { readonly kind: "unparsed"; readonly text: string };

/**
 * The port to a shell parser. `prepare` loads it, once, when the project
 * opens; then `parse` is synchronous, as guards are. Before it is prepared,
 * or if it cannot load, `parse` fails.
 */
export interface ShellParser {
  prepare(): Promise<void>;
  parse(command: string): Result<readonly ShellNode[]>;
}

/** Where a command runs: its directory (project-relative, or null for the root), the project root, and what is at a path. */
export interface ShellPlace {
  readonly cwd: string | null;
  readonly root: string;
  kindOfPath(path: string): PathKind | undefined;
}

/** A write a command makes; `undetermined` when whether the file exists could not be told, so it is judged as both a create and a modify. */
export interface ShellWrite {
  readonly path: string;
  readonly change: "create" | "modify" | "delete";
  readonly undetermined?: true;
}

/** The project paths a command reads, lists and writes, and what in it only the shell can resolve. */
export interface ShellCommandEffects {
  readonly reads: readonly string[];
  readonly lists: readonly string[];
  readonly writes: readonly ShellWrite[];
  readonly unresolved: readonly string[];
}
