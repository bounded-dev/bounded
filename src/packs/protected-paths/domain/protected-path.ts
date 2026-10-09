import type { protectedPathBrand } from "./protected-path.contract.ts";
import { point, type Result, sameWire, wireFormOf } from "bounded/domain";
import picomatch from "picomatch";
import type * as Contract from "./protected-path.contract.ts";
import type { PathAccess } from "./protected-path.contract.ts";

const ACCESSES: readonly PathAccess[] = ["read", "list", "create", "modify", "delete"];

/** Every kind of write. A rule names each one it denies. */
export const WRITES = Object.freeze(["create", "modify", "delete"] as const);

const FORM = "A protected-path rule is { match, except?, deny, redirect, why?, file? }";
const KEYS = ["match", "except", "deny", "redirect", "why", "file"];
const DENY = `A rule's deny must name at least one of ${ACCESSES.join(", ")}`;
const MAX_PATTERN = 512;
/** Wildcards (* or ?) allowed in one part: each more multiplies picomatch's backtracking on a long name. */
const MAX_WILDCARDS = 3;
const MAX_TEXT = 1000;
const ABSOLUTE = /^([/~]|[A-Za-z]:(\/|$))/;
const CLIMBS = /(^|[/{,(|])\.\.($|[/},)|])/;
const refuse = (error: string): { ok: false; error: string } => ({ ok: false, error });
const hasControl = (text: string): boolean => [...text].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);

/**
 * What a {group} or [class] holds that would let one part of a pattern span
 * several parts of a path: a '/' or a '**'. Refused, so a pattern splits
 * into its path parts at every '/'.
 */
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

function pattern(raw: unknown, role: "match" | "except"): Result<string> {
  if (typeof raw !== "string") return refuse(`A rule's ${role} pattern must be text`);
  const text = raw.normalize("NFC").trim();
  const named = `A rule's ${role} pattern '${text}'`;
  if (text.length > MAX_PATTERN) {
    return refuse(`A rule's ${role} pattern '${text.slice(0, 40)}...' is longer than ${MAX_PATTERN} characters`);
  }
  if (hasControl(text)) return refuse(`${named} contains a control character`);
  if (text.includes("\\")) return refuse(`${named} contains '\\'. Separate its parts with '/'`);
  if (ABSOLUTE.test(text)) return refuse(`${named} is absolute. Patterns are relative to the project root, such as 'src/**'`);
  if (text.startsWith("!") && !text.startsWith("!(")) return refuse(`${named} is negated. A rule only denies: carve paths out of it with except`);
  // Extglobs and regex groups are refused (and compiled with noextglob): braces cover real needs.
  if (/[()]/.test(text)) return refuse(`${named} uses parentheses. Write alternatives with braces, such as {a,b}`);
  if (CLIMBS.test(text)) return refuse(`${named} uses '..'. Patterns are relative to the project root and stay inside it`);
  const span = spanInGroup(text);
  if (span !== undefined) return refuse(`${named} has ${span} inside a group. Keep each group within one part of the path, or write two rules`);
  if (text.length > 1 && text.endsWith("/")) {
    return refuse(`${named} ends in '/'. Write '${text.replace(/\/+$/, "")}': a name covers everything under it`);
  }
  const crowded = text.split("/").find((part) => part !== "**" && [...part].filter((c) => c === "*" || c === "?").length > MAX_WILDCARDS);
  if (crowded !== undefined) {
    return refuse(`${named} has more than three wildcards (* or ?) in one part ('${crowded}'). Matching that can take seconds: use fewer, or write several rules`);
  }
  const tidy = text
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .join("/");
  if (tidy === "") return refuse(`A rule's ${role} pattern must not be empty`);
  try {
    picomatch.makeRe(tidy, { strictBrackets: true, dot: true, noextglob: true });
  } catch (error) {
    return refuse(`${named} is not a valid glob: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { ok: true, value: tidy };
}

/** A rule's fields once checked and tidied. */
interface Fields {
  readonly match: string;
  readonly except: readonly string[];
  readonly deny: readonly [PathAccess, ...PathAccess[]];
  readonly redirect: string;
  readonly why: string | undefined;
  readonly file: boolean;
}

function check(raw: unknown): Result<Fields> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return refuse(FORM);
  const keys = Object.keys(raw);
  if (keys.some((key) => !KEYS.includes(key)) || !["match", "deny", "redirect"].every((key) => keys.includes(key))) return refuse(FORM);
  const field = (key: string): unknown => (Object.hasOwn(raw, key) ? Reflect.get(raw, key) : undefined);

  const match = pattern(field("match"), "match");
  if (!match.ok) return match;
  const exceptions = field("except") ?? [];
  if (!Array.isArray(exceptions)) return refuse("A rule's except is a list of glob patterns");
  const except: string[] = [];
  for (const raw of exceptions) {
    const checked = pattern(raw, "except");
    if (!checked.ok) return checked;
    if (checked.value === match.value || checked.value === "**") {
      return refuse(`A rule's except pattern '${checked.value}' covers its whole match '${match.value}', so the rule would deny nothing`);
    }
    except.push(checked.value);
  }

  const deny = field("deny");
  if (!Array.isArray(deny) || deny.length === 0) return refuse(DENY);
  const unknown = deny.find((kind) => !ACCESSES.some((access) => access === kind));
  if (unknown !== undefined) {
    return refuse(`A rule cannot deny '${String(unknown)}': it denies read, list, create, modify or delete (list each write it denies: create, modify, delete)`);
  }
  const [first, ...rest] = ACCESSES.filter((access) => deny.includes(access));
  if (first === undefined) return refuse(DENY);
  if (deny.includes("modify") && !deny.includes("create") && !deny.includes("delete")) {
    return refuse("A rule that denies modify must also deny create or delete: otherwise deleting and creating the file changes it (deny create, modify and delete)");
  }

  const redirect = field("redirect");
  if (typeof redirect !== "string" || redirect.trim() === "") return refuse("A rule's redirect must say what to do instead");
  const why = field("why");
  if (why !== undefined && (typeof why !== "string" || why.trim() === "")) return refuse("A rule's why, when given, must be non-empty text");
  for (const [name, text] of [["redirect", redirect], ["why", why ?? ""]] as const) {
    if (hasControl(text)) return refuse(`A rule's ${name} must not contain control characters`);
    if (text.trim().length > MAX_TEXT) return refuse(`A rule's ${name} must be at most ${MAX_TEXT} characters`);
  }

  const file = field("file");
  if (file !== undefined && typeof file !== "boolean") return refuse("A rule's file, when given, is true (its match names files, not their contents) or false");

  return { ok: true, value: { match: match.value, except, deny: [first, ...rest], redirect: redirect.trim(), why: why?.trim(), file: file === true } };
}

