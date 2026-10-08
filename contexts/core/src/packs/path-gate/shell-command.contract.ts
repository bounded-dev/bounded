import type { Result } from "bounded/domain";

// What the path gate needs from a shell parser, and what it makes of a
// command: a translation, never a decision. Guards judge what it yields.

/** One token of a parsed shell command: a word (quotes removed), an operator, or text only the shell can resolve (a glob). */
export type ShellToken =
  | { readonly kind: "word"; readonly text: string }
  | { readonly kind: "operator"; readonly operator: string }
  | { readonly kind: "unresolved"; readonly text: string };

/** The port to a shell parser: a command's tokens, or why it cannot be read. */
export type ShellParser = (command: string) => Result<readonly ShellToken[]>;

/** A write a command makes through a redirection: whether it creates or modifies the file cannot be known before it runs. */
export interface ShellWrite {
  readonly path: string;
  readonly change: "create-or-modify";
}

/** The project paths a command reads and writes, and what in it only the shell can resolve. */
export interface ShellCommandEffects {
  readonly reads: readonly string[];
  readonly writes: readonly ShellWrite[];
  readonly unresolved: readonly string[];
}
