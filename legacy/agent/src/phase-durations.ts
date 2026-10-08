// Phase-duration telemetry (issue #13): where a run's minutes actually went.
//
// Every gate already timestamps itself into the guard log, so the shape of a
// run — how long DESIGN took, how many times TEST bounced, whether BUILD was
// the expensive part — is already recorded. It was simply never read back.
// "Measure before optimizing further" needs that read-back to exist, and it
// needs it to come from logged data rather than from anyone's recollection of
// the session.
//
// This module is the read-back: pure analysis over `readonly LoggedGuardEvent[]`,
// no I/O, no logging. It lives beside guard-log.ts rather than in packs/ts
// because a guard log is language-agnostic — a Python pack would emit the same
// event stream and deserve the same report. The caller supplies the events
// (`deliver` reads the target project's log and prints the block).
//
// ---------------------------------------------------------------------------
// The four phases and the markers that end them
// ---------------------------------------------------------------------------
//
// Phases are contiguous: each begins where the previous one ended, and each is
// closed by a marker that already exists in the log. The vocabulary is the
// phase gate's (`phase-gate.ts`) and green-gate's, deliberately — a second
// spelling of "the contract is frozen" would be a second, drifting definition
// of the DESIGN boundary.
//
//   DESIGN  first event                 → the freeze
//   TESTS   the test-writer's first      → the first `red-gate` pass
//           event, else the freeze
//   BUILD   the builder's first event,   → the first `green-gate` pass after it
//           else the first `red-gate` pass
//   WRAP    the first `green-gate` pass  → the last `sign-off`/`deliver` event
//
// WHERE A WORKER'S PHASE OPENS (r15)
//
// The gate markers say when a phase ENDED; only the workers themselves say
// when one began. Opening BUILD at the red-gate pass — the marker that closes
// TESTS — makes the two phases meet at a single event by construction, so the
// spans can touch but never overlap, and the parallel-workers row below could
// not fire on any log this analysis produced. That is a measurement lost to an
// artefact of the boundary, not to the run: the test-writer and the builder
// are commissioned in parallel (ADR 2026-021), and "tests 8m37s then build
// 5m42s" reads as 14m19s of sequence when the wall clock was 12m19s.
//
// So each worker phase opens at the first event ATTRIBUTABLE TO THAT WORKER.
// Two guards already carry the attribution and neither was added for this:
//
//   · `typecheck` events carry `detail.role` — the tool scopes its diagnostics
//     by the calling role, from the same binding the path gate acts on;
//   · `run_tests` events are the BUILDER's by construction, because run_tests
//     is builder-only (path-policy.ts) and enforced as such.
//
// The search runs from the freeze forward, so a worker event from an earlier
// ticket in a shared log cannot pull a boundary back behind the design that
// produced it, and the gate markers remain the fallback: a run whose workers
// logged nothing attributable measures exactly as it did before. The phase
// ENDS are untouched — a phase still ends where its gate says it ended.
//
// Two consequences, both accepted:
//
// * THE PHASES STOP BEING CONTIGUOUS when a worker opens its own. The minutes
//   between the freeze and the test-writer's first call are the architect's,
//   spent commissioning; billing them to TESTS was never right, and `totalMs`
//   still measures the whole run, so the gap is visible as the phases failing
//   to sum rather than hidden inside one of them.
// * PARTIAL ATTRIBUTION UNDERSTATES a phase: a builder that reads for ten
//   minutes before its first typecheck opens BUILD ten minutes late. The
//   fallback covers no attribution at all, not half of it. Worth knowing when
//   reading an old log — r15's own predates role-scoped typecheck, so only its
//   `run_tests` events are attributable — and self-correcting as the guards
//   that carry a role stay the ones workers reach for first.
//
// Block attribution is deliberately NOT moved with these boundaries. Blocks
// are placed by index between the gate markers (see "Bounces" below), which is
// what keeps a bounce on the line of the phase whose gate handed it back; the
// spans and the block regions have never been the same intervals (DESIGN's
// span already opens at the run-start marker while its region opens at the top
// of the log).
//
// "The freeze" is a `checksum-gate` pass whose summary says it wrote the
// manifest, or a `design-gate` pass (ADR 2026-019's composite, whose final
// step IS that write). Both fire on a composite run, milliseconds apart; taking
// the LAST freeze collapses them to one boundary. A `checksum-gate` pass that
// merely VERIFIED ("no drift") is not a freeze and must not be mistaken for
// one — that is the `check_drift` tool, which the architect may run at any
// point in the run.
//
// ---------------------------------------------------------------------------
// Edge semantics — every one of these is a decision, not an accident
// ---------------------------------------------------------------------------
//
// * PHASES THAT NEVER COMPLETED report `ms: undefined`, never 0. A run that
//   died in TEST did not spend zero minutes building; nothing is known about
//   its BUILD, and a zero would be a measurement it never made. Each such
//   phase carries `incomplete`, naming the earliest marker that is missing, so
//   the report says which step never happened rather than just "unknown".
//
// * MULTIPLE FREEZES (contract revised mid-loop, re-frozen, ADR 2026-019's
//   re-run path): DESIGN extends to the LAST freeze that precedes the first
//   `red-gate` pass. A revision means the design was not finished at the first
//   freeze — the minutes spent revising are design minutes, and the freeze the
//   eventual red actually validated is the one that ended the phase. A freeze
//   AFTER the first red pass (Run 10's mid-loop revision) does not extend
//   DESIGN: by then TEST and BUILD are underway, and stretching DESIGN over
//   them would double-count the same wall clock. With no red pass at all,
//   DESIGN ends at the last freeze in the log — there is nothing downstream to
//   pin it against.
//
// * MARKERS ARE FOUND IN APPEND ORDER, NOT TIMESTAMP ORDER. The log is an
//   append-only file written by one gate at a time, so its order is the causal
//   truth of what ran; a system clock can be adjusted mid-run and a timestamp
//   cannot be trusted to sequence anything. Timestamps are used only to
//   measure spans whose endpoints append order has already fixed, and a span
//   that comes out negative (a clock that went backwards) is clamped to 0
//   rather than reported as a negative duration.
//
// * EVENTS WITH NO USABLE TIMESTAMP are dropped and counted (`skipped`).
//   `readGuardLog` already drops unparseable LINES; a parseable line whose
//   `ts` is missing or not a date is corrupt in the same way, and an event
//   that cannot be placed on the clock cannot bound a span.
//
// * MORE THAN ONE RUN IN A LOG: still taken as one run — but no longer blind
//   to where the run began. The path gate logs a `run-start` event at the
//   first gated tool call of a session (see "The clock" below), so a log that
//   carries one is measured from there. Without one (an ungated session, a log
//   written before the marker existed) the first event of a run is whichever
//   gate the architect happened to call first, indistinguishable from any
//   other event, and the headline says so. A project that puts two tickets
//   through the pipeline without clearing `.bounded/` still gets one merged report;
//   the DESIGN rule above absorbs the common case (revision inside one
//   ticket), and a genuine second ticket shows as an implausible total, which
//   is a visible symptom rather than a silent wrong answer.
//
// ---------------------------------------------------------------------------
// The clock: where the run starts (r15)
// ---------------------------------------------------------------------------
//
// Both r15 arms lost about fourteen minutes to a provider outage between the
// session opening and the prompt actually landing, and DESIGN silently ate it:
// 55m and 80m were logged for design phases that really took ~33m and ~58m.
// The first event in the log was the path gate's session-start tool strip —
// stamped when the session opened, which is not when the run started.
//
// So the path gate logs a `run-start` event at the FIRST gated tool call it
// evaluates in a session: the first moment the run is demonstrably doing work.
// When one is present the clock starts there — DESIGN opens at it, `totalMs`
// measures from it, and the headline names the time so the reader can see
// which minutes were excluded. When none is present nothing changes, and the
// old "taken as one run" caveat stands.
//
// Two decisions worth naming:
//
// * MULTIPLE RUN-STARTS resolve to the DRIVING session's — the architect's.
//   Only the architect stamps one now (src/path-gate.ts), but two cases still
//   put several before the first phase marker. A RESTART (a provider outage
//   re-opened the session) appends a second architect marker: the last one is
//   taken, because everything before it is still setup and the final restart is
//   the attempt that produced the run. An OLD LOG (r16, written before only the
//   architect stamped one) carries a marker per subagent session, and one can
//   fall between the architect's and the freeze — r16's reviewer marker at
//   12:57:35 did, and "the last run-start before the marker" picked it, cutting
//   DESIGN from ~21m to 2m45s. Filtering to the architect's role fixes both: the
//   subagent markers are ignored and the last architect one wins. A run-start
//   AFTER the first marker belongs to a second run in a shared log and is
//   ignored — moving the clock there would put the report's start after its own
//   DESIGN phase. With no architect-tagged marker at all (a synthetic log), the
//   earliest run-start before the marker stands in: the architect's first call
//   precedes any subagent spawn, so the earliest is the driver's.
//
// * THE CLOCK MOVES, NOT THE ATTRIBUTION. Blocks are still placed in phases by
//   index from the top of the log, so a refusal logged before the first gated
//   call still lands on DESIGN's line. It happened during the design phase; it
//   simply happened during minutes nobody was working, and hiding it would
//   lose a refusal to make an arithmetic identity tidier.
//
// ---------------------------------------------------------------------------
// Bounces
// ---------------------------------------------------------------------------
//
// A bounce is a hand-back to a role, and the log's own marker for that is the
// `route` a gate records in its event detail — the machine-readable twin of
// the single `route → <role>` line it prints. So: a BOUNCE is a `block` event
// carrying `detail.route`.
//
// Counting every `block` instead would double-count, because composite gates
// and their steps both log: a design-gate failure writes a `contract-purity`
// block AND a `design-gate` block, and a green-gate escape-hatch failure
// writes a `lint-src` block AND a `green-gate` block. One hand-back, two
// events. Those inner blocks — and `path-gate` denials, which refuse a single
// tool call rather than returning work to anyone — are still counted, as
// `unroutedBlocks`, so nothing disappears from the report.
//
// A block lands in a phase by INDEX, not by timestamp, for the same reason
// markers do. A block that falls in a stretch no pair of markers delimits is
// `unattributedBlocks`: with the boundary unknown it genuinely is not known
// which phase it belongs to, and guessing would put TEST's bounces on DESIGN's
// line.
//
// ---------------------------------------------------------------------------
// Friction vs iteration: two very different things that both log a block
// ---------------------------------------------------------------------------
//
// A bounce is work handed back on purpose: a gate found a defect and named
// whose it is. An UNROUTED block — one carrying no `detail.route` — is not one
// thing but two, and r15 proved that conflating them makes the headline lie.
// That run printed `friction: 31 unrouted blocks (typecheck 13, run_tests 8,
// git 4, …)`, which reads as a harness fighting its own workers. The
// transcripts said otherwise: all 21 typecheck/run_tests blocks were workers
// compiling and running their own suites and seeing red, which is the job, and
// the git blocks were archaeology that found nothing. Exactly ONE call was
// refused in the whole run.
//
//   REFUSAL   a guard said "you may not": the call did not happen. `path-gate`
//             (out-of-zone read or write), `phase-gate` (a spawn too early),
//             and any other gate block that names no route — including a
//             composite's inner step, such as the `contract-purity` block that
//             accompanies a routed `design-gate` block. Target: zero.
//
//   ITERATION a worker's own dev tool reported a red state: the call happened
//             and told the truth. `typecheck`, `run_tests`, `lint-*`. A
//             builder whose typecheck never errors is not iterating, it is
//             guessing. Target: whatever the work needs.
//
// The split is decided by GUARD NAME alone. The alternative — inferring the
// caller from the event — would need a provenance field no guard writes, and
// the guard name is already the thing that determines who logged it.
//
// Judgment calls, all three of them:
//
// * `git` is ITERATION. A non-zero git exit is `git log` on a path that never
//   existed — a search that missed, not a refusal. Counting it as friction
//   would put "the harness got in the way" on the architect's own archaeology,
//   which is what r15 did (4 of its 31).
//
// * `lint-src` / `lint-tests` are ITERATION wherever they are logged, worker
//   tool call or inner step of a gate. A lint block is always a report about
//   the code; when it is an inner step, the composite's OWN block carries the
//   route and is already counted as the bounce. Any future `lint-*` guard
//   inherits this by prefix rather than by being added to a list.
//
// * A composite's non-lint inner steps (`contract-purity`, and anything else
//   that blocks with no route) stay REFUSALS. They are a gate declining to
//   proceed, which is the same act path-gate performs; the vocabulary should
//   not change with the guard's position in a composite.
//
// Both tallies are kept, per phase and per run, and both are reported: the
// `friction:` line counts refusals only and keeps its target of zero, while
// `iteration:` prints the red-loops as the normal work they are. As before,
// the RUN totals include blocks no pair of markers could place — a denial in
// an unmeasurable stretch cost exactly what one inside DESIGN cost, and
// dropping it would make the headline disagree with the log.

