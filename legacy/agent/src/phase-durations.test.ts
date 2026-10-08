import { describe, expect, test } from "vitest";
import {
  classifyUnroutedBlock,
  formatDuration,
  workerOf,
  formatPhaseDurations,
  phaseDurations,
  type PhaseDurations,
  type PhaseName,
  type PhaseSpan,
} from "./phase-durations.ts";
import type { GuardVerdict, LoggedGuardEvent } from "./guard-log.ts";

// WHY THIS EXISTS
//
// Every gate already stamps itself into the guard log, so a run's shape —
// which phase cost the minutes, how often it bounced and to whom — has been
// recorded since the log existed and was never read back. "Measure before
// optimizing further" (issue #13) needs that read-back, and it needs it to
// come from logged data rather than anyone's memory of the session.
//
// The interesting part is not the arithmetic; it is the edges. A contract
// revised mid-loop freezes twice. A run that dies in TEST never has a BUILD.
// A composite gate and its failing step both log a block, so counting blocks
// naively counts one hand-back twice. Each of those has a decided answer in
// the module header, and each has a test here that fails if the answer
// silently changes.

const T0 = Date.parse("2026-03-01T09:00:00.000Z");

/** An event `minutes` into the run. Timestamps are the only thing spans read. */
function at(
  minutes: number,
  guard: string,
  verdict: GuardVerdict,
  summary = "",
  detail?: Record<string, unknown>,
): LoggedGuardEvent {
  return {
    ts: new Date(T0 + minutes * 60_000).toISOString(),
    guard,
    verdict,
    summary,
    ...(detail !== undefined ? { detail } : {}),
  };
}

const FREEZE = "wrote manifest (1 contract file)";
const minutes = (n: number): number => n * 60_000;

function phase(events: readonly LoggedGuardEvent[], name: PhaseName) {
  const found = phaseDurations(events).phases.find((p) => p.phase === name);
  if (found === undefined) throw new Error(`no ${name} phase in the summary`);
  return found;
}

/** A complete run: design bounced once, test once, build once. */
const FULL_RUN: readonly LoggedGuardEvent[] = [
  at(0, "contract-purity", "pass", "OK (1 file)"),
  at(2, "contract-purity", "block", "1 problem in 1 file"),
  at(2, "design-gate", "block", "contract-purity blocked (route: architect)", { route: "architect" }),
  at(4, "checksum-gate", "pass", FREEZE),
  at(4, "design-gate", "pass", "OK (contract-purity → scaffold → typecheck → freeze, 3.1s)"),
  at(12, "red-gate", "block", "2 wrong-reason failures (route: test-writer)", { route: "test-writer" }),
  at(20, "red-gate", "pass", "RED OK (5 NotImplemented failures, 0 passed)"),
  at(35, "green-gate", "block", "1 failing test (route: builder)", { route: "builder" }),
  at(48, "green-gate", "pass", "GREEN (5/5 passed, typecheck clean)"),
  at(50, "sign-off", "pass", "signed off (0 findings)"),
  at(52, "deliver", "pass", "OK — 6 steps applied"),
];

describe("phase spans", () => {
  test("a complete run: each phase spans its own markers, not the whole log", () => {
    const d = phaseDurations(FULL_RUN);
    expect(d.phases.map((p) => [p.phase, p.ms])).toEqual([
      ["design", minutes(4)], // first event → the freeze
      ["tests", minutes(16)], // the freeze → the first red pass
      ["build", minutes(28)], // the red pass → the first green pass
      ["wrap", minutes(4)], // the green pass → the last sign-off/deliver
    ]);
    expect(d.totalMs).toBe(minutes(52));
    expect(d.phases.every((p) => p.incomplete === undefined)).toBe(true);
  });

  test("the two freezes a composite logs collapse to one boundary", () => {
    // design-gate's final step IS the checksum write, so both fire. Taking the
    // later one must not push DESIGN past the freeze into TEST's minutes.
    const d = phaseDurations(FULL_RUN);
    expect(d.phases[0]!.endedAt).toBe(new Date(T0 + minutes(4)).toISOString());
  });

  test("a design-gate pass alone is a freeze (a pack may log only the composite)", () => {
    const p = phase(
      [at(0, "contract-purity", "pass"), at(6, "design-gate", "pass", "OK (…)"), at(9, "red-gate", "pass", "RED OK")],
      "design",
    );
    expect(p.ms).toBe(minutes(6));
  });

  test("a checksum-gate VERIFY is not a freeze — check_drift may run at any time", () => {
    // "OK (1 contract file, no drift)" is the verify wording; only "wrote
    // manifest" ends DESIGN. Mistaking the two would end DESIGN wherever the
    // architect last checked for drift.
    const events = [
      at(0, "contract-purity", "pass"),
      at(3, "checksum-gate", "pass", "OK (1 contract file, no drift)"),
      at(7, "checksum-gate", "pass", FREEZE),
      at(11, "red-gate", "pass", "RED OK"),
    ];
    expect(phase(events, "design").ms).toBe(minutes(7));
  });

  test("total is the log's span, not the sum of the phases", () => {
    // They agree on a complete run and diverge when a phase never completed —
    // which is the point: the divergence is the signal.
    const d = phaseDurations(FULL_RUN);
    const sum = d.phases.reduce((n, p) => n + (p.ms ?? 0), 0);
    expect(sum).toBe(d.totalMs);
  });
});

