// Typecheck routing (TN-26-001, issue #7).
//
// A passing suite with tsc errors is a FALSE GREEN (dogfood Run 3: green-gate
// said 22/22 while two `noUncheckedIndexedAccess` errors sat in the test
// file). Type errors are therefore a phase-gate failure — but "the project
// does not compile" is only actionable if the gate also says WHO can fix it:
// the builder is blind to `tests/**` and the path gate would refuse its edit
// anyway, so a test-file type error must bounce to the test-writer, not to
// whoever happens to be running.
//
// Pure: parses redacted tsc diagnostics (see typecheck.ts), attributes each to
// the role whose write zone owns the file, and picks one bounce target.

import {
  contractGlobs,
  generatedFileGlobsFor,
  hasTestFileSuffix,
  mergedContribution,
  pathGlobMatcher,
  sourceRootOf,
  sourceRootsFor,
  testFileSuffixesFor,
} from "../../../src/pack-contrib.ts";
import { ownerOfPath, type Role } from "../../../src/path-policy.ts";
import { readProjectPacks } from "../../../src/project-composition.ts";

/** Who repairs a diagnostic. `orchestrator` = no pipeline role may write the file. */
export type FixOwner = Role | "orchestrator";

// Furthest-upstream first: infrastructure nobody may touch, then the pipeline's
// own production order (contract → tests → implementation). Fixing downstream
// of a broken upstream artifact is wasted work, so the earliest owner in this
// order gets the bounce.
export const OWNERS_UPSTREAM_FIRST: readonly FixOwner[] = [
  "orchestrator",
  "architect",
  "test-writer",
  "builder",
];

export interface TypecheckRouting {
  readonly errorCount: number;
  /** The single bounce target: the furthest-upstream owner. Undefined when clean. */
  readonly route?: FixOwner;
  /** Owners with at least one error, upstream-first. */
  readonly owners: readonly FixOwner[];
  /** Diagnostic lines (with their continuation lines) grouped by owner, in tsc order. */
  readonly byOwner: Readonly<Partial<Record<FixOwner, readonly string[]>>>;
}