import { RUN_START_GUARD, type LoggedGuardEvent } from "./guard-log.ts";

export type PhaseName = "design" | "tests" | "build" | "wrap";

/** The four phases, in the only order a run passes through them. */
export const PHASES: readonly PhaseName[] = ["design", "tests", "build", "wrap"];

export interface RouteCount {
  /** The role a gate handed the work back to (`detail.route`). */
  readonly route: string;
  readonly count: number;
}

export interface GuardCount {
  /** The guard that logged the block. */
  readonly guard: string;
  readonly count: number;
}

/**
 * The two kinds of unrouted block, kept apart. See the header: refusals are
 * calls that did not happen, iteration is work that did.
 */
export interface Friction {
  /** Guard refusals across the whole log, placed in a phase or not. Target: zero. */
  readonly refusals: number;
  /** Refusing guards, most-frequent first, then alphabetical. */
  readonly refusalsByGuard: readonly GuardCount[];
  /** Worker red-loops across the whole log. Normal work, not a problem. */
  readonly iteration: number;
  /** Iterating guards, most-frequent first, then alphabetical. */
  readonly iterationByGuard: readonly GuardCount[];
  /** Both together — every unrouted block in the log, as before the split. */
  readonly unroutedBlocks: number;
}

export interface PhaseSpan {
  readonly phase: PhaseName;
  /** Wall clock in milliseconds. Undefined when the phase never completed. */
  readonly ms?: number;
  /** ISO timestamp of the event that opened the phase, when known. */
  readonly startedAt?: string;
  /** ISO timestamp of the marker that closed it, when known. */
  readonly endedAt?: string;
  /** Why `ms` is undefined: the earliest missing marker, named. */
  readonly incomplete?: string;
  /** Blocks in this phase that named a bounce target. */
  readonly bounces: number;
  /** Bounce targets, most-bounced first, then alphabetical. */
  readonly byRoute: readonly RouteCount[];
  /** Unrouted blocks in this phase a guard refused (path-gate, composite inner steps). */
  readonly refusals: number;
  /** Unrouted blocks in this phase that are a worker's own red loop. */
  readonly iteration: number;
  /** `refusals + iteration` — every block in this phase that named no target. */
  readonly unroutedBlocks: number;
}