describe("a contract revised mid-loop (ADR 2026-019's re-run path)", () => {
  // Revising means the design was not finished at the first freeze, so those
  // minutes are design minutes. But a freeze AFTER the red pass belongs to a
  // loop already in flight; stretching DESIGN over it would double-count TEST
  // and BUILD's wall clock.
  const REVISED: readonly LoggedGuardEvent[] = [
    at(0, "contract-purity", "pass"),
    at(3, "checksum-gate", "pass", FREEZE), // first freeze
    at(9, "checksum-gate", "pass", "wrote manifest (2 contract files)"), // re-freeze after revision
    at(15, "red-gate", "pass", "RED OK"),
    at(30, "checksum-gate", "pass", "wrote manifest (2 contract files)"), // revision mid-BUILD
    at(40, "green-gate", "pass", "GREEN"),
  ];

  test("DESIGN extends to the LAST freeze before the first red pass", () => {
    expect(phase(REVISED, "design").ms).toBe(minutes(9));
  });

  test("a freeze after the red pass does not extend DESIGN over TEST and BUILD", () => {
    const d = phaseDurations(REVISED);
    expect(d.phases[1]!.ms).toBe(minutes(6)); // tests: 9 → 15
    expect(d.phases[2]!.ms).toBe(minutes(25)); // build: 15 → 40
  });

  test("with no red pass at all, DESIGN ends at the last freeze in the log", () => {
    const events = [at(0, "contract-purity", "pass"), at(3, "checksum-gate", "pass", FREEZE), at(11, "checksum-gate", "pass", FREEZE)];
    expect(phase(events, "design").ms).toBe(minutes(11));
  });
});

describe("phases that never completed", () => {
  const DIED_IN_TEST: readonly LoggedGuardEvent[] = [
    at(0, "contract-purity", "pass"),
    at(5, "checksum-gate", "pass", FREEZE),
    at(15, "red-gate", "pass", "RED OK"),
  ];

  test("report undefined, never zero — nothing is known, and 0 would be a claim", () => {
    const d = phaseDurations(DIED_IN_TEST);
    expect(d.phases[0]!.ms).toBe(minutes(5));
    expect(d.phases[1]!.ms).toBe(minutes(10));
    expect(d.phases[2]!.ms).toBeUndefined();
    expect(d.phases[3]!.ms).toBeUndefined();
  });

  test("name the earliest missing marker, so the report says which step never ran", () => {
    const d = phaseDurations(DIED_IN_TEST);
    expect(d.phases[2]!.incomplete).toContain("green_gate");
    expect(d.phases[3]!.incomplete).toContain("green_gate"); // not "sign_off" — green is missing first
  });

  test("no freeze at all leaves DESIGN and TESTS unmeasurable", () => {
    const d = phaseDurations([at(0, "contract-purity", "pass"), at(4, "contract-purity", "pass")]);
    expect(d.phases[0]!.incomplete).toContain("freeze");
    expect(d.phases[1]!.incomplete).toContain("freeze");
    expect(d.totalMs).toBe(minutes(4)); // the log's span is still measurable
  });

  test("BUILD is still measured when its own markers exist but the freeze is missing", () => {
    // red → green needs no freeze; refusing to measure it would throw away a
    // real number because a different phase's marker was absent.
    const events = [at(0, "red-gate", "pass", "RED OK"), at(21, "green-gate", "pass", "GREEN")];
    expect(phase(events, "build").ms).toBe(minutes(21));
  });
});

describe("bounces", () => {
  test("a bounce is a block that names a route, counted into its own phase", () => {
    const d = phaseDurations(FULL_RUN);
    expect(d.phases.map((p) => [p.phase, p.bounces, p.byRoute])).toEqual([
      ["design", 1, [{ route: "architect", count: 1 }]],
      ["tests", 1, [{ route: "test-writer", count: 1 }]],
      ["build", 1, [{ route: "builder", count: 1 }]],
      ["wrap", 0, []],
    ]);
    expect(d.bounces).toBe(3);
  });

  test("a composite and its failing step are ONE hand-back, not two", () => {
    // design-gate logs a block AND its contract-purity step logs one. Counting
    // every block would report two bounces for one round trip.
    const d = phaseDurations(FULL_RUN);
    expect(d.phases[0]!.bounces).toBe(1);
    expect(d.phases[0]!.unroutedBlocks).toBe(1); // the inner contract-purity block, still visible
  });

  test("several bounces to the same role aggregate, most-bounced role first", () => {
    const events = [
      at(0, "contract-purity", "pass"),
      at(2, "checksum-gate", "pass", FREEZE),
      at(4, "red-gate", "pass", "RED OK"),
      at(9, "green-gate", "block", "1 failing test", { route: "builder" }),
      at(14, "green-gate", "block", "1 failing test", { route: "builder" }),
      at(19, "green-gate", "block", "the same test has failed twice", { route: "test-writer" }),
      at(25, "green-gate", "pass", "GREEN"),
    ];
    const build = phase(events, "build");
    expect(build.bounces).toBe(3);
    expect(build.byRoute).toEqual([
      { route: "builder", count: 2 },
      { route: "test-writer", count: 1 },
    ]);
  });

  test("a path-gate denial is not a bounce — it refuses a call, it hands back nothing", () => {
    const events = [
      at(0, "contract-purity", "pass"),
      at(1, "path-gate", "block", "builder may not write tests/x.test.ts", { role: "builder", tool: "write" }),
      at(3, "checksum-gate", "pass", FREEZE),
      at(6, "red-gate", "pass", "RED OK"),
    ];
    const design = phase(events, "design");
    expect(design.bounces).toBe(0);
    expect(design.unroutedBlocks).toBe(1);
  });

  test("blocks in a stretch no markers delimit are unattributed, not guessed onto a phase", () => {
    // No freeze, so nothing separates DESIGN from TESTS. Putting these blocks
    // on DESIGN's line would invent an attribution the log does not support.
    const events = [
      at(0, "contract-purity", "pass"),
      at(2, "red-gate", "block", "wrong-reason red", { route: "test-writer" }),
      at(5, "red-gate", "pass", "RED OK"),
    ];
    const d = phaseDurations(events);
    expect(d.unattributedBlocks).toBe(1);
    expect(d.phases.every((p) => p.bounces === 0)).toBe(true);
    expect(d.bounces).toBe(1); // still counted in the run total
  });

  test("WRAP owns blocks logged after the last sign-off/deliver event", () => {
    const events = [...FULL_RUN, at(60, "green-gate", "block", "1 failing test", { route: "builder" })];
    expect(phase(events, "wrap").bounces).toBe(1);
    expect(phase(events, "wrap").ms).toBe(minutes(4)); // the measured span is unchanged
  });
});