// `--pretty false` diagnostics: `path(line,col): error TS1234: message`, or a
// path-less global error (`error TS18003: No inputs were found…`). The leading
// `[^\s(]` keeps indented continuation lines out — they belong to the
// diagnostic above them.
const LOCATED_ERROR = /^([^\s(][^(]*)\(\d+,\d+\):\s+error TS\d+/;
const GLOBAL_ERROR = /^error TS\d+/;

// The same location prefix WITHOUT the `error TS` requirement: tsc's related
// information ("…is declared here", "the expected type comes from…") is
// emitted as its own located line and names its own file. Routing ignores
// those lines; typecheck-scope.ts needs their file to decide who may see them.
const LOCATED_LINE = /^([^\s(][^(]*)\(\d+,\d+\):\s/;

/** Does this line START a diagnostic (located or global)? */
export function isDiagnosticStart(line: string): boolean {
  return LOCATED_ERROR.test(line) || GLOBAL_ERROR.test(line);
}

/** The file a located diagnostic names; undefined for a global or non-error line. */
export function diagnosticPath(line: string): string | undefined {
  return LOCATED_ERROR.exec(line)?.[1];
}

/** The file ANY located line names — diagnostics and related information alike. */
export function locatedPath(line: string): string | undefined {
  return LOCATED_LINE.exec(line)?.[1];
}

/** The furthest-upstream owner of the given set, or undefined if empty. */
export function mostUpstream(owners: readonly FixOwner[]): FixOwner | undefined {
  return OWNERS_UPSTREAM_FIRST.find((o) => owners.includes(o));
}

/** Who may write a project-relative path; null when no pipeline role may. */
export type OwnerOf = (path: string) => Role | null;

/** The project layout suffix ownership reads (ADRs 2026-056 to 2026-058). */
export interface SuffixLayout {
  readonly sourceRoots: readonly string[];
  readonly testSuffixes: readonly string[];
  readonly contractSuffixes: readonly string[];
  readonly generatedGlobs: readonly string[];
}

/**
 * Ownership by file suffix (ADR 2026-057; TN-26-012 §7 and §8), the policy
 * WI-2 is moving `ownerOfPath` onto. Until that lands, this is its stand-in
 * with the same answers, so the gates route a monorepo's diagnostics now:
 * a generated file (a composed `generatedFileGlobs` match) and anything
 * outside every source root has no owner; a contract is the architect's; a
 * test-side file (`testFileSuffixes`) the test-writer's; any other file
 * under a source root the builder's. Matching ignores case.
 */
export function suffixOwnerOf(layout: SuffixLayout): OwnerOf {
  const isGenerated = pathGlobMatcher(layout.generatedGlobs);
  const contracts = layout.contractSuffixes.map((s) => s.toLowerCase());
  return (path) => {
    const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
    if (normalized.startsWith("/") || normalized.split("/").includes("..")) return null;
    if (isGenerated(normalized)) return null;
    if (sourceRootOf(normalized, layout.sourceRoots) === undefined) return null;
    const lower = normalized.toLowerCase();
    if (contracts.some((suffix) => lower.endsWith(suffix))) return "architect";
    if (hasTestFileSuffix(normalized, layout.testSuffixes)) return "test-writer";
    return "builder";
  };
}

/**
 * The owner function for a project: suffix ownership when the composition
 * contributes source roots (a monorepo layout), the path policy's
 * directory zones otherwise. An unreadable composition falls back to the
 * zones with no contract globs, which route every source file to the
 * orchestrator rather than guess.
 */
export function projectOwnerOf(cwd: string, packsDir?: string): OwnerOf {
  try {
    const packs = readProjectPacks(cwd);
    const roots = sourceRootsFor(packs, packsDir);
    if (roots.length > 0) {
      return suffixOwnerOf({
        sourceRoots: roots,
        testSuffixes: testFileSuffixesFor(packs, packsDir),
        contractSuffixes: mergedContribution("contractFileSuffixes", packs, packsDir),
        generatedGlobs: generatedFileGlobsFor(packs, packsDir),
      });
    }
    const contracts = contractGlobs(cwd, packsDir);
    return (path) => ownerOfPath(path, contracts);
  } catch {
    return (path) => ownerOfPath(path, "unreadable");
  }
}

/** Attribute redacted tsc diagnostics to the roles that may fix them.
 *  `ownership` is either the composed packs' contract globs
 *  (`contractGlobs(cwd)`, judged by the path policy's zones; empty means no
 *  pack-declared contract files) or an owner function such as
 *  {@link projectOwnerOf}. */
export function routeTypecheck(
  diagnostics: readonly string[],
  ownership: readonly string[] | OwnerOf = [],
): TypecheckRouting {
  const ownerOf: OwnerOf = typeof ownership === "function" ? ownership : (path) => ownerOfPath(path, ownership);
  const groups = new Map<FixOwner, string[]>();
  let errorCount = 0;
  let current: FixOwner | undefined;

  for (const line of diagnostics) {
    const located = diagnosticPath(line);
    if (located !== undefined) {
      current = ownerOf(located) ?? "orchestrator";
      errorCount += 1;
    } else if (GLOBAL_ERROR.test(line)) {
      current = "orchestrator";
      errorCount += 1;
    } else if (current === undefined || !/^\s/.test(line)) {
      // Not a diagnostic and not a continuation of one (summaries such as
      // "Found 2 errors."): attribute nothing.
      current = undefined;
      continue;
    }
    const bucket = groups.get(current);
    if (bucket) bucket.push(line);
    else groups.set(current, [line]);
  }

  const owners = OWNERS_UPSTREAM_FIRST.filter((o) => groups.has(o));
  const byOwner: Partial<Record<FixOwner, readonly string[]>> = {};
  for (const o of owners) byOwner[o] = groups.get(o);
  return { errorCount, route: mostUpstream(owners), owners, byOwner };
}

/** Indented gate-output lines for a failing typecheck, grouped by who may fix
 *  each diagnostic. Empty when clean. The gate itself prints the single route
 *  line; this section only attributes. */
export function typecheckLines(routing: TypecheckRouting): string[] {
  if (routing.errorCount === 0) return [];
  const lines = [
    `  typecheck: ${routing.errorCount} type error${routing.errorCount === 1 ? "" : "s"}`,
  ];
  for (const owner of routing.owners) {
    const group = routing.byOwner[owner] ?? [];
    const count = group.filter(isDiagnosticStart).length;
    lines.push(`  ${owner} (${count}):`);
    for (const line of group) lines.push(`    ${line}`);
  }
  return lines;
}