export interface PhaseDurations {
  /** Always all four phases, in order. */
  readonly phases: readonly PhaseSpan[];
  /** First event → last event. The LOG's span, not the sum of the phases:
   *  they agree when every phase completed and diverge when one did not,
   *  which is exactly the signal worth seeing. */
  readonly totalMs?: number;
  /** Events analysed (after dropping unusable ones). */
  readonly events: number;
  /** Events dropped for having no usable timestamp. */
  readonly skipped: number;
  /** Bounces across all phases, including unattributed ones. */
  readonly bounces: number;
  /** Blocks in a stretch no pair of markers delimits. */
  readonly unattributedBlocks: number;
  /** Run-total unrouted blocks, split and broken down by guard. */
  readonly friction: Friction;
  /** The `run-start` marker the clock was started from, when the log carried one. */
  readonly runStartedAt?: string;
  /** Set when nothing could be measured at all; the report degrades to this line. */
  readonly unavailable?: string;
}

// --- markers --------------------------------------------------------------------

function summaryOf(e: LoggedGuardEvent): string {
  return typeof e.summary === "string" ? e.summary : "";
}

/**
 * The event that ends DESIGN: the contract is frozen.
 *
 * Same test green-gate's `redPassStandsForCurrentContracts` uses for the
 * checksum half — a manifest WRITE, not a drift verification — plus the
 * composite `design-gate` pass whose final step is that write (ADR 2026-019).
 */
