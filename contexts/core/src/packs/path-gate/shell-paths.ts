import { type ParseEntry, parse } from "shell-quote";

// Best effort: the project paths a shell command names, from the words a
// shell parser (shell-quote, ADR 2026-009) gives: arguments, redirection
// targets and the values of `--option=value` words, each resolved from the
// command's directory and from any `cd` before it. Out of reach: globs,
// variables, command substitution's output, `~`, absolute paths, and every
// file a program or script opens by itself. Confining the command is the
// real control.

/** Whether a word holds something only the shell can resolve: a variable or a backquoted command. */
const unresolved = (word: string): boolean => word.includes("$") || word.includes("`");

/** `word` as a project-relative path from the directory `at` (its parts), or undefined when it cannot be one. */
function resolve(at: readonly string[], word: string): string | undefined {
  if (word === "" || unresolved(word) || word.startsWith("/") || word.startsWith("~") || word.startsWith("-")) return undefined;
  const parts = [...at];
  for (const part of word.split("/")) {
    if (part === "" || part === ".") continue;
    if (part !== "..") parts.push(part);
    else if (parts.pop() === undefined) return undefined;
  }
  return parts.length === 0 ? "." : parts.join("/");
}

/**
 * The project paths `command` names, run from `cwd` (project-relative, or
 * null for the project root); undefined when the parser cannot read it.
 */
export function namedPaths(command: string, cwd: string | null): string[] | undefined {
  let entries: ParseEntry[];
  try {
    // Variables stay as written, so they are seen as unresolved, never expanded.
    entries = parse(command, (name) => `$${name}`);
  } catch {
    return undefined;
  }
  let at = cwd === null || cwd === "." ? [] : cwd.split("/");
  const named = new Set<string>();
  let commandName: string | undefined;
  let first = true;
  for (const entry of entries) {
    if (typeof entry !== "string") {
      // An operator ends one command; a comment, glob or other entry names no path that can be resolved.
      if ("op" in entry && entry.op !== "glob") first = true;
      continue;
    }
    for (const word of new Set([entry, entry.slice(entry.indexOf("=") + 1)])) {
      const path = resolve(at, word);
      if (path !== undefined) named.add(path);
    }
    if (commandName === "cd" && !first) {
      const moved = resolve(at, entry);
      if (moved !== undefined) at = moved === "." ? [] : moved.split("/");
    }
    if (first) commandName = entry;
    first = false;
  }
  return [...named];
}
