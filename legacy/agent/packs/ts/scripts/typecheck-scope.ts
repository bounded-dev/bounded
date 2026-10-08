// Typecheck scoping — the blindness half of the `typecheck` worker tool
// (dogfood Run 15).
//
// `run_tests` is sanitized and the path gate refuses a worker's read of the
// other zone, but `typecheck` returned RAW project-wide diagnostics to every
// caller — so the tool was a hole in the wall the other two layers build.
// Run 15's transcripts show it leaking in BOTH directions with shipped-code
// consequences:
//
//   · the builder read `tests/billing.test.ts(5,3): … declares 'CalendarDate'
//     locally, but it is not exported` out of its own typecheck, reasoned
//     "tests are importing value objects from billing.js … billing.ts needs to
//     re-export", and added that re-export block. Implementation shaped to
//     test source it may never read — and it shipped.
//   · the test-writer read the builder's in-progress implementation the same
//     way ("the current src/billing/billing.ts is stale: it implements the new
//     parse* parsers but returns the old values.ts nominal types").
//
// So a worker's typecheck is SCOPED BY ITS ROLE, using the same ownership
// function the gates route with (ownerOfPath) and the same read decision the
// path gate enforces (decide). Diagnostics in the caller's own zone, in the
// shared interface (the contracts and spec.md, architect-owned by the path policy), and
// in files the caller could legally read (project config included: no role
// owns it, ADR LEG-2026-054) are shown in full. Everything else collapses to a
// COUNT plus the owning role: no path, no line number, no message, no symbol
// name. A symbol name
// was the exact leak vector, so the shown lines are additionally scrubbed of
// any foreign path token — a second line of defence, the way sanitizeMessage
// is for run_tests.
//
// The verdict stays honest in the one shape that matters: clean-in-your-zone
// while red elsewhere never renders as "OK", or a worker ships on a false
// clean.
//
// Pure: no fs, no spawn, no logging. The tool wiring (hosts/pi/extensions/dev-tools.ts)
// resolves the role and writes the guard event.

import { decide, ownerOfPath, UNREADABLE_LAYOUT, type PathLayout, type Role } from "../../../src/path-policy.ts";
import { diagnosticPath, isDiagnosticStart, locatedPath } from "./typecheck-routing.ts";
import { formatTypecheck, type TypecheckResult } from "./typecheck.ts";

/** Roles whose typecheck view is scoped. The architect reads everything the
 *  pipeline produces (and arbitrates between the two blind roles), so scoping
 *  it would remove information it is entitled to and hide nothing. */
export const SCOPED_ROLES: readonly Role[] = ["test-writer", "builder", "reviewer"];

/** Is this caller's view scoped? Unbound sessions (undefined) are not. */
export function isScopedRole(role: Role | undefined): role is Role {
  return role !== undefined && SCOPED_ROLES.includes(role);
}

/** What the caller may see of one diagnostic, and who owns it when it may not. */
type Visibility = { readonly visible: true } | { readonly visible: false; readonly owner?: Role };

const VISIBLE: Visibility = { visible: true };

/**
 * May `role` see a diagnostic located in `path`?
 *
 * Ownership first (the routing rule the gates already use), then the path
 * gate's own read decision for files no pipeline role owns — so a generated
 * file (no role may write it, every role may read it, ADR LEG-2026-058) is shown,
 * and a file the layout cannot place (an unreadable composition) is not.
 */
export function visibilityOf(
  path: string | undefined,
  role: Role,
  layout: PathLayout = UNREADABLE_LAYOUT,
): Visibility {
  // A path-less global error (`error TS18003: No inputs were found…`) is a
  // project-level failure that blocks everyone and names no zone. Shown — and
  // scrubbed below, in case its message quotes a foreign file.
  if (path === undefined) return VISIBLE;
  const owner = ownerOfPath(path, layout);
  if (owner === role) return VISIBLE;
  // The shared interface: contracts and spec.md, which the architect owns.
  // Declaration-only by construction, and every role works against them —
  // this is where the blindness is NOT. Project config has no owner (no role
  // may write it, ADR LEG-2026-054) and is judged by the read arm below.
  if (owner === "architect") return VISIBLE;
  if (owner !== null) return { visible: false, owner };
  // Unowned. Visible only if the path gate would let this role read the file,
  // so the scoping can never be laxer than the gate it backs up.
  return decide(role, "read", { path }, { cwd: "/", ...layout }).allow
    ? VISIBLE
    : { visible: false };
}

