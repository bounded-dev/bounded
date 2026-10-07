import picomatch from "picomatch";
import type { ProtectedPath } from "./protected-path.ts";

// How a rule meets a path. Every glob is compiled by picomatch; nothing here
// parses a glob by hand beyond splitting it into its '/'-separated parts,
// which is sound because a pattern never has '/' inside a group.
//
// Matching sees dotfiles. A rule's `match` ignores case, as the file systems
// of macOS and Windows do, so a rule cannot be dodged by changing case; its
// `except` is matched exactly, so a carve-out never grows.

type Test = (text: string) => boolean;

interface Compiled {
  readonly match: Test;
  readonly except: readonly Test[];
  /** Each part of `match`, as a test of one path part; null for a '**' part. */
  readonly parts: readonly (Test | null)[];
  /** The last part of `match` when it is a literal name, such as '.env'. */
  readonly name: string | undefined;
  /** Each `except` that ends in '**', as tests of its leading parts. */
  readonly subtrees: readonly (readonly Test[])[];
}

const DENYING = { dot: true, nocase: true } as const;
const EXACT = { dot: true } as const;
const compiled = new WeakMap<ProtectedPath, Compiled>();

function compile(rule: ProtectedPath): Compiled {
  const known = compiled.get(rule);
  if (known !== undefined) return known;
  const parts = rule.match.split("/");
  const last = parts[parts.length - 1] ?? "";
  const except = rule.except ?? [];
  const made: Compiled = {
    match: picomatch(rule.match, DENYING),
    except: except.map((pattern) => picomatch(pattern, EXACT)),
    parts: parts.map((part) => (part === "**" ? null : picomatch(part, DENYING))),
    name: picomatch.scan(last).isGlob ? undefined : last,
    subtrees: except.filter((pattern) => pattern === "**" || pattern.endsWith("/**")).map((pattern) => pattern.split("/").slice(0, -1).map((part) => picomatch(part, EXACT))),
  };
  compiled.set(rule, made);
  return made;
}

const partsOf = (path: string): string[] => (path === "." ? [] : path.split("/"));

/** Whether the rule applies to this exact path: its match matches and none of its exceptions does. */
export function matches(rule: ProtectedPath, path: string): boolean {
  const { match, except } = compile(rule);
  return match(path) && !except.some((test) => test(path));
}

/**
 * Whether listing (or searching) `root`, limited by a file-name `filter`,
 * could reach a path the rule applies to. Conservative: it answers no only
 * when that is provable.
 *
 * - The root itself matching counts. Otherwise the match's parts are walked
 *   along the root's parts: a '**' part, or a match longer than the root
 *   whose parts all fit, could reach below it; a part that does not fit
 *   cannot. So `packages/db/**` reaches from `packages` and `packages/db/src`,
 *   never from `docs`; `**`-led patterns reach from everywhere.
 * - An exception helps only when it covers the whole root: it ends in '**'
 *   and its leading parts fit the root's first parts.
 * - A filter helps only when the match ends in a literal name the filter
 *   does not match (`config/.env` is out of reach of `*.ts`). Two globs, such
 *   as `.env*` and `*.tsx`, may both match one name ('.env.tsx'), so a filter
 *   never rules out a glob.
 */
export function reaches(rule: ProtectedPath, root: string, filter: string | null): boolean {
  const { parts, name, subtrees } = compile(rule);
  const under = partsOf(root);
  const within = (): boolean => {
    for (const [i, part] of under.entries()) {
      const test = parts[i];
      if (test === null) return true;
      if (test === undefined || !test(part)) return false;
    }
    return parts.length > under.length;
  };
  if (!(matches(rule, root) || within())) return false;
  if (subtrees.some((leading) => leading.length <= under.length && leading.every((test, i) => test(under[i] ?? "")))) return false;
  if (filter !== null && name !== undefined && !picomatch(filter.split("/").pop() ?? filter, DENYING)(name)) return false;
  return true;
}