function isFreeze(e: LoggedGuardEvent): boolean {
  if (e.verdict !== "pass") return false;
  if (e.guard === "design-gate") return true;
  return e.guard === "checksum-gate" && summaryOf(e).includes("wrote manifest");
}

const isRedPass = (e: LoggedGuardEvent): boolean => e.guard === "red-gate" && e.verdict === "pass";
const isGreenPass = (e: LoggedGuardEvent): boolean => e.guard === "green-gate" && e.verdict === "pass";
/** WRAP's closing activity: the terminal verdict and the delivery pass. */
const isWrapEvent = (e: LoggedGuardEvent): boolean => e.guard === "sign-off" || e.guard === "deliver";

/** The path gate's first-gated-tool-call marker (see "The clock" in the header). */
const isRunStart = (e: LoggedGuardEvent): boolean => e.guard === RUN_START_GUARD;

/** The role a run-start names, or undefined when it carries none. */
function runStartRole(e: LoggedGuardEvent): string | undefined {
  const role = (e.detail as { role?: unknown } | undefined)?.role;
  return typeof role === "string" ? role : undefined;
}

/**
 * The DRIVING session's run-start (the architect's). Only the architect stamps
 * one now (src/path-gate.ts), but r16's archived arms were written before that
 * fix and carry 14-19, one per subagent session — and one reviewer's fell LATER
 * than the architect's yet still before the freeze, so "the last run-start
 * before the first marker" picked it and started DESIGN's clock at 2m45s. The
 * role separates the driver from its workers, so the consumer resolves to it
 * and reads an old log correctly too.
 */
const isDrivingRunStart = (e: LoggedGuardEvent): boolean =>
  isRunStart(e) && runStartRole(e) === "architect";

/** The two roles whose phases have a worker-derived opening. */
export type Worker = "test-writer" | "builder";

/**
 * Which worker an event is attributable to, or undefined when none.
 *
 * Two guards answer this and neither was added for it (see the header):
 * `typecheck` records the calling role in `detail.role` because it scopes its
 * diagnostics by it, and `run_tests` is the builder's tool by policy, so every
 * `run_tests` event is a builder event by construction. Nothing else is
 * attributable: a gate is run by the architect, and a path-gate block names a
 * role in its detail but is a REFUSAL — a call that did not happen is not
 * evidence that a worker was working.
 */
export function workerOf(e: LoggedGuardEvent): Worker | undefined {
  if (e.guard === "run_tests") return "builder";
  if (e.guard !== "typecheck") return undefined;
  const role = (e.detail as { role?: unknown } | undefined)?.role;
  return role === "test-writer" || role === "builder" ? role : undefined;
}

/** Any event that closes or opens a phase — the boundary a run-start must precede. */
const isPhaseMarker = (e: LoggedGuardEvent): boolean =>
  isFreeze(e) || isRedPass(e) || isGreenPass(e) || isWrapEvent(e);

/**
 * Guards whose unrouted blocks are ITERATION, not refusal (see the header).
 * `lint-*` is matched by prefix so a new lint guard inherits the classification
 * instead of silently becoming friction.
 */
const ITERATION_GUARDS: ReadonlySet<string> = new Set(["typecheck", "run_tests", "git"]);

/** Which kind of unrouted block a guard's name makes this. */
export type BlockKind = "refusal" | "iteration";

/** Classify an unrouted block by the guard that logged it. Pure, total. */
export function classifyUnroutedBlock(guard: string): BlockKind {
  return ITERATION_GUARDS.has(guard) || guard.startsWith("lint-") ? "iteration" : "refusal";
}