// Path-shaped tokens in otherwise-visible text: the second line of defence.
// A diagnostic on the caller's own file may still quote another role's file
// in its message, and one symbol or path is all the leak ever needed.
const PATH_TOKEN =
  /(?:\.{1,2}\/)?[\w.-]+(?:\/[\w.-]+)+\.(?:tsx?|mts|cts|jsx?|mjs|cjs|json|md)\b(?:\(\d+,\d+\))?/g;

const FOREIGN_PLACEHOLDER = "[another role's file]";

/** Replace every path token the role may not see with a fixed placeholder. */
export function scrubForeignPaths(line: string, role: Role, layout: PathLayout = UNREADABLE_LAYOUT): string {
  return line.replace(PATH_TOKEN, (token) => {
    const path = token.replace(/\(\d+,\d+\)$/, "");
    return visibilityOf(path, role, layout).visible ? token : FOREIGN_PLACEHOLDER;
  });
}

/** How many errors are hidden, and whose zone they are in. */
export interface HiddenGroup {
  /** The role whose zone owns them. Absent when no pipeline role owns the file. */
  readonly owner?: Role;
  readonly count: number;
}

export interface ScopedTypecheck {
  /** The caller's role, when its view was scoped. */
  readonly role?: Role;
  readonly scoped: boolean;
  /** tsc's own verdict — never softened by scoping. */
  readonly ok: boolean;
  /** tsc exited non-zero but produced no parseable diagnostic (it failed to run). */
  readonly blocked: boolean;
  /** Errors the caller may see and may fix. */
  readonly shown: number;
  /** Errors collapsed to a count. */
  readonly hidden: number;
  /** Hidden counts grouped by owning zone, upstream-first. */
  readonly hiddenGroups: readonly HiddenGroup[];
  /** The furthest-upstream hidden owner, for the guard log. */
  readonly hiddenOwner?: Role;
  /** Visible diagnostic lines, scrubbed. */
  readonly diagnostics: readonly string[];
}

// Upstream-first, matching typecheck-routing's bounce order, so a multi-owner
// hidden set reports the owner who must move first.
const HIDDEN_OWNER_ORDER: readonly Role[] = ["architect", "test-writer", "builder"];

/**
 * Scope a raw typecheck result to what `role` may see.
 *
 * `role` undefined, or the architect, returns the result untouched: both may
 * read everything the pipeline produces anyway, so scoping would only cost
 * them information.
 */
/** `layout`: the composed path layout (`pathLayoutOrUnreadable(cwd)`).
 *  Omitted, it is unreadable: no source file is the caller's, so everything
 *  under a possible source root collapses to a count. */
