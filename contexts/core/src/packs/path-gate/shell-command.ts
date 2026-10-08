import { ProjectPath } from "bounded/domain";
import type { ShellCommandEffects, ShellToken, ShellWrite } from "./shell-command.contract.ts";

// A parsed shell command as the project paths it names: a translation that
// decides nothing. A command's arguments are taken as reads of the paths
// they name (its name is not), an option's `=value` too; a `<` source is a
// read, a `>` or `>>` target a write; `cd` moves where later paths resolve
// from. Variables, globs, `~`, absolute paths and paths leaving the project
// are unresolved: only the shell can resolve them.

const READ_REDIRECTS = new Set(["<"]);
const WRITE_REDIRECTS = new Set([">", ">>", ">|"]);
/** Redirections whose target is not a file: a descriptor, a here-document's delimiter or text. */
const OTHER_REDIRECTS = new Set([">&", "<&", "<<", "<<<", "<>"]);
const isRedirect = (token: ShellToken | undefined): boolean =>
  token?.kind === "operator" && (READ_REDIRECTS.has(token.operator) || WRITE_REDIRECTS.has(token.operator) || OTHER_REDIRECTS.has(token.operator));

/** `text` as a project path from the directory `at` (its parts), or undefined when only the shell could resolve it. */
function resolve(at: readonly string[], text: string): string | undefined {
  if (text === "" || text.includes("$") || text.includes("`") || text.startsWith("/") || text.startsWith("~")) return undefined;
  const parts = [...at];
  for (const part of text.split("/")) {
    if (part === "" || part === ".") continue;
    if (part !== "..") parts.push(part);
    else if (parts.pop() === undefined) return undefined;
  }
  const path = ProjectPath.parse(parts.length === 0 ? "." : parts.join("/"));
  return path.ok ? path.value.value : undefined;
}

/** What `tokens`, run from `cwd` (project-relative, or null for the project root), read and write. */
export function describeShellCommand(tokens: readonly ShellToken[], cwd: string | null): ShellCommandEffects {
  let at: string[] = cwd === null || cwd === "." ? [] : cwd.split("/");
  const reads: string[] = [];
  const writes: ShellWrite[] = [];
  const unresolved: string[] = [];
  const named = (text: string, into: (path: string) => void): void => {
    const path = resolve(at, text);
    if (path === undefined) unresolved.push(text);
    else into(path);
  };
  /** What the next word is: a command's name, cd's directory, an argument, or a redirection's target. */
  let next: "name" | "cd" | "argument" | "read" | "write" | "skip" = "name";
  for (const [index, token] of tokens.entries()) {
    if (token.kind === "operator") {
      if (READ_REDIRECTS.has(token.operator)) next = "read";
      else if (WRITE_REDIRECTS.has(token.operator)) next = "write";
      else if (OTHER_REDIRECTS.has(token.operator)) next = "skip";
      else next = "name";
      continue;
    }
    if (token.kind === "unresolved") {
      unresolved.push(token.text);
      next = next === "name" ? "argument" : next === "read" || next === "write" || next === "skip" ? "argument" : next;
      continue;
    }
    const { text } = token;
    if (next === "read" || next === "write" || next === "skip") {
      if (next === "read") named(text, (path) => reads.push(path));
      if (next === "write") named(text, (path) => writes.push({ path, change: "create-or-modify" }));
      next = "argument";
    } else if (/^\d+$/.test(text) && isRedirect(tokens[index + 1])) {
      // A file descriptor, as in 2>&1 or 2> errors.log.
    } else if (next === "name") {
      // An assignment before the command (NAME=value) names its value; the command's own name is not read.
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(text)) named(text.slice(text.indexOf("=") + 1), (path) => reads.push(path));
      else next = text === "cd" ? "cd" : "argument";
    } else if (next === "cd") {
      const moved = resolve(at, text);
      if (moved === undefined) unresolved.push(text);
      else at = moved === "." ? [] : moved.split("/");
      next = "argument";
    } else if (text.startsWith("-")) {
      if (text.includes("=")) named(text.slice(text.indexOf("=") + 1), (path) => reads.push(path));
    } else named(text, (path) => reads.push(path));
  }
  return { reads, writes, unresolved };
}