describe("corrupt, empty and out-of-order logs", () => {
  test("an empty log is unavailable, and says why rather than reporting zeros", () => {
    const d = phaseDurations([]);
    expect(d.unavailable).toMatch(/empty or absent/);
    expect(d.totalMs).toBeUndefined();
    expect(d.phases.every((p) => p.ms === undefined)).toBe(true);
  });

  test("events with no usable timestamp are dropped and counted, not crashed on", () => {
    const events = [
      { guard: "contract-purity", verdict: "pass", summary: "OK" } as unknown as LoggedGuardEvent,
      at(0, "contract-purity", "pass"),
      { ts: "not-a-date", guard: "scaffold", verdict: "pass", summary: "" } as LoggedGuardEvent,
      at(4, "checksum-gate", "pass", FREEZE),
    ];
    const d = phaseDurations(events);
    expect(d.skipped).toBe(2);
    expect(d.events).toBe(2);
    expect(d.phases[0]!.ms).toBe(minutes(4));
  });

  test("a log of only corrupt events is unavailable, and blames the corruption", () => {
    const d = phaseDurations([{ ts: "nope", guard: "x", verdict: "pass", summary: "" } as LoggedGuardEvent]);
    expect(d.unavailable).toMatch(/corrupt/);
    expect(d.skipped).toBe(1);
  });

  test("a clock that went backwards clamps to 0 rather than reporting a negative span", () => {
    // Append order sequences the run; the timestamp only measures it. A
    // negative duration is not a fact about the run.
    const events = [at(10, "contract-purity", "pass"), at(4, "checksum-gate", "pass", FREEZE)];
    expect(phase(events, "design").ms).toBe(0);
  });

  test("markers are found in append order, not by sorting timestamps", () => {
    // The second freeze is stamped EARLIER than the first but appended later;
    // append order is the causal truth, so it is the one that ends DESIGN.
    const events = [
      at(0, "contract-purity", "pass"),
      at(12, "checksum-gate", "pass", FREEZE),
      at(8, "checksum-gate", "pass", FREEZE),
      at(20, "red-gate", "pass", "RED OK"),
    ];
    const d = phaseDurations(events);
    expect(d.phases[0]!.endedAt).toBe(new Date(T0 + minutes(8)).toISOString());
    expect(d.phases[1]!.ms).toBe(minutes(12)); // 8 → 20
  });
});

describe("formatDuration", () => {
  test("one shape per magnitude, zero-padded so the column stays aligned", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(47_000)).toBe("47s");
    expect(formatDuration(minutes(4) + 12_000)).toBe("4m12s");
    expect(formatDuration(minutes(4) + 2_000)).toBe("4m02s");
    expect(formatDuration(minutes(64) + 12_000)).toBe("1h04m12s");
  });
});

describe("formatPhaseDurations", () => {
  test("headline plus one greppable line per phase, then a total", () => {
    const lines = formatPhaseDurations(phaseDurations(FULL_RUN));
    expect(lines[0]).toBe("where the minutes went (11 guard events, taken as one run)");
    expect(lines.slice(1)).toEqual([
      "  timing: design    4m00s  (1 bounce: 1 → architect; 1 refusal)",
      "  timing: tests    16m00s  (1 bounce: 1 → test-writer)",
      "  timing: build    28m00s  (1 bounce: 1 → builder)",
      "  timing: wrap      4m00s",
      "  timing: total    52m00s",
      "  friction: 1 refusal (contract-purity 1) — target 0",
    ]);
  });

  test("an incomplete phase shows an em dash and the marker that never fired", () => {
    const lines = formatPhaseDurations(
      phaseDurations([
        at(0, "contract-purity", "pass"),
        at(5, "checksum-gate", "pass", FREEZE),
        at(15, "red-gate", "pass", "RED OK"),
      ]),
    );
    expect(lines).toContain("  timing: build         —  (incomplete: no green_gate pass)");
    expect(lines).toContain("  timing: total    15m00s  (log span; the phases above do not sum to it)");
  });

  test("unattributed blocks get their own line rather than being silently dropped", () => {
    const lines = formatPhaseDurations(
      phaseDurations([
        at(0, "contract-purity", "pass"),
        at(2, "red-gate", "block", "wrong-reason red", { route: "test-writer" }),
        at(5, "red-gate", "pass", "RED OK"),
      ]),
    );
    expect(lines).toContain("  timing: 1 block outside any measurable phase");
  });

  test("an unavailable summary degrades to one line saying why", () => {
    expect(formatPhaseDurations(phaseDurations([]))).toEqual([
      "unavailable — the guard log is empty or absent (BOUNDED_GUARD_LOG=off, or no gate ran here)",
    ]);
  });

  test("unreadable events are declared in the headline, not hidden", () => {
    const lines = formatPhaseDurations(
      phaseDurations([at(0, "contract-purity", "pass"), { ts: "nope", guard: "x", verdict: "pass", summary: "" } as LoggedGuardEvent]),
    );
    expect(lines[0]).toBe("where the minutes went (1 guard event, 1 unreadable, taken as one run)");
  });
});