/** The fields of a rule that matching reads. */
type RuleFields = Pick<Contract.ProtectedPath, "match" | "except" | "file">;

// How a rule meets a path. Every glob is compiled by picomatch, without
// extglobs; nothing here parses a glob beyond splitting it at '/'. That split
// is safe because a pattern never holds '/' or '**' inside a group (the
// check refuses both), and any part holding '**' is treated as spanning any
// number of path parts.
//
// Matching sees dotfiles. A rule's `match` ignores case, as the file systems
// of macOS and Windows do, so a rule cannot be dodged by changing case; its
// `except` is matched exactly, so a carve-out never grows. A match ending in
// a literal name also covers everything under that name, as in .gitignore,
// unless the rule is a file rule (`file: true`), which covers exactly its
// paths: then a filter that cannot match the name keeps a listing from it.

type Test = (text: string) => boolean;

interface Compiled {
  readonly match: Test;
  readonly except: readonly Test[];
  /** Each part of the match, as a test of one path part; null for a part that may span parts. */
  readonly parts: readonly (Test | null)[];
  /** The match's last part when it names the files themselves: a glob of one part, such as '*.pem', or a file rule's name. */
  readonly tail: string | undefined;
  /** Each `except` that ends in '**', as tests of its leading parts. */
  readonly subtrees: readonly (readonly Test[])[];
}

const DENYING = { dot: true, nocase: true, noextglob: true } as const;
const EXACT = { dot: true, noextglob: true } as const;
const compiled = new WeakMap<RuleFields, Compiled>();
const isGlob = (text: string): boolean => picomatch.scan(text).isGlob;