/** The bounce target a gate recorded, or undefined when it named none. */
export function routeOf(e: LoggedGuardEvent): string | undefined {
  const route = (e.detail as { route?: unknown } | undefined)?.route;
  return typeof route === "string" && route !== "" ? route : undefined;
}

// --- analysis -------------------------------------------------------------------

/** Milliseconds between two logged timestamps, never negative (see header). */
function spanMs(from: LoggedGuardEvent, to: LoggedGuardEvent): number {
  return Math.max(0, Date.parse(to.ts) - Date.parse(from.ts));
}

interface Bounds {
  /** Index of the event that opens the phase; -1 when unknown. */
  readonly startIdx: number;
  /** Index of the marker that closes it; -1 when it never fired. */
  readonly endIdx: number;
  /** Named for the report when a bound is missing. */
  readonly missing: string;
}

/**
 * Reduce a guard log to per-phase wall clock and bounce counts.
 *
 * Pure. See the module header for every edge decision — completion, revision
 * re-freezes, ordering, and what counts as one run.
 */
export function phaseDurations(all: readonly LoggedGuardEvent[]): PhaseDurations {
  const events: LoggedGuardEvent[] = [];
  let skipped = 0;
  for (const e of all) {
    if (
      e === null ||
      typeof e !== "object" ||
      typeof e.guard !== "string" ||
      typeof e.ts !== "string" ||
      Number.isNaN(Date.parse(e.ts))
    ) {
      skipped += 1;
      continue;
    }
    events.push(e);
  }

  if (events.length === 0) {
    return {
      phases: PHASES.map((phase) => ({
        phase,
        incomplete: "no events",
        bounces: 0,
        byRoute: [],
        refusals: 0,
        iteration: 0,
        unroutedBlocks: 0,
      })),
      events: 0,
      skipped,
      bounces: 0,
      unattributedBlocks: 0,
      friction: EMPTY_FRICTION,
      unavailable:
        skipped > 0
          ? `no usable guard events (${skipped} unreadable) — the log is corrupt`
          : "the guard log is empty or absent (BOUNDED_GUARD_LOG=off, or no gate ran here)",
    };
  }

  // Markers, in append order. Each is searched only in the stretch its phase
  // can occupy, so a later re-freeze cannot pull DESIGN over TEST and BUILD.
  const redIdx = events.findIndex(isRedPass);
  const freezeIdx = lastIndexBefore(events, isFreeze, redIdx === -1 ? events.length : redIdx);
  const greenIdx = firstIndexAfter(events, isGreenPass, redIdx);
  const wrapEndIdx = lastIndexAfter(events, isWrapEvent, greenIdx);

  // The clock. A run-start after the first phase marker belongs to a second
  // run sharing the log; the last one BEFORE that marker is this run's start.
  //
  // Among the run-starts before that marker, the driving session's is the
  // architect's — so it is the architect's that is taken, and a restart takes
  // the LAST architect one (the abandoned first attempt is not design time).
  // Only the architect stamps one now, but an old log (r16) carries a marker
  // per subagent session and one can fall between the architect's and the
  // freeze; filtering to the architect's is what stops that late marker winning.
  const firstMarkerIdx = events.findIndex(isPhaseMarker);
  const clockLimit = firstMarkerIdx === -1 ? events.length : firstMarkerIdx;
  let runStartIdx = lastIndexBefore(events, isDrivingRunStart, clockLimit);
  if (runStartIdx === -1) {
    // No architect-tagged run-start: a synthetic or pre-role-detail log. The
    // architect's first gated call necessarily precedes any subagent spawn, so
    // the EARLIEST run-start before the first marker is the driving session's.
    runStartIdx = events.findIndex((e, i) => i < clockLimit && isRunStart(e));
  }
  const clockStartIdx = runStartIdx === -1 ? 0 : runStartIdx;

  // Where each worker's phase OPENS: its own first event, when the log carries
  // one after the freeze; the gate marker otherwise. Searching from the freeze
  // keeps a previous ticket's worker events in a shared log from pulling a
  // boundary back behind the design that produced it.
  const openedBy = (worker: Worker, fallbackIdx: number, endIdx: number): number => {
    if (freezeIdx === -1) return fallbackIdx; // no design boundary ⇒ nothing to search from
    const first = firstIndexAfter(events, (e) => workerOf(e) === worker, freezeIdx);
    // A worker event after the phase's own closing marker belongs to a later
    // bounce, not to the opening; the marker is the better answer there.
    if (first === -1 || (endIdx !== -1 && first >= endIdx)) return fallbackIdx;
    return first;
  };
  const testsStartIdx = openedBy("test-writer", freezeIdx, redIdx);
  const buildStartIdx = openedBy("builder", redIdx, greenIdx);

  const bounds: Record<PhaseName, Bounds> = {
    design: {
      startIdx: clockStartIdx,
      endIdx: freezeIdx,
      missing: "no contract freeze (design_gate never passed)",
    },
    tests: {
      startIdx: testsStartIdx,
      endIdx: redIdx,
      missing: freezeIdx === -1 ? "no contract freeze (design_gate never passed)" : "no red_gate pass",
    },
    build: {
      startIdx: buildStartIdx,
      endIdx: greenIdx,
      missing:
        buildStartIdx === -1 ? "no red_gate pass and no builder activity" : "no green_gate pass",
    },
    wrap: {
      startIdx: greenIdx,
      endIdx: wrapEndIdx,
      missing: greenIdx === -1 ? "no green_gate pass" : "no sign_off or deliver event",
    },
  };

  // Block regions, by index. WRAP owns everything after green — a block logged
  // after the last sign-off/deliver is still wrap-phase work, even though it
  // falls outside the measured span.
  const regions: Record<PhaseName, [number, number] | undefined> = {
    design: freezeIdx === -1 ? undefined : [0, freezeIdx],
    tests: freezeIdx === -1 || redIdx === -1 ? undefined : [freezeIdx, redIdx],
    build: redIdx === -1 || greenIdx === -1 ? undefined : [redIdx, greenIdx],
    wrap: greenIdx === -1 ? undefined : [greenIdx, events.length],
  };

  const routed: Record<PhaseName, Map<string, number>> = {
    design: new Map(),
    tests: new Map(),
    build: new Map(),
    wrap: new Map(),
  };
  const unrouted: Record<BlockKind, Record<PhaseName, number>> = {
    refusal: { design: 0, tests: 0, build: 0, wrap: 0 },
    iteration: { design: 0, tests: 0, build: 0, wrap: 0 },
  };
  // Both tallies are counted per GUARD across the whole run, so they are kept
  // here rather than derived from the per-phase numbers: the phase totals
  // cannot see the unattributed blocks, and neither carries the guard name.
  const byGuard: Record<BlockKind, Map<string, number>> = {
    refusal: new Map(),
    iteration: new Map(),
  };
  let unattributedBlocks = 0;
  let bounces = 0;

  for (const [i, e] of events.entries()) {
    if (e.verdict !== "block") continue;
    const route = routeOf(e);
    const kind = classifyUnroutedBlock(e.guard);
    if (route !== undefined) bounces += 1;
    else byGuard[kind].set(e.guard, (byGuard[kind].get(e.guard) ?? 0) + 1);
    const phase = PHASES.find((p) => {
      const region = regions[p];
      return region !== undefined && i >= region[0] && i < region[1];
    });
    if (phase === undefined) {
      unattributedBlocks += 1;
      continue;
    }
    if (route === undefined) unrouted[kind][phase] += 1;
    else routed[phase].set(route, (routed[phase].get(route) ?? 0) + 1);
  }

  const refusals = tally(byGuard.refusal);
  const iteration = tally(byGuard.iteration);
  const friction: Friction = {
    refusals: refusals.total,
    refusalsByGuard: refusals.byGuard,
    iteration: iteration.total,
    iterationByGuard: iteration.byGuard,
    unroutedBlocks: refusals.total + iteration.total,
  };

  const phases: PhaseSpan[] = PHASES.map((phase) => {
    const { startIdx, endIdx, missing } = bounds[phase];
    const byRoute = [...routed[phase]]
      .map(([route, count]) => ({ route, count }))
      .sort((a, b) => b.count - a.count || (a.route < b.route ? -1 : 1));
    const base = {
      phase,
      bounces: byRoute.reduce((n, r) => n + r.count, 0),
      byRoute,
      refusals: unrouted.refusal[phase],
      iteration: unrouted.iteration[phase],
      unroutedBlocks: unrouted.refusal[phase] + unrouted.iteration[phase],
    };
    if (startIdx === -1 || endIdx === -1) return { ...base, incomplete: missing };
    const from = events[startIdx]!;
    const to = events[endIdx]!;
    return { ...base, ms: spanMs(from, to), startedAt: from.ts, endedAt: to.ts };
  });

  return {
    phases,
    // From the run-start marker when there is one, so a session that sat idle
    // between opening and its first real tool call does not bill those minutes
    // to the run — r15 lost ~14 minutes of provider outage into DESIGN.
    totalMs: spanMs(events[clockStartIdx]!, events[events.length - 1]!),
    events: events.length,
    skipped,
    bounces,
    unattributedBlocks,
    friction,
    ...(runStartIdx === -1 ? {} : { runStartedAt: events[runStartIdx]!.ts }),
  };
}