// ---------------------------------------------------------------------------
// Friction (r14): the number that says whether the harness is in the way
// ---------------------------------------------------------------------------
//
// The bounce counts measure the WORK bouncing between roles, which is the
// pipeline doing its job. Unrouted blocks measure something else: calls the
// harness refused outright — a write outside a role's zone, a phase-gate
// spawn too early. Bounces have no target; these have one, and it is zero.
// Per-phase lines already carry the counts, but the guard that did the
// refusing is what points at the fix, and only a run total can show it.

describe("friction", () => {
  test("every refusal is counted, and attributed to the guard that refused", () => {
    const events = [
      at(0, "contract-purity", "pass"),
      at(1, "path-gate", "block", "builder may not write tests/x.test.ts", { role: "builder" }),
      at(2, "path-gate", "block", "builder may not write tests/y.test.ts", { role: "builder" }),
      at(3, "phase-gate", "block", "test-writer may not spawn before the freeze"),
      at(4, "checksum-gate", "pass", FREEZE),
      at(6, "red-gate", "pass", "RED OK"),
      at(9, "path-gate", "block", "test-writer may not write src/x.ts", { role: "test-writer" }),
      at(12, "green-gate", "block", "1 failing test", { route: "builder" }),
      at(15, "green-gate", "pass", "GREEN"),
    ];
    const d = phaseDurations(events);
    expect(d.friction).toEqual({
      refusals: 4,
      refusalsByGuard: [
        { guard: "path-gate", count: 3 },
        { guard: "phase-gate", count: 1 },
      ],
      iteration: 0,
      iterationByGuard: [],
      unroutedBlocks: 4,
    });
    // A routed block is a bounce, never friction: the two never double-count.
    expect(d.bounces).toBe(1);
  });

  // The run total is the point. A denial the markers could not place cost the
  // architect exactly as much as one inside DESIGN, and dropping it would make
  // the headline disagree with the log for no reason a reader could reconstruct.
  test("blocks no phase could claim still count as friction", () => {
    const events = [
      at(0, "contract-purity", "pass"),
      at(1, "path-gate", "block", "denied"), // no freeze anywhere: nothing delimits a phase
      at(2, "red-gate", "pass", "RED OK"),
    ];
    const d = phaseDurations(events);
    expect(d.unattributedBlocks).toBe(1);
    expect(d.phases.every((p) => p.unroutedBlocks === 0)).toBe(true);
    expect(d.friction.refusals).toBe(1);
    expect(d.friction.refusalsByGuard).toEqual([{ guard: "path-gate", count: 1 }]);
  });

  test("the line is printed even at zero — a target hit is worth seeing", () => {
    const lines = formatPhaseDurations(
      phaseDurations([
        at(0, "contract-purity", "pass"),
        at(2, "checksum-gate", "pass", FREEZE),
        at(6, "red-gate", "pass", "RED OK"),
        at(12, "green-gate", "pass", "GREEN"),
        at(14, "deliver", "pass", "OK"),
      ]),
    );
    expect(lines).toContain("  friction: 0 refusals — target 0");
    // ...while iteration, which has no target, stays silent at zero rather
    // than claiming an achievement for a run that had no workers in it.
    expect(lines.some((l) => l.startsWith("  iteration:"))).toBe(false);
  });

  test("the line names each refusing guard, most-frequent first", () => {
    const lines = formatPhaseDurations(
      phaseDurations([
        at(0, "contract-purity", "pass"),
        ...Array.from({ length: 14 }, (_, i) => at(1, "path-gate", "block", `denied ${i}`)),
        at(2, "contract-purity", "block", "1 problem in 1 file"),
        at(2, "contract-purity", "block", "1 problem in 1 file"),
        at(3, "phase-gate", "block", "too early"),
        at(4, "checksum-gate", "pass", FREEZE),
        at(6, "red-gate", "pass", "RED OK"),
      ]),
    );
    expect(lines).toContain(
      "  friction: 17 refusals (path-gate 14, contract-purity 2, phase-gate 1) — target 0",
    );
  });

  test("an unavailable summary reports no friction rather than a false zero breakdown", () => {
    const d = phaseDurations([]);
    expect(d.friction).toEqual({
      refusals: 0,
      refusalsByGuard: [],
      iteration: 0,
      iterationByGuard: [],
      unroutedBlocks: 0,
    });
    expect(formatPhaseDurations(d)).toEqual([
      "unavailable — the guard log is empty or absent (BOUNDED_GUARD_LOG=off, or no gate ran here)",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Refusals vs iteration (r15): the friction line was counting the job
// ---------------------------------------------------------------------------
//
// r15's kimi arm ended with `friction: 31 unrouted blocks (typecheck 13,
// run_tests 8, git 4, …)`, which reads as a harness fighting its own workers.
// The transcripts said otherwise: every one of those 21 typecheck/run_tests
// blocks was a worker compiling or running its own suite and seeing red — a
// builder whose typecheck never errors is not iterating, it is guessing — and
// the git blocks were archaeology that found nothing. One call was refused in
// the whole run. A target of zero on a number made mostly of ordinary work is
// a target nobody can act on.

describe("classifyUnroutedBlock", () => {
  test("a worker's own dev tools reporting red are iteration, whoever ran them", () => {
    for (const guard of ["typecheck", "run_tests", "lint-src", "lint-tests", "lint-contracts"]) {
      expect(classifyUnroutedBlock(guard), guard).toBe("iteration");
    }
  });

  test("git is iteration: a non-zero exit is a search that missed, not a refusal", () => {
    expect(classifyUnroutedBlock("git")).toBe("iteration");
  });

  test("the guards that say 'you may not' are refusals", () => {
    for (const guard of ["path-gate", "phase-gate"]) {
      expect(classifyUnroutedBlock(guard), guard).toBe("refusal");
    }
  });

  test("an unrouted gate block is a refusal, including a composite's inner step", () => {
    // contract-purity blocks alongside the design-gate block that carries the
    // route. The composite's block is the bounce; the inner one is a gate
    // declining to proceed, which is the same act path-gate performs.
    for (const guard of ["contract-purity", "checksum-gate", "green-gate", "scaffold"]) {
      expect(classifyUnroutedBlock(guard), guard).toBe("refusal");
    }
  });
});

describe("iteration is reported as work, not as friction", () => {
  // r15's numbers, in the shape the log holds them.
  const R15: readonly LoggedGuardEvent[] = [
    at(0, "contract-purity", "pass"),
    at(2, "checksum-gate", "pass", FREEZE),
    ...Array.from({ length: 4 }, (_, i) => at(3 + i, "git", "block", "git log … → exit 1")),
    at(8, "red-gate", "pass", "RED OK"),
    ...Array.from({ length: 13 }, (_, i) => at(10 + i, "typecheck", "block", "3 errors")),
    ...Array.from({ length: 8 }, (_, i) => at(24 + i, "run_tests", "block", "4 passed, 2 failed")),
    at(33, "path-gate", "block", "builder may not read tests/x.test.ts", { role: "builder" }),
    at(40, "green-gate", "pass", "GREEN"),
  ];

  test("the split keeps every block, on the side that describes it", () => {
    const d = phaseDurations(R15);
    expect(d.friction.refusals).toBe(1);
    expect(d.friction.iteration).toBe(25);
    expect(d.friction.unroutedBlocks).toBe(26); // nothing is dropped by the split
    expect(d.friction.iterationByGuard).toEqual([
      { guard: "typecheck", count: 13 },
      { guard: "run_tests", count: 8 },
      { guard: "git", count: 4 },
    ]);
  });

  test("friction reports refusals only; red-loops get their own line", () => {
    const lines = formatPhaseDurations(phaseDurations(R15));
    expect(lines).toContain("  friction: 1 refusal (path-gate 1) — target 0");
    expect(lines).toContain("  iteration: 25 worker red-loops (typecheck 13, run_tests 8, git 4)");
  });

  test("a phase row separates them too, so the rows and the totals reconcile", () => {
    const lines = formatPhaseDurations(phaseDurations(R15));
    // BUILD holds the 21 worker red-loops and the one refusal. Its SPAN opens
    // at the builder's first attributable event — the run_tests at minute 24 —
    // rather than at the red-gate pass: r15's log predates role-scoped
    // typecheck, so its 13 typecheck blocks name no role and only `run_tests`
    // is attributable. The block counts are unchanged, because blocks are
    // placed by marker index and those boundaries did not move.
    expect(lines).toContain("  timing: build    16m00s  (1 refusal; 21 red-loops)");
    // TESTS holds the architect's four archaeology misses, and calls them
    // red-loops rather than friction.
    expect(lines).toContain("  timing: tests     6m00s  (4 red-loops)");
  });

  test("the per-phase counts still add up to the run's unrouted total", () => {
    const d = phaseDurations(R15);
    const perPhase = d.phases.reduce((n, p) => n + p.unroutedBlocks, 0);
    expect(perPhase + d.unattributedBlocks).toBe(d.friction.unroutedBlocks);
    expect(d.phases.every((p) => p.refusals + p.iteration === p.unroutedBlocks)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The clock (r15): fourteen minutes of provider outage billed to DESIGN
// ---------------------------------------------------------------------------
//
// Both r15 arms opened a session, lost the provider for a quarter of an hour,
// and re-pasted the prompt. The path gate's session-start tool strip is the
// first event in the log, so DESIGN measured from the moment the session
// opened rather than the moment work began: 55m and 80m logged for phases
// that really took ~33m and ~58m. The gate now stamps `run-start` at the first
// gated tool call, and the clock starts there.

const STRIP = { kind: "tool-strip", role: "architect", hidden: ["bash"] };

describe("the run-start marker", () => {
  const IDLE_START: readonly LoggedGuardEvent[] = [
    at(0, "path-gate", "pass", "hid bash from architect", STRIP), // session opened
    // …14 minutes of provider outage, then the prompt lands:
    at(14, "run-start", "pass", "first gated tool call (architect: read)", {
      kind: "run-start",
      role: "architect",
      tool: "read",
    }),
    at(47, "checksum-gate", "pass", FREEZE),
    at(60, "red-gate", "pass", "RED OK"),
    at(75, "green-gate", "pass", "GREEN"),
    at(80, "deliver", "pass", "OK"),
  ];

  test("DESIGN starts at the marker, not at the session's first event", () => {
    const d = phaseDurations(IDLE_START);
    expect(d.phases[0]!.ms).toBe(minutes(33)); // 14 → 47, not 0 → 47
    expect(d.phases[0]!.startedAt).toBe(new Date(T0 + minutes(14)).toISOString());
  });

  test("the total measures the run, not the session", () => {
    expect(phaseDurations(IDLE_START).totalMs).toBe(minutes(66)); // 14 → 80
  });

  test("the headline names the origin of the clock, replacing the one-run caveat", () => {
    const lines = formatPhaseDurations(phaseDurations(IDLE_START));
    expect(lines[0]).toBe("where the minutes went (6 guard events; clock from run-start 09:14:00)");
  });

  test("without a marker, nothing changes and the caveat stands", () => {
    const lines = formatPhaseDurations(phaseDurations(FULL_RUN));
    expect(lines[0]).toBe("where the minutes went (11 guard events, taken as one run)");
    expect(phaseDurations(FULL_RUN).runStartedAt).toBeUndefined();
    expect(phaseDurations(FULL_RUN).phases[0]!.ms).toBe(minutes(4)); // from the first event
  });

  const ARCHITECT_START = { kind: "run-start", role: "architect", tool: "read" };

  test("a restart takes the LAST architect marker before the first phase marker", () => {
    // The outage re-opened the session; the second attempt is the one that
    // produced the run, and the abandoned first attempt is not design time.
    const events = [
      at(0, "path-gate", "pass", "hid bash from architect", STRIP),
      at(2, "run-start", "pass", "first gated tool call (architect: read)", ARCHITECT_START),
      at(20, "path-gate", "pass", "hid bash from architect", STRIP),
      at(22, "run-start", "pass", "first gated tool call (architect: read)", ARCHITECT_START),
      at(40, "checksum-gate", "pass", FREEZE),
      at(50, "red-gate", "pass", "RED OK"),
    ];
    const d = phaseDurations(events);
    expect(d.runStartedAt).toBe(new Date(T0 + minutes(22)).toISOString());
    expect(d.phases[0]!.ms).toBe(minutes(18)); // 22 → 40
  });

  test("subagent run-starts resolve to the architect's — the r16 skew (a late marker must not win)", () => {
    // r16 was written before only the architect stamped a run-start, so the log
    // carries one per subagent session. The architect's real start is ~21m
    // before the freeze; a reviewer commissioned during design stamped its own
    // 2m45s before it. "The last run-start before the first marker" picked the
    // reviewer's and DESIGN collapsed to 2m45s. Filtering to the architect's
    // role picks the true start, whatever order the markers appear in.
    const events = [
      at(0, "path-gate", "pass", "hid bash from architect", STRIP),
      at(1, "run-start", "pass", "first gated tool call (architect: read)", ARCHITECT_START),
      // …the architect commissions a reviewer, whose own session stamps one:
      at(19, "run-start", "pass", "first gated tool call (reviewer: read)", {
        kind: "run-start",
        role: "reviewer",
        tool: "read",
      }),
      at(22, "checksum-gate", "pass", FREEZE),
      at(35, "red-gate", "pass", "RED OK"),
    ];
    const d = phaseDurations(events);
    expect(d.runStartedAt).toBe(new Date(T0 + minutes(1)).toISOString());
    expect(d.phases[0]!.ms).toBe(minutes(21)); // 1 → 22, not 19 → 22
  });

  test("a marker after the first phase marker is a second run, and is ignored", () => {
    // Two tickets through one log. Moving the clock to the later marker would
    // start the report after its own DESIGN phase had ended.
    const events = [
      at(0, "run-start", "pass", "first gated tool call (architect: read)"),
      at(5, "checksum-gate", "pass", FREEZE),
      at(9, "red-gate", "pass", "RED OK"),
      at(30, "run-start", "pass", "first gated tool call (architect: read)"),
      at(40, "checksum-gate", "pass", FREEZE),
    ];
    const d = phaseDurations(events);
    expect(d.runStartedAt).toBe(new Date(T0).toISOString());
    expect(d.phases[0]!.ms).toBe(minutes(5));
  });

  test("the clock moves, but block attribution does not", () => {
    // A refusal during the idle stretch happened in the design phase; it is
    // still DESIGN's, even though the minutes it happened in are not counted.
    const events = [
      at(0, "path-gate", "block", "architect may not write src/x.ts", { role: "architect" }),
      at(14, "run-start", "pass", "first gated tool call (architect: read)"),
      at(20, "checksum-gate", "pass", FREEZE),
      at(30, "red-gate", "pass", "RED OK"),
    ];
    const d = phaseDurations(events);
    expect(d.phases[0]!.refusals).toBe(1);
    expect(d.friction.refusals).toBe(1);
    expect(d.phases[0]!.ms).toBe(minutes(6)); // 14 → 20
  });
});

// ---------------------------------------------------------------------------
// Parallel workers (r15): two rows that read as a sequence
// ---------------------------------------------------------------------------
//
// "tests 8m37s" over "build 5m42s" reads as 14m19s of sequence. When the
// test-writer and the builder ran in parallel it was 12m19s of wall clock, and
// that difference is the whole reason for running them that way.
//
// The rule is about the timestamps, not about how the run was configured: two
// spans that overlap print as one row measured from their union. Note that
// today's markers make TESTS end and BUILD begin at the SAME event — the first
// red-gate pass — so a log the current analysis reduces can only ever produce
// touching spans, and the sequential path is what real runs take. The
// overlapped path is exercised here on spans given directly to the formatter,
// which is what per-worker boundaries will hand it.

/** A PhaseDurations carrying exactly the two worker spans, as the formatter sees them. */
function workerRun(tests: [number, number], build: [number, number]): PhaseDurations {
  const span = (phase: PhaseName, [from, to]: [number, number]): PhaseSpan => ({
    phase,
    ms: minutes(to - from),
    startedAt: new Date(T0 + minutes(from)).toISOString(),
    endedAt: new Date(T0 + minutes(to)).toISOString(),
    bounces: 0,
    byRoute: [],
    refusals: 0,
    iteration: 0,
    unroutedBlocks: 0,
  });
  const empty = (phase: PhaseName): PhaseSpan => ({
    phase,
    incomplete: "not part of this fixture",
    bounces: 0,
    byRoute: [],
    refusals: 0,
    iteration: 0,
    unroutedBlocks: 0,
  });
  const last = Math.max(tests[1], build[1]);
  return {
    phases: [empty("design"), span("tests", tests), span("build", build), empty("wrap")],
    totalMs: minutes(last - Math.min(tests[0], build[0])),
    events: 9,
    skipped: 0,
    bounces: 0,
    unattributedBlocks: 0,
    friction: { refusals: 0, refusalsByGuard: [], iteration: 0, iterationByGuard: [], unroutedBlocks: 0 },
  };
}

describe("overlapping worker phases", () => {
  test("overlapping spans print as one row measured from their union", () => {
    // tests 0 → 8, build 5 → 12: 13m of sequence on two rows, 12m of wall clock.
    const lines = formatPhaseDurations(workerRun([0, 8], [5, 12]));
    expect(lines).toContain("  timing: workers  12m00s  (tests 8m00s ∥ build 7m00s — overlapped)");
    expect(lines.some((l) => l.startsWith("  timing: tests"))).toBe(false);
    expect(lines.some((l) => l.startsWith("  timing: build"))).toBe(false);
  });

  test("the row sits where TESTS sat, so the block still reads top to bottom", () => {
    const lines = formatPhaseDurations(workerRun([0, 8], [5, 12]));
    expect(lines.slice(1).map((l) => l.split(/\s+/)[2])).toEqual([
      "design",
      "workers",
      "wrap",
      "total",
      "0", // the friction line: "friction: 0 refusals — target 0"
    ]);
  });

  test("what the merged rows said is not lost — their notes come along", () => {
    const base = workerRun([0, 8], [5, 12]);
    const withBounces: PhaseDurations = {
      ...base,
      phases: base.phases.map((p) =>
        p.phase === "build"
          ? { ...p, bounces: 1, byRoute: [{ route: "builder", count: 1 }], iteration: 3, unroutedBlocks: 3 }
          : p,
      ),
    };
    expect(formatPhaseDurations(withBounces)).toContain(
      "  timing: workers  12m00s  (tests 8m00s ∥ build 7m00s — overlapped; build: 1 bounce: 1 → builder; build: 3 red-loops)",
    );
  });

  test("spans that merely touch are sequential — which is every run today", () => {
    // The analysis gives TESTS and BUILD the same boundary event, so this is
    // the shape a real log always produces.
    const lines = formatPhaseDurations(phaseDurations(FULL_RUN));
    expect(lines).toContain("  timing: tests    16m00s  (1 bounce: 1 → test-writer)");
    expect(lines).toContain("  timing: build    28m00s  (1 bounce: 1 → builder)");
    expect(lines.some((l) => l.includes("workers"))).toBe(false);
  });

  test("an unmeasured phase cannot overlap anything", () => {
    const lines = formatPhaseDurations(
      phaseDurations([
        at(0, "contract-purity", "pass"),
        at(5, "checksum-gate", "pass", FREEZE),
        at(15, "red-gate", "pass", "RED OK"), // no green: BUILD never completed
      ]),
    );
    expect(lines.some((l) => l.includes("workers"))).toBe(false);
  });

  test("a backwards clock is not an overlap", () => {
    // TESTS ends before it starts (the clamped case), so its window is not a
    // window at all; two of those "overlap" in arithmetic that means nothing.
    const base = workerRun([0, 8], [5, 12]);
    const backwards: PhaseDurations = {
      ...base,
      phases: base.phases.map((p) =>
        p.phase === "tests"
          ? { ...p, ms: 0, startedAt: new Date(T0 + minutes(8)).toISOString(), endedAt: new Date(T0).toISOString() }
          : p,
      ),
    };
    expect(formatPhaseDurations(backwards).some((l) => l.includes("workers"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Worker-derived boundaries: the ∥ row, fired by an actual log
// ---------------------------------------------------------------------------
//
// The row existed before the boundaries did and could not fire, because TESTS
// ended and BUILD began at the same event by construction. Now each worker
// phase opens at that worker's own first attributable event, so a run whose
// two workers really did overlap says so.

describe("workerOf: who an event is attributable to", () => {
  test("run_tests is the builder's by construction — it is a builder-only tool", () => {
    expect(workerOf(at(0, "run_tests", "block", "2 failed"))).toBe("builder");
  });

  test("typecheck carries the calling role, and only the two workers count", () => {
    expect(workerOf(at(0, "typecheck", "block", "1 error", { role: "builder" }))).toBe("builder");
    expect(workerOf(at(0, "typecheck", "pass", "clean", { role: "test-writer" }))).toBe(
      "test-writer",
    );
    expect(workerOf(at(0, "typecheck", "pass", "clean", { role: "architect" }))).toBeUndefined();
    expect(workerOf(at(0, "typecheck", "pass", "clean"))).toBeUndefined();
  });

  // A refusal is a call that did NOT happen, so it is not evidence a worker was
  // working — even though the path-gate block names the role in its detail.
  test("nothing else is attributable, however much role detail it carries", () => {
    expect(workerOf(at(0, "path-gate", "block", "builder may not read tests/x", { role: "builder" })))
      .toBeUndefined();
    expect(workerOf(at(0, "red-gate", "pass", "RED OK"))).toBeUndefined();
  });
});

describe("two workers running in parallel", () => {
  // The architect freezes at 5, commissions both, and they work concurrently:
  // the test-writer from 8 to the red pass at 20, the builder from 10 to the
  // green pass at 34. 8→34 is 26 minutes of wall clock; printed as two rows it
  // would read as 12 + 24 = 36.
  const PARALLEL: readonly LoggedGuardEvent[] = [
    at(0, "run-start", "pass", "first gated tool call (architect: read)"),
    at(1, "contract-purity", "pass"),
    at(5, "checksum-gate", "pass", FREEZE),
    at(8, "typecheck", "block", "2 errors", { role: "test-writer" }),
    at(10, "typecheck", "block", "5 errors", { role: "builder" }),
    at(14, "run_tests", "block", "6 passed, 4 failed"),
    at(18, "typecheck", "pass", "no type errors", { role: "test-writer" }),
    at(20, "red-gate", "pass", "RED OK"),
    at(26, "run_tests", "block", "9 passed, 1 failed"),
    at(34, "green-gate", "pass", "GREEN"),
    at(36, "sign-off", "pass", "0 findings"),
  ];

  test("each worker phase opens at that worker's own first event", () => {
    expect(phase(PARALLEL, "tests")).toMatchObject({ ms: minutes(12) }); // 8 → 20
    expect(phase(PARALLEL, "build")).toMatchObject({ ms: minutes(24) }); // 10 → 34
  });

  test("DESIGN and WRAP are untouched — only the worker phases moved", () => {
    expect(phase(PARALLEL, "design")).toMatchObject({ ms: minutes(5) }); // run-start → freeze
    expect(phase(PARALLEL, "wrap")).toMatchObject({ ms: minutes(2) }); // green → sign-off
  });

  test("the overlapped row fires, measured from the union of the two windows", () => {
    const lines = formatPhaseDurations(phaseDurations(PARALLEL));
    // The notes are kept: a bounce or a red-loop that vanished because two
    // rows became one would be a measurement lost to a presentation change.
    // They still read from the block REGIONS, which the gate markers define
    // and these boundaries deliberately did not move.
    expect(lines).toContain(
      "  timing: workers  26m00s  (tests 12m00s ∥ build 24m00s — overlapped; " +
        "tests: 3 red-loops; build: 1 red-loop)",
    );
    // ...and the two separate rows are gone, so nothing is double-counted.
    expect(lines.some((l) => l.includes("timing: tests"))).toBe(false);
    expect(lines.some((l) => l.includes("timing: build"))).toBe(false);
  });

  test("a run whose workers logged nothing attributable measures as it always did", () => {
    const sequential: readonly LoggedGuardEvent[] = [
      at(0, "checksum-gate", "pass", FREEZE),
      at(10, "red-gate", "pass", "RED OK"),
      at(25, "green-gate", "pass", "GREEN"),
    ];
    expect(phase(sequential, "tests")).toMatchObject({ ms: minutes(10) }); // freeze → red
    expect(phase(sequential, "build")).toMatchObject({ ms: minutes(15) }); // red → green
    expect(formatPhaseDurations(phaseDurations(sequential)).some((l) => l.includes("workers"))).toBe(
      false,
    );
  });

  // A worker event AFTER the phase's closing marker is a later bounce, not the
  // opening — taking it would put BUILD's start after BUILD's end.
  test("a builder event after the green pass does not open BUILD", () => {
    const late: readonly LoggedGuardEvent[] = [
      at(0, "checksum-gate", "pass", FREEZE),
      at(10, "red-gate", "pass", "RED OK"),
      at(25, "green-gate", "pass", "GREEN"),
      at(30, "run_tests", "pass", "all passed"),
    ];
    expect(phase(late, "build")).toMatchObject({ ms: minutes(15) }); // red → green, unchanged
  });

  // A shared log with a previous ticket's worker events must not pull a
  // boundary back behind the design that produced this one.
  test("worker events before the freeze are not the opening", () => {
    const shared: readonly LoggedGuardEvent[] = [
      at(0, "run_tests", "pass", "a previous ticket"),
      at(2, "typecheck", "pass", "clean", { role: "test-writer" }),
      at(5, "checksum-gate", "pass", FREEZE),
      at(20, "red-gate", "pass", "RED OK"),
      at(30, "green-gate", "pass", "GREEN"),
    ];
    expect(phase(shared, "tests")).toMatchObject({ ms: minutes(15) }); // freeze → red
    expect(phase(shared, "build")).toMatchObject({ ms: minutes(10) }); // red → green
  });
});
