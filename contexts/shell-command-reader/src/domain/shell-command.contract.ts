import type { ProjectPath, Result, UnresolvedShellRole } from "bounded/domain";

// What bounded's shell command reader makes of a command: a syntax tree (the
// adapter's parser builds it), then a translation into the programs it runs,
// the paths it reads, lists and writes, and what only the shell can resolve.
// Neither decides anything: packs judge the reading (ADR 2026-020).

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
  /**
   * A simple command; `name` is null for a bare assignment. Assignment values
   * may run commands. `standIn` marks one the parser made for text the shell
   * does not run as a program (a loop's words, an assignment): what is
   * substituted in it runs, but it is no program.
   */
  | { readonly kind: "command"; readonly name: ShellWord | null; readonly args: readonly ShellWord[]; readonly redirects: readonly ShellRedirect[]; readonly assignments: readonly ShellWord[]; readonly standIn?: true }
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

/** What is at a project path: a file, a directory, something else (such as a link, never followed), or nothing. */
export type PathKind = "file" | "directory" | "other" | "absent";

/** Where a command runs: its directory (null for the project root), the project root (absolute), what is at a path, and how to parse code given to a nested shell. */
export interface ShellPlace {
  readonly cwd: ProjectPath | null;
  readonly root: string;
  kindOfPath(path: ProjectPath): PathKind | undefined;
  parseScript(script: string): Result<readonly ShellNode[]>;
}

/** A write a command makes; `undetermined` when whether the file exists could not be told, so it is judged as both a create and a modify. */
export interface ShellWrite {
  readonly path: ProjectPath;
  readonly change: "create" | "modify" | "delete";
  readonly undetermined?: true;
}

/** A program a command runs: its name and arguments as words, and the project directory it runs in, null when that cannot be known. */
export interface ShellProgram {
  readonly name: ShellWord;
  readonly arguments: readonly ShellWord[];
  readonly workingDirectory: ProjectPath | null;
}

/** Text only the shell (or the program at run time) can resolve, and the role it would have had. */
export interface UnresolvedWord {
  readonly text: string;
  readonly role: UnresolvedShellRole;
}

/** The programs a command runs, in the order met, the project paths it reads, lists and writes, and what in it only the shell can resolve. */
export interface ShellCommandEffects {
  readonly programs: readonly ShellProgram[];
  readonly reads: readonly ProjectPath[];
  readonly lists: readonly ProjectPath[];
  readonly writes: readonly ShellWrite[];
  readonly unresolved: readonly UnresolvedWord[];
}
