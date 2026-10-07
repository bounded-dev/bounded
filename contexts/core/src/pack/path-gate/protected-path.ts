import type { Result } from "bounded/domain";
import picomatch from "picomatch";

/** What a rule can deny on a path: reading it, listing it, or one kind of write. */
export type PathAccess = "read" | "list" | "create" | "modify" | "delete";
const ACCESSES: readonly PathAccess[] = ["read", "list", "create", "modify", "delete"];

/** Every kind of write, for `deny: [...writes]`. A stored rule always lists its kinds explicitly. */
export const writes = Object.freeze(["create", "modify", "delete"] as const);

/**
 * A protected-path rule: deny-only. It denies `deny` on every project path
 * its `match` glob matches, except the paths its own `except` globs match.
 * An exception never reaches another rule, and there are no allow rules, so
 * a denial from any rule wins. `redirect` is the permitted next step.
 */
export interface ProtectedPath {
  readonly match: string;
  readonly except?: readonly string[];
  readonly deny: readonly [PathAccess, ...PathAccess[]];
  readonly redirect: string;
  readonly why?: string;
}

export interface ProtectedPathFactory {
  /**
   * A frozen rule, stored explicitly: patterns tidied (NFC, no './', no empty
   * parts), deny in a fixed order without repeats, except always present. Or
   * why the value is not a rule. Patterns are project-relative globs that
   * picomatch compiles: never absolute, never with '..', never negated.
   */
  parse(raw: unknown): Result<ProtectedPath>;
}

const FORM = "A protected-path rule is { match, except?, deny, redirect, why? }";
const KEYS = ["match", "except", "deny", "redirect", "why"];
const DENY = `A rule's deny must name at least one of ${ACCESSES.join(", ")}`;
const ABSOLUTE = /^([/~]|[A-Za-z]:(\/|$))/;
const CLIMBS = /(^|[/{,(|])\.\.($|[/},)|])/;
const refuse = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** A '/' inside a {group}, (extglob) or [class] would let one segment span two parts of a path. */
function slashInGroup(text: string): boolean {
  let depth = 0;
  for (const char of text) {
    if ("{([".includes(char)) depth++;
    else if ("})]".includes(char)) depth = Math.max(0, depth - 1);
    else if (char === "/" && depth > 0) return true;
  }
  return false;
}

function pattern(raw: unknown, role: "match" | "except"): Result<string> {
  if (typeof raw !== "string") return refuse(`A rule's ${role} pattern must be text`);
  const text = raw.normalize("NFC").trim();
  const named = `A rule's ${role} pattern '${text}'`;
  if ([...text].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) return refuse(`${named} contains a control character`);
  if (text.includes("\\")) return refuse(`${named} contains '\\'. Separate its parts with '/'`);
  if (ABSOLUTE.test(text)) return refuse(`${named} is absolute. Patterns are relative to the project root, such as 'src/**'`);
  if (text.startsWith("!") && !text.startsWith("!(")) return refuse(`${named} is negated. A rule only denies: carve paths out of it with except`);
  if (CLIMBS.test(text)) return refuse(`${named} uses '..'. Patterns are relative to the project root and stay inside it`);
  if (slashInGroup(text)) return refuse(`${named} has '/' inside a group. Keep each group within one part of the path, or write two rules`);
  const tidy = text
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .join("/");
  if (tidy === "") return refuse(`A rule's ${role} pattern must not be empty`);
  try {
    picomatch.makeRe(tidy, { strictBrackets: true, dot: true });
  } catch (error) {
    return refuse(`${named} is not a valid glob: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { ok: true, value: tidy };
}

function parse(raw: unknown): Result<ProtectedPath> {
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
    except.push(checked.value);
  }

  const deny = field("deny");
  if (!Array.isArray(deny) || deny.length === 0) return refuse(DENY);
  const unknown = deny.find((kind) => !ACCESSES.some((access) => access === kind));
  if (unknown !== undefined) return refuse(`A rule cannot deny '${String(unknown)}': it denies read, list, create, modify or delete (spread \`writes\` for every write)`);
  const [first, ...rest] = ACCESSES.filter((access) => deny.includes(access));
  if (first === undefined) return refuse(DENY);

  const redirect = field("redirect");
  if (typeof redirect !== "string" || redirect.trim() === "") return refuse("A rule's redirect must say what to do instead");
  const why = field("why");
  if (why !== undefined && (typeof why !== "string" || why.trim() === "")) return refuse("A rule's why, when given, must be non-empty text");

  const rule: ProtectedPath = {
    match: match.value,
    except: Object.freeze(except),
    deny: Object.freeze([first, ...rest] as const),
    redirect: redirect.trim(),
    ...(why === undefined ? {} : { why: why.trim() }),
  };
  return { ok: true, value: Object.freeze(rule) };
}

export const ProtectedPath: ProtectedPathFactory = { parse };
