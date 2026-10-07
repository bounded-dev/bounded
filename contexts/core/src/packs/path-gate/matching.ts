import picomatch from "picomatch";
import type { ProtectedPath } from "./protected-path.ts";

// How a rule meets a path. Every glob is compiled by picomatch, without
// extglobs; nothing here parses a glob beyond splitting it at '/'. That split
// is safe because a pattern never holds '/' or '**' inside a group (the
// check refuses both), and any part holding '**' is treated as spanning any
// number of path parts.
//
// Matching sees dotfiles. A rule's `match` ignores case, as the file systems
// of macOS and Windows do, so a rule cannot be dodged by changing case; its
// `except` is matched exactly, so a carve-out never grows. A match ending in
// a literal name also covers everything under that name, as in .gitignore.

type Test = (text: string) => boolean;

interface Compiled {
  readonly match: Test;
  readonly except: readonly Test[];
  /** Each part of the match, as a test of one path part; null for a part that may span parts. */
  readonly parts: readonly (Test | null)[];
  /** The match's last part when it is a glob of one part, such as '*.pem'. */
  readonly tail: string | undefined;
  /** Each `except` that ends in '**', as tests of its leading parts. */
  readonly subtrees: readonly (readonly Test[])[];
}

const DENYING = { dot: true, nocase: true, noextglob: true } as const;
const EXACT = { dot: true, noextglob: true } as const;
const compiled = new WeakMap<ProtectedPath, Compiled>();
const isGlob = (text: string): boolean => picomatch.scan(text).isGlob;

function compile(rule: ProtectedPath): Compiled {
  const known = compiled.get(rule);
  if (known !== undefined) return known;
  const parts = rule.match.split("/");
  const last = parts[parts.length - 1] ?? "";
  const name = !isGlob(last);
  const except = rule.except ?? [];
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
export function unavoidable(rule: ProtectedPath): boolean {
  const parts = rule.match.split("/");
  return parts[0] === "**" && !isGlob(parts[parts.length - 1] ?? "**");
}

/** Whether the rule applies to this exact path: its match covers it and none of its exceptions does. */
export function matches(rule: ProtectedPath, path: string): boolean {
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
export function reaches(rule: ProtectedPath, root: string, filter: string | null): boolean {
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
export function contains(rule: ProtectedPath, path: string): boolean {
  return below(rule, path, false);
}

/** The root itself, or a path below it, may be one the rule applies to (see reaches); spanning parts count when `spans`. */
function below(rule: ProtectedPath, root: string, spans: boolean): boolean {
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
  if (!(matches(rule, root) || within())) return false;
  return !subtrees.some((leading) => leading.length <= under.length && leading.every((test, i) => test(under[i] ?? "")));
}
