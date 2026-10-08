import picomatch from "picomatch";
import type * as Contract from "./file-set.contract.ts";

// Patterns are checked and matched as the path gate checks and matches a
// rule's `match` (its pattern rules are repeated here: a shipped pack never
// imports another), with one rule of this pack's own: no pattern may name
// Bounded's state, `.bounded`, which records prerequisites.

const MAX_PATTERN = 512;
/** Wildcards (* or ?) allowed in one part: each more multiplies picomatch's backtracking on a long name. */
const MAX_WILDCARDS = 3;
const ABSOLUTE = /^([/~]|[A-Za-z]:(\/|$))/;
const CLIMBS = /(^|[/{,(|])\.\.($|[/},)|])/;
/** Directories whose files are never in a set, at any depth: Bounded's state, dependencies and version control. */
const NEVER = new Set([".bounded", "node_modules", ".git"]);
/** The directories never fingerprinted that an unchangedSince pattern could otherwise name (.bounded is refused for every field). */
const UNREAD = new Set(["node_modules", ".git"]);
const MATCHING = { dot: true, nocase: true, noextglob: true } as const;

const refuse = (error: string): { ok: false; error: string } => ({ ok: false, error });
const hasControl = (text: string): boolean => [...text].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
const isGlob = (text: string): boolean => picomatch.scan(text).isGlob;

/** What a {group} or [class] holds that would let one part of a pattern span several: a '/' or a '**'. */
function spanInGroup(text: string): "'/'" | "'**'" | undefined {
  let depth = 0;
  for (const [i, char] of [...text].entries()) {
    if ("{[".includes(char)) depth++;
    else if ("}]".includes(char)) depth = Math.max(0, depth - 1);
    else if (depth > 0 && char === "/") return "'/'";
    else if (depth > 0 && char === "*" && text[i + 1] === "*") return "'**'";
  }
  return undefined;
}

export const checkFilePattern: Contract.CheckFilePattern = (raw, field) => {
  if (typeof raw !== "string") return refuse(`A rule's ${field} pattern must be text`);
  const text = raw.normalize("NFC").trim();
  const named = `A rule's ${field} pattern '${text}'`;
  if (text.length > MAX_PATTERN) return refuse(`A rule's ${field} pattern '${text.slice(0, 40)}...' is longer than ${MAX_PATTERN} characters`);
  if (hasControl(text)) return refuse(`${named} contains a control character`);
  if (text.includes("\\")) return refuse(`${named} contains '\\'. Separate its parts with '/'`);
  if (ABSOLUTE.test(text)) return refuse(`${named} is absolute. Patterns are relative to the project root, such as 'src/**'`);
  if (text.startsWith("!")) return refuse(`${named} is negated. Name the files that must not change`);
  if (/[()]/.test(text)) return refuse(`${named} uses parentheses. Write alternatives with braces, such as {a,b}`);
  if (CLIMBS.test(text)) return refuse(`${named} uses '..'. Patterns are relative to the project root and stay inside it`);
  const span = spanInGroup(text);
  if (span !== undefined) return refuse(`${named} has ${span} inside a group. Keep each group within one part of the path, or write two patterns`);
  if (text.length > 1 && text.endsWith("/")) return refuse(`${named} ends in '/'. Write '${text.replace(/\/+$/, "")}': a name covers everything under it`);
  const crowded = text.split("/").find((part) => part !== "**" && [...part].filter((c) => c === "*" || c === "?").length > MAX_WILDCARDS);
  if (crowded !== undefined) return refuse(`${named} has more than three wildcards (* or ?) in one part ('${crowded}'). Matching that can take seconds: use fewer, or write several patterns`);
  const tidy = text
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .join("/");
  if (tidy === "") return refuse(`A rule's ${field} pattern must not be empty`);
  if (tidy.split("/")[0]?.toLowerCase() === ".bounded") return refuse(`${named} is inside .bounded, Bounded's own state, which records prerequisites: name the project's own files`);
  // A fingerprint never reads node_modules or .git, so files there can never be named as unchanged.
  const unread = field === "unchangedSince" ? tidy.split("/").find((part) => UNREAD.has(part.toLowerCase())) : undefined;
  if (unread !== undefined) return refuse(`${named} leads into ${unread}, which is never fingerprinted: name files outside node_modules and .git`);
  try {
    picomatch.makeRe(tidy, { strictBrackets: true, ...MATCHING });
  } catch (error) {
    return refuse(`${named} is not a valid glob: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { ok: true, value: tidy };
};

/** Whether any part of a project-relative path is a directory never in a set. */
const inNever = (path: string): boolean => path.split("/").some((part) => NEVER.has(part.toLowerCase()));

class FileSetImpl implements Contract.FileSet {
  private readonly test: (path: string) => boolean;
  /** Each pattern's parts, each a test of one path part, or null for a part that may span parts (a '**', or what is under a glob-free pattern). */
  private readonly leading: readonly (readonly (((part: string) => boolean) | null)[])[];

  constructor(readonly patterns: readonly string[]) {
    const covering = patterns.flatMap((pattern) => (isGlob(pattern) ? [pattern] : [pattern, `${pattern}/**`]));
    this.test = covering.length === 0 ? () => false : picomatch(covering, MATCHING);
    this.leading = patterns.map((pattern) => [...pattern.split("/").map((part) => (part.includes("**") ? null : picomatch(part, MATCHING))), ...(isGlob(pattern) ? [] : [null])]);
    Object.freeze(this);
  }

  matches(path: string): boolean {
    return !inNever(path) && this.test(path);
  }

  mayHold(dir: string): boolean {
    if (dir === "" || dir === ".") return this.patterns.length > 0;
    if (inNever(dir)) return false;
    const parts = dir.split("/");
    return this.leading.some((tests) => {
      for (const [i, part] of parts.entries()) {
        const test = tests[i];
        if (test === null) return true;
        if (test === undefined || !test(part)) return false;
      }
      return tests.length > parts.length;
    });
  }
}

export const fileSetOf: Contract.FileSetOf = (patterns) => new FileSetImpl(Object.freeze([...patterns]));

export const pathMatcherOf: Contract.PathMatcherOf = (pattern) => picomatch(isGlob(pattern) ? [pattern] : [pattern, `${pattern}/**`], MATCHING);