export function scopeTypecheck(
  result: TypecheckResult,
  role: Role | undefined,
  layout: PathLayout = UNREADABLE_LAYOUT,
): ScopedTypecheck {
  if (!isScopedRole(role)) {
    return {
      ...(role !== undefined ? { role } : {}),
      scoped: false,
      ok: result.ok,
      blocked: false,
      shown: result.errorCount,
      hidden: 0,
      hiddenGroups: [],
      diagnostics: result.diagnostics,
    };
  }

  const shownLines: string[] = [];
  const hiddenCounts = new Map<Role | "", number>();
  let shown = 0;
  let counted = 0;
  // The visibility of the diagnostic currently being read, so indented
  // continuation lines follow the line they belong to.
  let current: Visibility | undefined;

  for (const line of result.diagnostics) {
    if (isDiagnosticStart(line)) {
      current = visibilityOf(diagnosticPath(line), role, layout);
      counted += 1;
      if (current.visible) shown += 1;
      else bump(hiddenCounts, current.owner);
    } else if (/^\s/.test(line) && current !== undefined) {
      // continuation of the diagnostic above — inherits its visibility
    } else {
      // A located NON-error line is tsc's related information ("…is declared
      // here"), which carries its own file and so its own visibility. Anything
      // else (summaries, reporter noise) belongs to no diagnostic and is
      // dropped: it is not counted, so showing it could only mislead.
      const located = locatedPath(line);
      current = located === undefined ? undefined : visibilityOf(located, role, layout);
      if (current === undefined) continue;
    }
    if (current.visible) shownLines.push(scrubForeignPaths(line, role, layout));
  }

  // The total is tsc's own count where it is larger: a diagnostic this parser
  // could not attribute still happened, and must not vanish from the verdict.
  const total = Math.max(result.errorCount, counted);
  const hidden = Math.max(0, total - shown);
  const attributed = [...hiddenCounts.values()].reduce((a, b) => a + b, 0);
  const groups: HiddenGroup[] = [];
  for (const owner of HIDDEN_OWNER_ORDER) {
    const count = hiddenCounts.get(owner);
    if (count !== undefined && count > 0) groups.push({ owner, count });
  }
  const unowned = (hiddenCounts.get("") ?? 0) + (hidden - attributed);
  if (unowned > 0) groups.push({ count: unowned });

  const hiddenOwner = groups.find((g) => g.owner !== undefined)?.owner;
  return {
    role,
    scoped: true,
    ok: result.ok,
    blocked: !result.ok && total === 0,
    shown,
    hidden,
    hiddenGroups: groups,
    ...(hiddenOwner !== undefined ? { hiddenOwner } : {}),
    diagnostics: shownLines,
  };
}

function bump(counts: Map<Role | "", number>, owner: Role | undefined): void {
  const key = owner ?? "";
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

const plural = (n: number): string => (n === 1 ? "" : "s");

/** The one line a hidden group is allowed to say: count and owner, nothing else. */
export function hiddenLine(group: HiddenGroup): string {
  const them = group.count === 1 ? "it does" : "they do";
  const where =
    group.owner === undefined
      ? "outside your zone"
      : `in another role's zone (${group.owner}'s)`;
  return `typecheck: ${group.count} further error${plural(group.count)} ${where} — not yours to fix; ${them} not block you`;
}

/** Human-readable rendering of a scoped result — the worker-facing output. */
export function formatScopedTypecheck(scoped: ScopedTypecheck): string {
  if (!scoped.scoped) {
    return formatTypecheck({
      ok: scoped.ok,
      errorCount: scoped.shown,
      diagnostics: [...scoped.diagnostics],
    });
  }
  if (scoped.blocked) {
    return "typecheck: could not run — tsc exited non-zero without producing diagnostics. Report it; do not read this as clean.";
  }
  if (scoped.ok) return "typecheck: OK — no type errors";

  const foreign = scoped.hiddenGroups.map(hiddenLine);
  // Clean HERE while red elsewhere is its own verdict. Never "OK": a worker
  // that reads "OK" on a red project ships on a false clean.
  const head =
    scoped.shown === 0
      ? "typecheck: clean in your zone — no type errors you can fix"
      : `typecheck: ${scoped.shown} error${plural(scoped.shown)} in your zone`;
  const blocks = [head];
  if (scoped.shown > 0 && scoped.diagnostics.length > 0) blocks.push(scoped.diagnostics.join("\n"));
  if (foreign.length > 0) blocks.push(foreign.join("\n"));
  return blocks.join("\n\n");
}

/** Guard-log detail for one scoped run: counts and the owner, never content. */
export function scopeGuardDetail(
  scoped: ScopedTypecheck,
): Readonly<Record<string, unknown>> {
  return {
    ...(scoped.role !== undefined ? { role: scoped.role } : {}),
    scoped: scoped.scoped,
    shown: scoped.shown,
    hidden: scoped.hidden,
    hiddenOwner: scoped.hiddenOwner ?? null,
  };
}