function compile(rule: RuleFields): Compiled {
  const known = compiled.get(rule);
  if (known !== undefined) return known;
  const parts = rule.match.split("/");
  const last = parts[parts.length - 1] ?? "";
  const name = !isGlob(last) && rule.file !== true;
  const except = rule.except;
  const made: Compiled = {
    match: picomatch(name ? [rule.match, `${rule.match}/**`] : rule.match, DENYING),
    except: except.map((pattern) => picomatch(pattern, EXACT)),
    parts: [...parts.map((part) => (part.includes("**") ? null : picomatch(part, DENYING))), ...(name ? [null] : [])],
    tail: name || last.includes("**") ? undefined : last,
    subtrees: except
      .filter((pattern) => pattern === "**" || pattern.endsWith("/**"))
      .map((pattern) => pattern.split("/").slice(0, -1).map((part) => picomatch(part, EXACT))),
  };
  compiled.set(rule, made);
  return made;
}

const partsOf = (path: string): string[] => (path === "." ? [] : path.split("/"));

/**
 * Whether no root or filter can keep a listing away from the rule: it is
 * `**`-led, so it reaches from every root, and ends in a literal name, which
 * covers that name's contents, so no filter rules it out.
 */
function unavoidableRule(rule: RuleFields): boolean {
  return rule.match.split("/")[0] === "**" && !filterableRule(rule);
}

/** Whether a file-name filter can ever keep a listing away from the rule: only when its last part names the files themselves. */
function filterableRule(rule: RuleFields): boolean {
  return compile(rule).tail !== undefined;
}

/** Whether the rule applies to this exact path: its match covers it and none of its exceptions does. */
function matchesRule(rule: RuleFields, path: string): boolean {
  const { match, except } = compile(rule);
  return match(path) && !except.some((test) => test(path));
}

/**
 * Whether a file name passing `filter` provably cannot match the rule's
 * one-part glob `tail`. Only cheap, certain cases: a literal filter the tail
 * does not match; two pure suffixes (`*.pem`, `*.ts`) neither of which ends
 * the other; two pure prefixes (`key*`, `id*`) neither of which starts the
 * other. A filter with '/' or '**' proves nothing. Anything else may share a
 * name: `.env*` and `*.tsx` both match `.env.tsx`.
 */
function outOfReach(tail: string, filter: string): boolean {
  if (filter.includes("/") || filter.includes("**")) return false;
  // A file rule's literal name: the filter is a glob over names, so ask it directly.
  if (!isGlob(tail)) return !picomatch(filter, DENYING)(tail);
  if (!isGlob(filter)) return !picomatch(tail, DENYING)(filter);
  const [a, b] = [tail.toLowerCase(), filter.toLowerCase()];
  const suffix = (glob: string) => (glob.startsWith("*") && !isGlob(glob.slice(1)) ? glob.slice(1) : undefined);
  const prefix = (glob: string) => (glob.endsWith("*") && !isGlob(glob.slice(0, -1)) ? glob.slice(0, -1) : undefined);
  const [sa, sb, pa, pb] = [suffix(a), suffix(b), prefix(a), prefix(b)];
  if (sa !== undefined && sb !== undefined) return !sa.endsWith(sb) && !sb.endsWith(sa);
  if (pa !== undefined && pb !== undefined) return !pa.startsWith(pb) && !pb.startsWith(pa);
  return false;
}

/**
 * Whether listing or searching `root` (limited by a file-name `filter`, or
 * null) could reach a path the rule applies to. Conservative: it answers no
 * only when that is provable.
 *
 * - The root itself counts. Otherwise the match's parts are walked along the
 *   root's parts: a spanning part, or a match longer than the root whose
 *   parts all fit, could reach below it; a part that does not fit cannot. So
 *   `packages/db/**` reaches from `packages` and `packages/db/src`, never from
 *   `docs`; `**`-led patterns reach from everywhere.
 * - An exception helps only when it covers the whole root: it ends in '**'
 *   and its leading parts fit the root's first parts.
 * - A filter helps only when it provably cannot name a path the match ends
 *   in (see outOfReach). A match ending in a literal name covers that name's
 *   contents, which may have any name, so no filter rules it out.
 */
function reachesRule(rule: RuleFields, root: string, filter: string | null): boolean {
  const { tail } = compile(rule);
  return below(rule, root, true) && (filter === null || tail === undefined || !outOfReach(tail, filter));
}

/**
 * Whether deleting `path` could delete a path the rule applies to, if the
 * path is a directory. The guard cannot know whether it is, so this walks
 * the match only up to its first spanning part: `packages/db/**` is reached
 * from `packages`, and every rule from '.', but `**`-led rules are not
 * reached from every path, or no file could ever be deleted. Deleting a
 * directory holding a file that only a `**`-led rule protects is a known gap.
 */