/** The zero value, so an unavailable report claims nothing about either kind. */
const EMPTY_FRICTION: Friction = {
  refusals: 0,
  refusalsByGuard: [],
  iteration: 0,
  iterationByGuard: [],
  unroutedBlocks: 0,
};

/** Total and ordered breakdown of one guard tally: most frequent, then alphabetical. */
function tally(counts: ReadonlyMap<string, number>): { total: number; byGuard: GuardCount[] } {
  return {
    total: [...counts.values()].reduce((n, c) => n + c, 0),
    byGuard: [...counts]
      .map(([guard, count]) => ({ guard, count }))
      .sort((a, b) => b.count - a.count || (a.guard < b.guard ? -1 : 1)),
  };
}

/** Last index strictly before `limit` matching `pred`, or -1. */
function lastIndexBefore(
  events: readonly LoggedGuardEvent[],
  pred: (e: LoggedGuardEvent) => boolean,
  limit: number,
): number {
  for (let i = Math.min(limit, events.length) - 1; i >= 0; i--) if (pred(events[i]!)) return i;
  return -1;
}

/** First index strictly after `after` matching `pred`, or -1. `after: -1` searches all. */
function firstIndexAfter(
  events: readonly LoggedGuardEvent[],
  pred: (e: LoggedGuardEvent) => boolean,
  after: number,
): number {
  for (let i = after + 1; i < events.length; i++) if (pred(events[i]!)) return i;
  return -1;
}

