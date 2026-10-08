import type { Result } from "bounded/domain";
import picomatch from "picomatch";
import type * as Contract from "./protected-path.contract.ts";
import { sameWire, wireFormOf } from "./wire.ts";
import type { PathAccess } from "./protected-path.contract.ts";

const ACCESSES: readonly PathAccess[] = ["read", "list", "create", "modify", "delete"];

/** Every kind of write, for `deny: [...writes]`. A stored rule always lists its kinds explicitly. */
export const writes = Object.freeze(["create", "modify", "delete"] as const);

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
    return refuse(`A rule cannot deny '${String(unknown)}': it denies read, list, create, modify or delete (spread \`writes\` for every write)`);
  }
  const [first, ...rest] = ACCESSES.filter((access) => deny.includes(access));
  if (first === undefined) return refuse(DENY);
  if (deny.includes("modify") && !deny.includes("create") && !deny.includes("delete")) {
    return refuse("A rule that denies modify must also deny create or delete: otherwise deleting and creating the file changes it (spread `writes`)");
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

class ProtectedPathImpl implements Contract.ProtectedPath {
  declare readonly __brand: "ProtectedPath";
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