function containsRule(rule: RuleFields, path: string): boolean {
  return below(rule, path, false);
}

/** The root itself, or a path below it, may be one the rule applies to (see reaches); spanning parts count when `spans`. */
function below(rule: RuleFields, root: string, spans: boolean): boolean {
  const { parts, subtrees } = compile(rule);
  const under = partsOf(root);
  const within = (): boolean => {
    for (const [i, part] of under.entries()) {
      const test = parts[i];
      if (test === null) return spans;
      if (test === undefined || !test(part)) return false;
    }
    return parts.length > under.length;
  };
  if (!(matchesRule(rule, root) || within())) return false;
  return !subtrees.some((leading) => leading.length <= under.length && leading.every((test, i) => test(under[i] ?? "")));
}

class ProtectedPathImpl implements Contract.ProtectedPath {
  declare readonly __brand: "ProtectedPath";
  declare readonly [protectedPathBrand]: true;
  readonly #made = true;
  declare readonly why?: string;
  declare readonly file?: true;

  readonly match: string;
  readonly except: readonly string[];
  readonly deny: readonly [PathAccess, ...PathAccess[]];
  readonly redirect: string;

  private constructor(fields: Fields) {
    this.match = fields.match;
    this.except = Object.freeze([...fields.except]);
    this.deny = Object.freeze([...fields.deny] as const);
    this.redirect = fields.redirect;
    if (fields.why !== undefined) this.why = fields.why;
    if (fields.file) this.file = true;
    Object.freeze(this);
  }

  /** Whether `raw` was made by this class (not merely an object that inherits from one): parse checks its wire form again, since a constructor can be called at run time. */
  /** Whether the rule applies to this exact path: its match covers it and none of its exceptions does. */
  matches(path: string): boolean {
    return matchesRule(this, path);
  }

  /** Whether listing or searching `root`, limited by a file-name `filter` or none, could reach a path the rule applies to. Conservative. */
  reaches(root: string, filter: string | null): boolean {
    return reachesRule(this, root, filter);
  }

  /** Whether deleting `path`, if it is a directory, could delete a path the rule applies to. */
  contains(path: string): boolean {
    return containsRule(this, path);
  }

  /** Whether no root or filter can keep a listing away from the rule. */
  unavoidable(): boolean {
    return unavoidableRule(this);
  }

  /** Whether a file-name filter can ever keep a listing away from the rule. */
  filterable(): boolean {
    return filterableRule(this);
  }

  static made(raw: unknown): raw is ProtectedPathImpl {
    return typeof raw === "object" && raw !== null && #made in raw;
  }

  static parse(raw: unknown): Result<ProtectedPath> {
    if (ProtectedPathImpl.made(raw)) return ProtectedPathImpl.parse(wireFormOf(raw));
    const fields = check(raw);
    return fields.ok ? { ok: true, value: new ProtectedPathImpl(fields.value) } : fields;
  }

  equals(other: ProtectedPath): boolean {
    return sameWire(this, other);
  }

  toJSON(): Contract.ProtectedPathJSON {
    const json = { match: this.match, except: this.except, deny: this.deny, redirect: this.redirect };
    return { ...json, ...(this.why === undefined ? {} : { why: this.why }), ...(this.file === true ? { file: true } : {}) };
  }
}

export type ProtectedPath = Contract.ProtectedPath;
export const ProtectedPath: Contract.ProtectedPathFactory = ProtectedPathImpl;

/**
 * The protected-paths pack's point, as declared in its pack: deny-only path rules. The
 * pack ships none of its own (ADR 2026-009): selected with no rules, it
 * protects nothing. The defaults that keep agents off the project's
 * guardrails (`**\/bounded.config.*` and `.bounded/**`) are in the
 * configuration `bounded init` writes, where the project can see and change them.
 */
export const protectedPathsPoint = point({
  description: "Deny-only path rules: what no agent may read, list, create, modify or delete, and what to do instead",
  check: ProtectedPath.parse,
  values: [],
});

/** The protected-paths pack's protected paths in a composition: the point its pack made from protectedPathsPoint, or undefined when it is not selected. */
export const protectedPathsIn: Contract.ProtectedPathsIn = (composition) => composition.pointDeclaredBy(protectedPathsPoint);