/** Last index strictly after `after` matching `pred`, or -1. `after: -1` searches all. */
function lastIndexAfter(
  events: readonly LoggedGuardEvent[],
  pred: (e: LoggedGuardEvent) => boolean,
  after: number,
): number {
  for (let i = events.length - 1; i > after; i--) if (pred(events[i]!)) return i;
  return -1;
}

// --- formatting -----------------------------------------------------------------

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** `47s` · `4m12s` · `1h04m12s`. Fixed shape so the column stays greppable. */
export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  if (hours > 0) return `${hours}h${pad2(minutes)}m${pad2(seconds)}s`;
  if (minutes > 0) return `${minutes}m${pad2(seconds)}s`;
  return `${seconds}s`;
}

const NAME_WIDTH = 6; // "design" is the longest phase name
const TIME_WIDTH = 8; // "1h04m12s"

/**
 * One row of the block. A name longer than NAME_WIDTH — only the combined
 * `workers` row is — borrows from the time column's padding, so the durations
 * stay in one column no matter which rows a run prints.
 */
function row(name: string, time: string, note?: string): string {
  const width = Math.max(1, TIME_WIDTH - Math.max(0, name.length - NAME_WIDTH));
  return `  timing: ${name.padEnd(NAME_WIDTH)} ${time.padStart(width)}${note !== undefined ? `  (${note})` : ""}`;
}

function bounceText(span: PhaseSpan): string | undefined {
  if (span.bounces === 0) return undefined;
  const targets = span.byRoute.map((r) => `${r.count} → ${r.route}`).join(", ");
  return `${span.bounces} bounce${span.bounces === 1 ? "" : "s"}: ${targets}`;
}

/**
 * What a phase's row says in brackets. Refusals and red-loops are named
 * separately and with the run lines' vocabulary: a row reading "13 unrouted
 * blocks" beside a `friction:` line reading "1 refusal" would leave a reader
 * unable to reconcile the two numbers in the same block.
 */
function phaseNotes(span: PhaseSpan): string[] {
  return [
    span.incomplete !== undefined ? `incomplete: ${span.incomplete}` : undefined,
    bounceText(span),
    span.refusals > 0 ? `${span.refusals} refusal${span.refusals === 1 ? "" : "s"}` : undefined,
    span.iteration > 0 ? `${span.iteration} red-loop${span.iteration === 1 ? "" : "s"}` : undefined,
  ].filter((n): n is string => n !== undefined);
}

/**
 * The friction summary: how many calls a guard refused outright, and which
 * guard did it. Refusals only — a worker's red loops are reported by
 * `iterationText` as the work they are. Pure.
 */
function frictionText(friction: Friction): string {
  const n = friction.refusals;
  const noun = `${n} refusal${n === 1 ? "" : "s"}`;
  const breakdown =
    friction.refusalsByGuard.length > 0
      ? ` (${friction.refusalsByGuard.map((g) => `${g.guard} ${g.count}`).join(", ")})`
      : "";
  return `${noun}${breakdown} — target 0`;
}

/** The iteration summary: red loops, stated as normal work with no target. */
function iterationText(friction: Friction): string {
  const n = friction.iteration;
  const noun = `${n} worker red-loop${n === 1 ? "" : "s"}`;
  const breakdown = ` (${friction.iterationByGuard.map((g) => `${g.guard} ${g.count}`).join(", ")})`;
  return `${noun}${breakdown}`;
}

// ---------------------------------------------------------------------------
// Parallel workers (r15)
// ---------------------------------------------------------------------------
//
// Printed one under the other, "tests 8m37s" then "build 5m42s" reads as
// 14m19s of sequence. With the test-writer and the builder running in
// parallel it can be 12m19s of wall clock, and the difference is the whole
// point of running them that way.
//
// So when the two spans genuinely overlap, they print as ONE row measured
// from the union of the two windows, with the individual figures kept in the
// brackets and the full per-phase rows kept in the structured summary the
// caller logs. A run whose spans do not overlap prints exactly what it always
// did — the row is a description of what the timestamps say, never a claim
// about how the run was configured.
//
// Two constraints this obeys:
//
// * IT READS ONLY THE SPAN TIMESTAMPS the analysis already produces. No new
//   event kind, no inference about which worker owned which tool call.
//
// * A BACKWARDS CLOCK IS NOT AN OVERLAP. A span whose end precedes its start
//   (the clamped case the header describes) is not a window at all, and two
//   of them can "overlap" in arithmetic that means nothing. Such a pair falls
//   back to the ordinary rows.
//
// The boundaries now produce those overlaps from a real log: BUILD opens at the
// builder's first attributable event rather than at the red-gate pass that
// closes TESTS (see "Where a worker's phase opens" in the header), so two
// workers commissioned in parallel show as two overlapping windows and this row
// fires. The formatter still takes the spans as given and asserts nothing about
// adjacency — it describes what the timestamps say, never how the run was
// configured, and a genuinely sequential run prints exactly what it always did.

interface Window {
  readonly start: number;
  readonly end: number;
  readonly ms: number;
}

/** A phase's wall-clock window, or undefined when it is not a usable one. */
function windowOf(span: PhaseSpan | undefined): Window | undefined {
  if (span?.ms === undefined || span.startedAt === undefined || span.endedAt === undefined) {
    return undefined;
  }
  const start = Date.parse(span.startedAt);
  const end = Date.parse(span.endedAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return undefined;
  return { start, end, ms: span.ms };
}

/** The single `workers` row, when TESTS and BUILD overlap in wall time. */
function combinedWorkersRow(phases: readonly PhaseSpan[]): string | undefined {
  const tests = phases.find((p) => p.phase === "tests");
  const build = phases.find((p) => p.phase === "build");
  const a = windowOf(tests);
  const b = windowOf(build);
  if (a === undefined || b === undefined || tests === undefined || build === undefined) return undefined;
  if (a.end <= b.start || b.end <= a.start) return undefined; // sequential, or merely touching

  const union = Math.max(a.end, b.end) - Math.min(a.start, b.start);
  const notes = [
    `tests ${formatDuration(a.ms)} ∥ build ${formatDuration(b.ms)} — overlapped`,
    // Nothing a separate row would have said is dropped: a bounce that
    // disappeared from the block because the phases were merged would be a
    // measurement lost to a presentation change.
    ...phaseNotes(tests).map((n) => `tests: ${n}`),
    ...phaseNotes(build).map((n) => `build: ${n}`),
  ];
  return row("workers", formatDuration(union), notes.join("; "));
}

/** `09:14:07` in UTC — the timestamps are ISO, and a report should not move with the reader. */
function clockText(ts: string): string {
  const d = new Date(Date.parse(ts));
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/**
 * The human block a delivery prints.
 *
 * Line 0 is the headline (the house convention every gate follows); the rest
 * are indented and each carries the `timing:` tag, so one phase's line can be
 * grepped out of a whole run's output on its own.
 */
export function formatPhaseDurations(durations: PhaseDurations): string[] {
  if (durations.unavailable !== undefined) return [`unavailable — ${durations.unavailable}`];

  // When the workers overlapped, their two rows are replaced by one in the
  // position TESTS held; the per-phase detail survives in `durations`.
  const workers = combinedWorkersRow(durations.phases);
  const lines: string[] = [];
  for (const span of durations.phases) {
    if (workers !== undefined && (span.phase === "tests" || span.phase === "build")) {
      if (span.phase === "tests") lines.push(workers);
      continue;
    }
    const notes = phaseNotes(span);
    lines.push(
      row(
        span.phase,
        span.ms === undefined ? "—" : formatDuration(span.ms),
        notes.length > 0 ? notes.join("; ") : undefined,
      ),
    );
  }

  const incomplete = durations.phases.some((p) => p.ms === undefined);
  lines.push(
    row(
      "total",
      durations.totalMs === undefined ? "—" : formatDuration(durations.totalMs),
      incomplete ? "log span; the phases above do not sum to it" : undefined,
    ),
  );
  if (durations.unattributedBlocks > 0) {
    lines.push(
      `  timing: ${durations.unattributedBlocks} block${durations.unattributedBlocks === 1 ? "" : "s"} outside any measurable phase`,
    );
  }

  // ALWAYS printed, including at zero. A friction line that appears only when
  // there is friction leaves "the harness stayed out of the way" and "nobody
  // measured" looking identical in the transcript, and zero is the target — it
  // is worth seeing hit. The `friction:` tag is its own, not `timing:`: this is
  // a run total, not one phase's row, and it should grep out separately.
  lines.push(`  friction: ${frictionText(durations.friction)}`);
  // Iteration is printed only when it happened. It has no target, so a
  // "0 worker red-loops" line would be an achievement claim for a run that
  // simply had no workers in it — and unlike friction, nobody needs proof that
  // the number was measured.
  if (durations.friction.iteration > 0) {
    lines.push(`  iteration: ${iterationText(durations.friction)}`);
  }

  const counted = `${durations.events} guard event${durations.events === 1 ? "" : "s"}`;
  const unreadable = durations.skipped > 0 ? `, ${durations.skipped} unreadable` : "";
  // With a run-start marker the clock has a stated origin, which is a stronger
  // statement than the old caveat and replaces it; without one the caveat is
  // still the honest thing to say.
  const clock =
    durations.runStartedAt !== undefined
      ? `; clock from run-start ${clockText(durations.runStartedAt)}`
      : ", taken as one run";
  return [`where the minutes went (${counted}${unreadable}${clock})`, ...lines];
}
