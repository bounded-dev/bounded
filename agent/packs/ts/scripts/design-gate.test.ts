import { writeProjectPacks } from "../../../src/project-composition.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, test } from "vitest";
import {
  classifyDesignGate,
  classifyReviewFreshness,
  DESIGN_STEPS,
  reviewStepOutcome,
  type StepOutcome,
} from "./design-gate.ts";
import { FREEZABLE_NOW, runRecordDesignReview } from "./design-review.ts";
import { readGuardLog, type LoggedGuardEvent } from "../../../src/guard-log.ts";
import { checkSpawnPrecondition } from "../../../src/phase-gate.ts";

// --- pure core: classifyDesignGate --------------------------------------------

function step(name: StepOutcome["step"], code: number, ms = 1200, lines: string[] = []): StepOutcome {
  return { step: name, code, lines, ms };
}

describe("classifyDesignGate", () => {
  test("every step passing → exit 0 and ONE final verdict", () => {
    const r = classifyDesignGate([
      step("contract-purity", 0, 3200, ["contract-purity: OK (1 file)"]),
      step("scaffold", 0, 400),
      step("typecheck", 0, 2100),
      step("design-review", 0, 0, ["design-review: fresh (0 findings, 0 blockers, recorded 14:32:11Z)"]),
      step("freeze", 0, 100),
    ]);
    expect(r.code).toBe(0);
    expect(r.verdict).toBe("pass");
    expect(r.lines).toContain("contract-purity: OK (1 file)");
    expect(r.lines).toContain("contract-purity: PASS (3.2s)");
    expect(r.lines).toContain("typecheck: PASS (2.1s)");
    expect(r.lines).toContain("design-review: fresh (0 findings, 0 blockers, recorded 14:32:11Z)");
    // Exactly one line is the gate's own verdict — the round-trip this gate
    // exists to remove is the architect reading five of them.
    expect(r.lines.filter((l) => l.startsWith("design-gate:"))).toEqual([
      "design-gate: OK — contract-purity → scaffold → typecheck → design-review → freeze (5.8s)",
    ]);
  });

  test("a blocked step names itself, the steps that did not run, and the route", () => {
    const r = classifyDesignGate([
      step("contract-purity", 0),
      step("scaffold", 1, 500, ["scaffold: BLOCK — declares only types"]),
    ]);
    expect(r.code).toBe(1);
    expect(r.verdict).toBe("block");
    expect(r.lines).toContain("scaffold: BLOCK (0.5s)");
    expect(r.lines).toContain(
      "design-gate: FAIL — scaffold blocked; typecheck, design-review, freeze did not run",
    );
    expect(r.lines).toContain("design-gate: route → architect");
    expect(r.summary).toBe("scaffold blocked (route: architect)");
  });

  test("a step that could not run at all is misuse (exit 2), still routed", () => {
    const r = classifyDesignGate([step("contract-purity", 2, 100, ["contract-purity: no files matched"])]);
    expect(r.code).toBe(2);
    expect(r.verdict).toBe("error");
    expect(r.lines).toContain("contract-purity: ERROR (0.1s)");
    expect(r.lines).toContain(
      "design-gate: FAIL — contract-purity could not run; scaffold, typecheck, design-review, freeze did not run",
    );
    expect(r.lines).toContain("design-gate: route → architect");
  });

  test("the failing last step reports nothing skipped", () => {
    const r = classifyDesignGate([
      step("contract-purity", 0),
      step("scaffold", 0),
      step("typecheck", 0),
      step("design-review", 0),
      step("freeze", 1),
    ]);
    expect(r.lines).toContain("design-gate: FAIL — freeze blocked");
  });

  // On the re-freeze fast path the review is evaluated FIRST, so the steps that
  // never ran sit before it as well as after it. "Everything after the failure"
  // would have under-reported them by three.
  test("a failure names every step that did not run, not just the ones after it", () => {
    const r = classifyDesignGate([
      step("design-review", 1, 40, ["design-review: BLOCK — reviewed at 14:32:11Z, then edited"]),
    ]);
    expect(r.code).toBe(1);
    expect(r.lines).toContain(
      "design-gate: FAIL — design-review missing (or stale); contract-purity, scaffold, typecheck, freeze did not run",
    );
  });

  // The review step runs nothing, so "blocked" would send the architect looking
  // for output that does not exist. The one FAIL line has to say which of the
  // two states it is in — and the step's own lines above it say which file.
  test("a missing or stale review reads as such, not as a check that said no", () => {
    const r = classifyDesignGate([
      step("contract-purity", 0),
      step("scaffold", 0),
      step("typecheck", 0),
      step("design-review", 1, 100, ["design-review: BLOCK — this design has never been reviewed"]),
    ]);
    expect(r.code).toBe(1);
    expect(r.lines).toContain("design-gate: FAIL — design-review missing (or stale); freeze did not run");
    expect(r.lines).toContain("design-gate: route → architect");
    expect(r.summary).toBe("design-review missing (or stale) (route: architect)");
  });
});

// --- CLI (fixture repos) ------------------------------------------------------

const SCRIPT = join(import.meta.dirname, "design-gate.ts");
const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A contract that passes purity, scaffolds and typechecks: a domain value
 *  object in the ADR 2026-059 form (interface + factory, `@accepts` examples
 *  for its generated laws). */
const CLEAN_CONTRACT = `import type { Result } from "../shared/result.ts";

/**
 * An ISO-4217 currency code: three uppercase letters.
 * @accepts "USD"
 * @accepts "EUR"
 */
export interface Currency {
  readonly __brand: "Currency";
  readonly value: string;
  equals(other: Currency): boolean;
  toJSON(): string;
}

export interface CurrencyFactory {
  parse(raw: unknown): Result<Currency>;
}
`;

/** Passes purity but an emitter refuses it: a feature in an area that is
 *  not a plural business noun (TN-26-012 §2), so the scaffold step blocks. */
const BAD_AREA_CONTRACT = `/**
 * Move money
 */
export interface MoveMoney {
  execute(): Promise<void>;
}
`;
const BAD_AREA_PATH = join("application", "money", "move-money", "move-money.contract.ts");

/** A second clean contract, for the file a review never saw: the ADR
 *  2026-059 interface + factory pair (the retired `declare class` form now
 *  fails contract-purity). */
const TICKER_CONTRACT = `import type { Result } from "../shared/result.ts";

/**
 * An exchange symbol: one to five uppercase letters.
 * @accepts "AAPL"
 * @accepts "MSFT"
 */
export interface Ticker {
  readonly __brand: "Ticker";
  readonly value: string;
  equals(other: Ticker): boolean;
  toJSON(): string;
}

export interface TickerFactory {
  parse(raw: unknown): Result<Ticker>;
}
`;

/** The retired \`declare class\` form: the purity gate's own failure. */
const IMPURE_CONTRACT = `export declare class Currency {
  private constructor();
  static parse(raw: unknown): Currency | undefined;
}
`;

/** The half the contract cannot hold — and half of what the reviewer reads. */
const SPEC = `# Money

Ordering, the arithmetic and its tie-break, identity: everything the two blind
roles must agree on that TypeScript cannot say.
`;

/** A source root of the composed hexagonal layout: where contracts live. */
const ROOT = join("contexts", "money", "src");

/** The clean contract's path under the source root. */
const CONTRACT_PATH = join("domain", "currencies", "currency.contract.ts");
/** Where the second contract goes: a file the review never saw. */
const TICKER_PATH = join("domain", "tickers", "ticker.contract.ts");
const TICKER_REL = "contexts/money/src/domain/tickers/ticker.contract.ts";

function place(dir: string, rel: string, content: string): void {
  mkdirSync(join(dir, ROOT, rel, ".."), { recursive: true });
  writeFileSync(join(dir, ROOT, rel), content);
}

function fixtureRepo(prefix: string, contract: string, tscOutput = "", path = CONTRACT_PATH): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  writeProjectPacks(dir, ["ts", "ts-hexagonal"]);
  tmpDirs.push(dir);
  place(dir, path, contract);
  writeFileSync(join(dir, "spec.md"), SPEC);
  writeFileSync(join(dir, "package.json"), '{"name":"fixture"}\n');
  // tsc stand-in: replay a captured diagnostics file with tsc's exit code.
  writeFileSync(join(dir, "tsc.txt"), tscOutput);
  return dir;
}

/**
 * Record a review of the fixture exactly as the reviewer would — through the
 * recorder the `record_design_review` tool calls, never a hand-written event.
 * A fixture that forged the event could pin a shape the tool does not produce.
 */
function review(dir: string, findings: unknown = []) {
  return runRecordDesignReview(dir, findings);
}

function runGate(dir: string, typeErrors = false) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      BOUNDED_GATE_TSC_CMD: "sh",
      BOUNDED_GATE_TSC_ARGS: JSON.stringify(["-c", `cat tsc.txt; exit ${typeErrors ? 2 : 0}`]),
    },
  });
}

const MANIFEST = join(".bounded", "contract-checksums.json");
const SKELETON = join(ROOT, "domain", "currencies", "currency.ts");

const CONTRACT_TYPE_ERR = "contexts/money/src/domain/currencies/currency.contract.ts(3,1): error TS2304: Cannot find name 'Iso'.";
const SKELETON_TYPE_ERR = "contexts/money/src/domain/currencies/currency.ts(9,3): error TS2322: Type 'string' is not assignable.";

describe("design-gate CLI: the whole design phase in one call", () => {
  test("a ticket TN must be active before its reviewed design freezes", () => {
    const dir = fixtureRepo("design-ticket-draft-", CLEAN_CONTRACT);
    mkdirSync(join(dir, "docs/tn"), { recursive: true });
    writeFileSync(join(dir, "docs/tn/README.md"), "# Technical Notes\n");
    const note = join(dir, "docs/tn/TN-24.md");
    const front = (status: string) =>
      `---\nissue: 24\nstatus: ${status}\ncontracts:\n  - contexts/money/src/domain/currencies/currency.contract.ts\n---\n\n${SPEC}`;
    writeFileSync(note, front("draft"));
    const prior = process.env.BOUNDED_TICKET;
    process.env.BOUNDED_TICKET = "24";
    try {
      review(dir);
      const blocked = runGate(dir);
      expect(blocked.status).toBe(1);
      expect(blocked.stdout).toContain("is draft; mark the agreed design active");
      expect(existsSync(join(dir, ".bounded/tickets/24/contract-checksums.json"))).toBe(false);
      writeFileSync(note, front("active"));
      const frozen = runGate(dir);
      expect(frozen.status, frozen.stdout + frozen.stderr).toBe(0);
      expect(existsSync(join(dir, ".bounded/tickets/24/contract-checksums.json"))).toBe(true);
    } finally {
      if (prior === undefined) delete process.env.BOUNDED_TICKET;
      else process.env.BOUNDED_TICKET = prior;
    }
  });
  test("all five steps pass → exit 0, timed steps, one verdict, a frozen manifest", () => {
    const dir = fixtureRepo("design-ok-", CLEAN_CONTRACT);
    review(dir);
    const r = runGate(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/contract-purity: PASS \(\d+\.\d+s\)/);
    expect(r.stdout).toMatch(/scaffold: PASS \(\d+\.\d+s\)/);
    expect(r.stdout).toMatch(/typecheck: PASS \(\d+\.\d+s\)/);
    expect(r.stdout).toMatch(/design-review: PASS \(\d+\.\d+s\)/);
    expect(r.stdout).toMatch(/freeze: PASS \(\d+\.\d+s\)/);
    expect(r.stdout).toMatch(
      /design-gate: OK — contract-purity → scaffold → typecheck → design-review → freeze \(\d+\.\d+s\)/,
    );
    // Each step's own output survives into the aggregate.
    expect(r.stdout).toMatch(/contract-purity: OK \(1 file\)/);
    expect(r.stdout).toMatch(/scaffold: wrote .*currency\.ts \(skeleton, domain-concepts\)/);
    expect(r.stdout).toMatch(/typecheck: OK — no type errors/);
    expect(r.stdout).toMatch(/design-review: challenged \(0 findings, 0 blockers\) — advisory; you decide\./);
    expect(r.stdout).toMatch(/checksum-gate: wrote \.bounded\/contract-checksums\.json/);
    expect(existsSync(join(dir, SKELETON))).toBe(true);
    expect(existsSync(join(dir, MANIFEST))).toBe(true);
  });

  test("the composite event records every step's outcome and duration", () => {
    const dir = fixtureRepo("design-log-", CLEAN_CONTRACT);
    review(dir);
    expect(runGate(dir).status).toBe(0);
    const composite = readGuardLog(dir).filter((e) => e.guard === "design-gate");
    expect(composite).toHaveLength(1);
    expect(composite[0]).toMatchObject({ guard: "design-gate", verdict: "pass" });
    const detail = composite[0].detail as { steps: { step: string; verdict: string; ms: number }[] };
    expect(detail.steps.map((s) => s.step)).toEqual([...DESIGN_STEPS]);
    expect(detail.steps.every((s) => s.verdict === "pass")).toBe(true);
    expect(detail.steps.every((s) => typeof s.ms === "number")).toBe(true);
  });

  // The phase gate derives the DESIGN ordering from the INNER guard names, so
  // wrapping the steps must not stop them being logged — a composite that
  // swallowed its own steps would silently lock the pipeline at COMMISSION.
  test("the inner guard events still flow, so the phase gate still opens", () => {
    const dir = fixtureRepo("design-phase-", CLEAN_CONTRACT);
    review(dir);
    expect(runGate(dir).status).toBe(0);
    const events = readGuardLog(dir);
    for (const guard of ["contract-purity", "scaffold", "checksum-gate"]) {
      expect(
        events.some((e) => e.guard === guard && e.verdict === "pass"),
        `${guard} must still reach the guard log`,
      ).toBe(true);
    }
    expect(
      checkSpawnPrecondition("test-writer", {
        contracts: ["contexts/money/src/domain/currencies/currency.contract.ts"],
        specText:
          "# Money\n\n## Intake\n\nNothing stripped.\n\n## Rules\n\n" +
          "Ordering, arithmetic, tie-breaks and identity. ".repeat(12),
        events,
      }).allow,
    ).toBe(true);
  });

  test("re-running is idempotent: the same manifest, the same verdict", () => {
    const dir = fixtureRepo("design-idem-", CLEAN_CONTRACT);
    review(dir);
    expect(runGate(dir).status).toBe(0);
    const first = readFileSync(join(dir, MANIFEST), "utf8");
    const second = runGate(dir);
    expect(second.status).toBe(0);
    expect(readFileSync(join(dir, MANIFEST), "utf8")).toBe(first);
    expect(second.stdout).toMatch(/design-gate: OK/);
    expect(readGuardLog(dir).filter((e) => e.guard === "design-gate")).toHaveLength(2);
  });
});

// A failure at any step must halt the sequence. The assertion that matters is
// not the exit code — it is that the LATER steps left no trace: a skeleton
// generated from a contract that failed purity, or a manifest freezing a
// contract that does not compile, is exactly the ordering fumble this gate
// replaces.
describe("design-gate CLI: the first failure halts the sequence", () => {
  test("purity blocks → nothing is scaffolded and nothing is frozen", () => {
    const dir = fixtureRepo("design-impure-", IMPURE_CONTRACT);
    const r = runGate(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/bounded-ts\/value-object-shape/);
    expect(r.stdout).toMatch(/contract-purity: BLOCK \(\d+\.\d+s\)/);
    expect(r.stdout).toContain(
      "design-gate: FAIL — contract-purity blocked; scaffold, typecheck, design-review, freeze did not run",
    );
    expect(r.stdout).toContain("design-gate: route → architect");
    expect(existsSync(join(dir, SKELETON))).toBe(false);
    expect(existsSync(join(dir, MANIFEST))).toBe(false);
    expect(readGuardLog(dir).some((e) => e.guard === "checksum-gate")).toBe(false);
  });

  test("scaffold blocks → the typecheck never runs and nothing is frozen", () => {
    const dir = fixtureRepo("design-badarea-", BAD_AREA_CONTRACT, "", BAD_AREA_PATH);
    const r = runGate(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/scaffold: BLOCK — emitter '[a-z-]+': .*move-money\.contract\.ts: area 'money' must be a kebab-case plural business noun/);
    expect(r.stdout).toMatch(/scaffold: BLOCK \(\d+\.\d+s\)/);
    expect(r.stdout).toContain(
      "design-gate: FAIL — scaffold blocked; typecheck, design-review, freeze did not run",
    );
    expect(r.stdout).toContain("design-gate: route → architect");
    expect(existsSync(join(dir, MANIFEST))).toBe(false);
  });

  test("typecheck blocks → the contract is NOT frozen", () => {
    const dir = fixtureRepo(
      "design-typedirty-",
      CLEAN_CONTRACT,
      `${CONTRACT_TYPE_ERR}\n${SKELETON_TYPE_ERR}\nFound 2 errors.\n`,
    );
    const r = runGate(dir, true);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/typecheck: 2 type errors/);
    expect(r.stdout).toMatch(/typecheck: BLOCK \(\d+\.\d+s\)/);
    expect(r.stdout).toContain("design-gate: FAIL — typecheck blocked; design-review, freeze did not run");
    // The skeleton was generated (scaffold passed) but the manifest was not:
    // freezing a contract that does not compile is the fumble to prevent.
    expect(existsSync(join(dir, SKELETON))).toBe(true);
    expect(existsSync(join(dir, MANIFEST))).toBe(false);
    expect(readGuardLog(dir).find((e) => e.guard === "design-gate")).toMatchObject({
      verdict: "block",
      detail: { failed: "typecheck", route: "architect" },
    });
  });

  // typecheck-routing attributes each diagnostic to the role whose write zone
  // owns the file, and a skeleton lives in the builder's zone. At DESIGN the
  // builder does not exist yet, so the attribution is shown and the route is
  // still the architect's.
  test("a diagnostic attributed to another role still routes to the architect", () => {
    const dir = fixtureRepo("design-route-", CLEAN_CONTRACT, `${SKELETON_TYPE_ERR}\nFound 1 error.\n`);
    const r = runGate(dir, true);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("  builder (1):");
    expect(r.stdout).toContain(SKELETON_TYPE_ERR);
    expect(r.stdout).toContain("design-gate: route → architect");
    expect(r.stdout).not.toContain("design-gate: route → builder");
  });

  test("tsc failing without a parseable diagnostic is misuse, not a design defect", () => {
    const dir = fixtureRepo("design-tscbroken-", CLEAN_CONTRACT, "sh: tsc: command not found\n");
    const r = runGate(dir, true);
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/typecheck: ERROR — tsc failed without a parseable diagnostic/);
    expect(r.stdout).toContain(
      "design-gate: FAIL — typecheck could not run; design-review, freeze did not run",
    );
    expect(existsSync(join(dir, MANIFEST))).toBe(false);
  });
});

// A change run (ADR 2026-028) revises the contract over a tree that already
// implements the old one, so the tree failing to compile IS the change: the
// workers repair their own zones once commissioned, and they cannot be
// commissioned until the freeze. On a RE-freeze, worker-owned drift therefore
// does not block — while anything design-owned (a contract, config, or a
// generated skeleton wearing the builder's path) still does, and a FIRST
// freeze keeps the full block.
describe("design-gate CLI: on a re-freeze, worker-owned drift does not block", () => {
  const TESTS_TYPE_ERR = "contexts/money/src/domain/currencies/currency.test.ts(3,3): error TS2339: Property 'reformat' does not exist.";
  const HAND_IMPL_ERR = "contexts/money/src/domain/currencies/currency-format.ts(1,1): error TS2322: Type 'string' is not assignable.";

  /** Freeze once clean, then hand the gate a dirty tsc for the second pass. */
  function frozenFixture(prefix: string): string {
    const dir = fixtureRepo(prefix, CLEAN_CONTRACT);
    review(dir);
    expect(runGate(dir).status).toBe(0);
    // A hand-written implementation file (no emitter writes it): builder-owned.
    writeFileSync(join(dir, ROOT, "domain", "currencies", "currency-format.ts"), "export const rounding = 1;\n");
    return dir;
  }

  test("drift owned by the workers alone → the re-freeze proceeds, attributed and logged", () => {
    const dir = frozenFixture("design-refreeze-drift-");
    writeFileSync(join(dir, "tsc.txt"), `${TESTS_TYPE_ERR}\n${HAND_IMPL_ERR}\nFound 2 errors.\n`);
    const r = runGate(dir, true);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/typecheck: 2 pre-freeze drift errors — all worker-owned, so the re-freeze proceeds/);
    expect(r.stdout).toContain("  test-writer (1):");
    expect(r.stdout).toContain("  builder (1):");
    expect(r.stdout).toMatch(/green_gate still requires a clean project/);
    expect(r.stdout).toMatch(/design-gate: OK/);
    expect(existsSync(join(dir, MANIFEST))).toBe(true);
    // The composite event records that the freeze knowingly stood over drift.
    const composite = readGuardLog(dir).filter((e) => e.guard === "design-gate");
    expect(composite.at(-1)).toMatchObject({
      verdict: "pass",
      detail: { reFreeze: true, typecheckDrift: { errors: 2, owners: ["test-writer", "builder"] } },
    });
  });

  test("a contract diagnostic still blocks a re-freeze", () => {
    const dir = frozenFixture("design-refreeze-contract-");
    writeFileSync(join(dir, "tsc.txt"), `${CONTRACT_TYPE_ERR}\n${TESTS_TYPE_ERR}\nFound 2 errors.\n`);
    const r = runGate(dir, true);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/typecheck: 2 type errors/);
    expect(r.stdout).toContain("design-gate: route → architect");
  });

  test("a diagnostic in a generated skeleton is the contract's, and still blocks", () => {
    const dir = frozenFixture("design-refreeze-skeleton-");
    // currency.ts was scaffolded during the first pass and nobody has touched it.
    writeFileSync(join(dir, "tsc.txt"), `${SKELETON_TYPE_ERR}\nFound 1 error.\n`);
    const r = runGate(dir, true);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(
      "note: contexts/money/src/domain/currencies/currency.ts is a generated skeleton — those diagnostics are the contract's own, not builder drift",
    );
    expect(r.stdout).toContain("design-gate: route → architect");
  });

  test("a FIRST freeze keeps the full block, worker-owned or not", () => {
    const dir = fixtureRepo("design-first-drift-", CLEAN_CONTRACT, `${TESTS_TYPE_ERR}\nFound 1 error.\n`);
    review(dir);
    const r = runGate(dir, true);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/typecheck: 1 type error/);
    expect(r.stdout).toContain("design-gate: FAIL — typecheck blocked; design-review, freeze did not run");
    expect(existsSync(join(dir, MANIFEST))).toBe(false);
  });

  // ADR 2026-071: a ticket that takes a delivered ticket's contract changes
  // what the earlier ticket's workers built, so on its FIRST freeze that
  // worker-owned drift is the change, exactly as on a re-freeze.
  const CURRENCY_REL = "contexts/money/src/domain/currencies/currency.contract.ts";

  /** TN-1 owns the currency contract; TN-2 lists it and the ticker, and takes
   *  the currency contract from TN-1 when `take` is set (else lists only the
   *  ticker). Ticket 2 is active; the gate is run under it. */
  function takingFixture(prefix: string, take: boolean): { dir: string; gate: () => ReturnType<typeof runGate> } {
    const dir = fixtureRepo(prefix, CLEAN_CONTRACT);
    place(dir, TICKER_PATH, TICKER_CONTRACT);
    mkdirSync(join(dir, "docs/tn"), { recursive: true });
    writeFileSync(join(dir, "docs/tn/README.md"), "# Technical Notes\n");
    writeFileSync(join(dir, "docs/tn/TN-1.md"),
      `---\nissue: 1\nstatus: active\ncontracts:\n  - ${CURRENCY_REL}\n---\n\n${SPEC}`);
    writeFileSync(join(dir, "docs/tn/TN-2.md"), take
      ? `---\nissue: 2\nstatus: active\ncontracts:\n  - ${CURRENCY_REL}\n  - ${TICKER_REL}\n` +
        `takes:\n  - ${CURRENCY_REL} from TN-1\n---\n\n${SPEC}`
      : `---\nissue: 2\nstatus: active\ncontracts:\n  - ${TICKER_REL}\n---\n\n${SPEC}`);
    // A hand-written implementation file from ticket #1's build: builder-owned.
    writeFileSync(join(dir, ROOT, "domain", "currencies", "currency-format.ts"), "export const rounding = 1;\n");
    writeFileSync(join(dir, "tsc.txt"), `${HAND_IMPL_ERR}\n${TESTS_TYPE_ERR}\nFound 2 errors.\n`);
    const withTicket = <T>(fn: () => T): T => {
      const prior = process.env.BOUNDED_TICKET;
      process.env.BOUNDED_TICKET = "2";
      try {
        return fn();
      } finally {
        if (prior === undefined) delete process.env.BOUNDED_TICKET;
        else process.env.BOUNDED_TICKET = prior;
      }
    };
    withTicket(() => review(dir));
    return { dir, gate: () => withTicket(() => runGate(dir, true)) };
  }

  test("a first freeze that takes a delivered contract stands over worker-owned drift in earlier work", () => {
    const { dir, gate } = takingFixture("design-take-drift-", true);
    const r = gate();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/worker-owned/);
    expect(r.stdout).toContain("  builder (1):");
    const manifest = join(dir, ".bounded/tickets/2/contract-checksums.json");
    expect(existsSync(manifest)).toBe(true);
    expect(readFileSync(manifest, "utf8")).toContain(CURRENCY_REL);
    expect(readGuardLog(dir).filter((e) => e.guard === "design-gate").at(-1)).toMatchObject({
      detail: { reFreeze: false, typecheckDrift: { errors: 2 } },
    });
  });

  test("the same drift on a first freeze with no take still blocks", () => {
    const { dir, gate } = takingFixture("design-notake-drift-", false);
    const r = gate();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("design-gate: FAIL — typecheck blocked");
    expect(existsSync(join(dir, ".bounded/tickets/2/contract-checksums.json"))).toBe(false);
  });
});


// The freeze is the moment a design becomes expensive to change: from here the
// test-writer and the builder both build on it, and run r13 measured 30–38
// minutes to repair a contract defect discovered after that point. So the gate
// refuses to freeze a design no reviewer has read AS IT NOW STANDS. It never
// JUDGES what the review said — that is the architect's to settle — but it does
// carry the claims out, because the architect holds no `record_design_review`
// and this is the only route the reviewer's words have to it.
describe("classifyReviewFreshness: which review, if any, stands", () => {
  const CURRENT = { "spec.md": "a".repeat(64), "src/x.contract.ts": "b".repeat(64) };

  function reviewEvent(
    reviewed: Record<string, string>,
    extra: Record<string, unknown> = {},
    verdict = "pass",
    ts = "2026-09-08T14:32:11.000Z",
  ): LoggedGuardEvent {
    return {
      ts,
      guard: "design-review",
      verdict: verdict as LoggedGuardEvent["verdict"],
      summary: "reviewed 2 files, no findings",
      detail: { reviewed, blockers: 0, severities: [], findings: [], ...extra },
    };
  }

  test("no design-review event at all → missing", () => {
    expect(classifyReviewFreshness([], CURRENT)).toEqual({ state: "missing" });
  });

  test("a matching review is fresh, and carries its counts, its clock and its claims", () => {
    const event = reviewEvent(CURRENT, {
      blockers: 1,
      severities: ["blocker", "note"],
      findings: [{ severity: "blocker", summary: "x" }, { severity: "note", summary: "y" }],
    });
    expect(classifyReviewFreshness([event], CURRENT)).toEqual({
      state: "fresh",
      at: "2026-09-08T14:32:11.000Z",
      findings: 2,
      blockers: 1,
      recorded: [
        { severity: "blocker", summary: "x" },
        { severity: "note", summary: "y" },
      ],
    });
  });

  // An older event that logged only the severities still yields its counts,
  // and simply replays nothing. A gate that threw on it would make one
  // superseded log format able to jam a design phase.
  test("a review recorded without its findings is still fresh, with nothing to replay", () => {
    const event: LoggedGuardEvent = {
      ts: "2026-09-08T14:32:11.000Z",
      guard: "design-review",
      verdict: "pass",
      summary: "2 findings (1 blocker) over 2 files",
      // No `findings` key at all: the shape an older harness version wrote.
      detail: { reviewed: CURRENT, blockers: 1, severities: ["blocker", "note"] },
    };
    expect(classifyReviewFreshness([event], CURRENT)).toMatchObject({
      state: "fresh",
      findings: 2,
      blockers: 1,
      recorded: [],
    });
  });

  // Freshness is FILE-SET, not bytes: a file whose CONTENT changed but whose
  // path the review already covered is still fresh. The architect owns the
  // spec and the contracts and may revise them in answer to what the review
  // raised — that does not un-review the design.
  test("a CONTENT edit to a file the review already saw stays fresh", () => {
    const edited = classifyReviewFreshness([reviewEvent(CURRENT)], {
      ...CURRENT,
      "spec.md": "c".repeat(64),
    });
    expect(edited).toMatchObject({ state: "fresh" });
  });

  // Only ADDING or REMOVING a contract file stales — that is surface the fresh
  // mind never saw, or the hole left by a shape it read.
  test("an added or removed contract file is stale, named", () => {
    const added = classifyReviewFreshness([reviewEvent(CURRENT)], {
      ...CURRENT,
      "src/y.contract.ts": "d".repeat(64),
    });
    expect(added).toMatchObject({ state: "stale", added: ["src/y.contract.ts"], removed: [] });

    const removed = classifyReviewFreshness([reviewEvent(CURRENT)], { "spec.md": CURRENT["spec.md"] });
    expect(removed).toMatchObject({ state: "stale", added: [], removed: ["src/x.contract.ts"] });
  });

  // Misuse — no spec, no contracts, a malformed payload — logs a design-review
  // event with verdict "error". Counting one as a review would let a failed
  // call unlock the freeze, which is the opposite of what it means.
  test("an errored design-review event is not a review", () => {
    const events = [reviewEvent(CURRENT, {}, "error")];
    expect(classifyReviewFreshness(events, CURRENT)).toEqual({ state: "missing" });
  });

  test("a pass carrying no byte record covers nothing, so it is not a review either", () => {
    const orphan: LoggedGuardEvent = {
      ts: "2026-09-08T14:00:00.000Z",
      guard: "design-review",
      verdict: "pass",
      summary: "reviewed",
      detail: { blockers: 0 },
    };
    expect(classifyReviewFreshness([orphan], CURRENT)).toEqual({ state: "missing" });
  });

  // The ordering rule, pinned deliberately: LATEST PASS BY APPEND ORDER, the
  // same rule green-gate uses for the red it requires. An earlier review that
  // covered the current file set does not revive when the latest one covered a
  // different set; the log's last word is the review that stands.
  test("the LATEST pass decides: an earlier matching review does not revive", () => {
    const events = [
      reviewEvent(CURRENT, {}, "pass", "2026-09-08T14:00:00.000Z"),
      // The latest review saw only spec.md — the contract file is surface it
      // never covered, so the design is stale however well the earlier one fits.
      reviewEvent({ "spec.md": CURRENT["spec.md"] }, {}, "pass", "2026-09-08T15:00:00.000Z"),
    ];
    expect(classifyReviewFreshness(events, CURRENT)).toMatchObject({
      state: "stale",
      at: "2026-09-08T15:00:00.000Z",
      added: ["src/x.contract.ts"],
    });
  });

  test("a later review covering the full set supersedes an earlier partial one", () => {
    const events = [
      reviewEvent({ "spec.md": CURRENT["spec.md"] }, {}, "pass", "2026-09-08T14:00:00.000Z"),
      reviewEvent(CURRENT, {}, "pass", "2026-09-08T15:00:00.000Z"),
    ];
    expect(classifyReviewFreshness(events, CURRENT)).toMatchObject({ state: "fresh" });
  });
});

describe("reviewStepOutcome: the step says which of the two it is", () => {
  test("a fresh review passes and prints that it was consulted, advisory", () => {
    const r = reviewStepOutcome({
      state: "fresh",
      at: "2026-09-08T14:32:11.000Z",
      findings: 0,
      blockers: 0,
      recorded: [],
    });
    expect(r.code).toBe(0);
    expect(r.lines).toEqual([
      "design-review: challenged (0 findings, 0 blockers) — advisory; you decide.",
    ]);
  });

  // The architect holds no `record_design_review`, so this step is the only
  // route the reviewer's words have to it. r15's architect went hunting through
  // `git` for text this gate was already holding, then revived the reviewer to
  // make it recite the findings — three failed calls and a whole child session
  // to recover a string the log had all along.
  test("a fresh review replays every finding verbatim, evidence included", () => {
    const r = reviewStepOutcome({
      state: "fresh",
      at: "2026-09-08T14:32:11.000Z",
      findings: 2,
      blockers: 0,
      recorded: [
        { severity: "concern", summary: "Money has no currency", evidence: "src/money.contract.ts:12" },
        { severity: "note", summary: "prorate() rounding is unstated" },
      ],
    });
    expect(r.code).toBe(0);
    expect(r.lines).toEqual([
      "design-review: challenged (2 findings, 0 blockers) — advisory; you decide.",
      "  concern: Money has no currency — src/money.contract.ts:12",
      "  note: prorate() rounding is unstated",
    ]);
  });

  // Blockers do NOT fail the gate: the reviewer records claims, the architect
  // settles them. But an unsettled blocker that nothing prints is a claim
  // nobody ever has to answer, so the passing line carries the count.
  test("a blocker is counted on the passing line, and does not fail the gate", () => {
    const r = reviewStepOutcome({
      state: "fresh",
      at: "2026-09-08T14:32:11.000Z",
      findings: 3,
      blockers: 1,
      recorded: [],
    });
    expect(r.code).toBe(0);
    expect(r.lines[0]).toContain("3 findings, 1 blocker");
    expect(r.lines.join("\n")).toMatch(/advisory/);
    // A blocker stands, so the freezable-now nudge must NOT appear.
    expect(r.lines).not.toContain(FREEZABLE_NOW);
  });

  // The passing line is advisory whatever the findings say: the whole point of
  // the reframe (ADR 2026-020) is that the architect decides, so the step never
  // suppress-freezes and never prints a freezability verdict of its own.
  test("the passing line reads advisory, and carries no freezability verdict", () => {
    const withFindings = reviewStepOutcome({
      state: "fresh",
      at: "2026-09-08T14:32:11.000Z",
      findings: 2,
      blockers: 0,
      recorded: [
        { severity: "concern", summary: "Money has no currency" },
        { severity: "note", summary: "prorate() rounding is unstated" },
      ],
    });
    expect(withFindings.code).toBe(0);
    expect(withFindings.lines[0]).toBe(
      "design-review: challenged (2 findings, 0 blockers) — advisory; you decide.",
    );
    expect(withFindings.lines).not.toContain(FREEZABLE_NOW);
  });

  test("never challenged and a moved file set do not read alike", () => {
    const missing = reviewStepOutcome({ state: "missing" });
    expect(missing.code).toBe(1);
    expect(missing.lines[0]).toBe("design-review: BLOCK — this design has not been challenged");
    expect(missing.lines.join("\n")).toContain("`reviewer`");

    const stale = reviewStepOutcome({
      state: "stale",
      at: "2026-09-08T14:32:11.000Z",
      added: ["src/y.contract.ts"],
      removed: [],
    });
    expect(stale.code).toBe(1);
    expect(stale.lines[0]).toContain("the reviewer never saw src/y.contract.ts");
    expect(stale.lines[0]).toContain("changed the design's shape");
    expect(stale.lines).toContain("  added since the review: src/y.contract.ts");
    expect(stale.lines.every((l) => !l.includes("removed since"))).toBe(true);
  });
});

describe("design-gate CLI: the freeze requires a fresh review", () => {
  test("a design nobody has challenged is not frozen", () => {
    const dir = fixtureRepo("design-unreviewed-", CLEAN_CONTRACT);
    const r = runGate(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("design-review: BLOCK — this design has not been challenged");
    expect(r.stdout).toContain("`reviewer`");
    expect(r.stdout).toContain("design-gate: FAIL — design-review missing (or stale); freeze did not run");
    expect(r.stdout).toContain("design-gate: route → architect");
    // The skeleton was generated and the typecheck passed; the manifest was not
    // written, so nothing downstream can build on an unchallenged contract.
    expect(existsSync(join(dir, SKELETON))).toBe(true);
    expect(existsSync(join(dir, MANIFEST))).toBe(false);
  });

  // THE KEY r18 CASE. A content edit to a file the reviewer already saw — the
  // architect polishing the spec in answer to a finding — does NOT re-require a
  // review: freshness is the file SET, not the bytes. One review suffices, and
  // the freeze proceeds.
  test("editing the spec after the review does NOT void it — the freeze proceeds", () => {
    const dir = fixtureRepo("design-spec-edit-", CLEAN_CONTRACT);
    review(dir);
    writeFileSync(join(dir, "spec.md"), `${SPEC}\nRounding is half-up: floor((2n + d) / 2d).\n`);
    const r = runGate(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/design-review: challenged \(0 findings, 0 blockers\) — advisory/);
    expect(existsSync(join(dir, MANIFEST))).toBe(true);
  });

  test("editing a contract after the review does NOT void it — the freeze proceeds", () => {
    const dir = fixtureRepo("design-contract-edit-", CLEAN_CONTRACT);
    review(dir);
    writeFileSync(
      join(dir, ROOT, CONTRACT_PATH),
      CLEAN_CONTRACT.replace("three uppercase letters", "three uppercase letters, as ISO lists them"),
    );
    const r = runGate(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/design-review: challenged/);
    expect(existsSync(join(dir, MANIFEST))).toBe(true);
  });

  test("a contract ADDED after the review voids it — a review covers a file set", () => {
    const dir = fixtureRepo("design-contract-added-", CLEAN_CONTRACT);
    review(dir);
    place(dir, TICKER_PATH, TICKER_CONTRACT);
    const r = runGate(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`the reviewer never saw ${TICKER_REL}`);
    expect(r.stdout).toContain(`  added since the review: ${TICKER_REL}`);
    expect(r.stdout).toContain("design-gate: FAIL — design-review missing (or stale); freeze did not run");
    expect(existsSync(join(dir, MANIFEST))).toBe(false);
  });

  test("a contract REMOVED after the review voids it, and the block names it", () => {
    const dir = fixtureRepo("design-contract-removed-", CLEAN_CONTRACT);
    // Two contracts reviewed together, then one is deleted: the shape the fresh
    // mind read is gone, so the design must be challenged again.
    place(dir, TICKER_PATH, TICKER_CONTRACT);
    review(dir);
    rmSync(join(dir, ROOT, TICKER_PATH));
    const r = runGate(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`  removed since the review: ${TICKER_REL}`);
    expect(existsSync(join(dir, MANIFEST))).toBe(false);
  });

  test("a fresh review lets the freeze run, and the transcript shows it was consulted", () => {
    const dir = fixtureRepo("design-fresh-", CLEAN_CONTRACT);
    expect(review(dir, [{ severity: "note", summary: "Money could carry the amount too" }]).code).toBe(0);
    const r = runGate(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/design-review: challenged \(1 finding, 0 blockers\) — advisory; you decide\./);
    expect(existsSync(join(dir, MANIFEST))).toBe(true);
  });

  test("a blocker does not stop the freeze, but the line carries the count", () => {
    const dir = fixtureRepo("design-blocker-", CLEAN_CONTRACT);
    review(dir, [
      { severity: "blocker", summary: "format returns a Currency, not a rendering", evidence: "money.contract.ts:8" },
      { severity: "concern", summary: "no tie-break stated for the rounding" },
    ]);
    const r = runGate(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/design-review: challenged \(2 findings, 1 blocker\) — advisory; you decide\./);
    expect(r.stdout).toMatch(/advisory/);
    expect(existsSync(join(dir, MANIFEST))).toBe(true);
  });

  test("a misused record_design_review call is not a review", () => {
    const dir = fixtureRepo("design-review-misuse-", CLEAN_CONTRACT);
    expect(review(dir, "nope").code).toBe(2);
    const r = runGate(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("design-review: BLOCK — this design has not been challenged");
  });

  test("a later misuse does not void the review that stands", () => {
    const dir = fixtureRepo("design-review-misuse-after-", CLEAN_CONTRACT);
    review(dir);
    expect(review(dir, [{ severity: "urgent", summary: "x" }]).code).toBe(2);
    expect(runGate(dir).status).toBe(0);
  });

  test("no spec.md at all: the design cannot be reviewed, so it cannot be frozen", () => {
    const dir = fixtureRepo("design-nospec-", CLEAN_CONTRACT);
    rmSync(join(dir, "spec.md"));
    const r = runGate(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/design-review: BLOCK — no spec\.md to review/);
    expect(existsSync(join(dir, MANIFEST))).toBe(false);
  });

  test("the composite event records the review it consulted", () => {
    const dir = fixtureRepo("design-review-log-", CLEAN_CONTRACT);
    review(dir, [{ severity: "blocker", summary: "uncallable operation" }]);
    expect(runGate(dir).status).toBe(0);
    const composite = readGuardLog(dir).find((e) => e.guard === "design-gate")!;
    const detail = composite.detail as {
      steps: { step: string }[];
      review: { state: string; blockers: number };
    };
    expect(detail.steps.map((s) => s.step)).toEqual([...DESIGN_STEPS]);
    expect(detail.review).toMatchObject({ state: "fresh", findings: 1, blockers: 1 });
  });
});


// ---------------------------------------------------------------------------
// The re-freeze fast path (r14): don't pay a full pass to be told to review
// ---------------------------------------------------------------------------
//
// Freshness compares the guard log against the CURRENT bytes of spec.md and the
// contracts, and no other step writes those — so its answer does not depend on
// purity, scaffolding or tsc, and evaluating it first is sound. On a project
// that has already been frozen once, that saves the whole pipeline pass r14 paid
// repeatedly just to be told at step four to commission the reviewer.
//
// A FIRST run keeps today's order: there is no earlier review to be stale
// against, and scaffolding has to happen before anything can typecheck at all.

describe("design-gate CLI: a re-freeze checks the review first", () => {
  const EARLY =
    "design-gate: already frozen, so design-review is checked FIRST — a stale review blocks before anything is re-run";

  /** How many times each guard has spoken so far — the fail-fast evidence. */
  function guardCounts(dir: string): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const e of readGuardLog(dir)) counts[e.guard] = (counts[e.guard] ?? 0) + 1;
    return counts;
  }

  test("a moved file set on a frozen design blocks BEFORE purity, scaffold or typecheck run", () => {
    const dir = fixtureRepo("design-refreeze-stale-", CLEAN_CONTRACT);
    review(dir);
    expect(runGate(dir).status).toBe(0); // the manifest now exists: the next run is a re-freeze
    const before = guardCounts(dir);

    // A NEW contract file — surface the review never saw — is what stales it now.
    place(dir, TICKER_PATH, TICKER_CONTRACT);
    const r = runGate(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(EARLY);
    expect(r.stdout).toContain(`the reviewer never saw ${TICKER_REL}`);
    expect(r.stdout).toContain(`  added since the review: ${TICKER_REL}`);
    expect(r.stdout).toContain(
      "design-gate: FAIL — design-review missing (or stale); contract-purity, scaffold, typecheck, freeze did not run",
    );
    expect(r.stdout).toContain("design-gate: route → architect");

    // FAIL-FAST, proven from the log rather than from the printed text: not one
    // of the three expensive steps logged a single new event.
    const after = guardCounts(dir);
    for (const guard of ["contract-purity", "scaffold", "checksum-gate"]) {
      expect(after[guard] ?? 0, `${guard} must not have run`).toBe(before[guard] ?? 0);
    }
    // ...and nothing they print reached the transcript either.
    expect(r.stdout).not.toMatch(/contract-purity:/);
    expect(r.stdout).not.toMatch(/scaffold:/);
    expect(r.stdout).not.toMatch(/typecheck:/);
    expect(after["design-gate"]).toBe((before["design-gate"] ?? 0) + 1);
  });

  test("the fast-path block is recorded as a re-freeze that checked the review first", () => {
    const dir = fixtureRepo("design-refreeze-log-", CLEAN_CONTRACT);
    review(dir);
    expect(runGate(dir).status).toBe(0);
    place(dir, TICKER_PATH, TICKER_CONTRACT);
    expect(runGate(dir).status).toBe(1);

    const composite = readGuardLog(dir).filter((e) => e.guard === "design-gate");
    expect(composite).toHaveLength(2);
    const detail = composite[1].detail as {
      steps: { step: string }[];
      reFreeze: boolean;
      checkedFirst: string;
      failed: string;
      review: { state: string };
    };
    expect(detail.steps.map((s) => s.step)).toEqual(["design-review"]);
    expect(detail).toMatchObject({
      reFreeze: true,
      checkedFirst: "design-review",
      failed: "design-review",
      review: { state: "stale" },
    });
  });

  // Nothing may be frozen on the fast path either: a block is a block. A new
  // contract file is what triggers it now — a content edit would proceed.
  test("the fast path leaves the previous manifest exactly as it was", () => {
    const dir = fixtureRepo("design-refreeze-manifest-", CLEAN_CONTRACT);
    review(dir);
    expect(runGate(dir).status).toBe(0);
    const frozen = readFileSync(join(dir, MANIFEST), "utf8");
    place(dir, TICKER_PATH, TICKER_CONTRACT);
    expect(runGate(dir).status).toBe(1);
    expect(readFileSync(join(dir, MANIFEST), "utf8")).toBe(frozen);
  });

  // The r18 polish scenario on a re-freeze: a content edit to a reviewed file
  // keeps the review fresh, so the freeze proceeds with no re-review — the
  // pre-flight is silent and the full sequence runs.
  test("a content edit on a re-freeze proceeds silently, no re-review needed", () => {
    const dir = fixtureRepo("design-refreeze-content-", CLEAN_CONTRACT);
    review(dir);
    expect(runGate(dir).status).toBe(0);
    writeFileSync(
      join(dir, ROOT, CONTRACT_PATH),
      CLEAN_CONTRACT.replace("three uppercase letters", "three uppercase letters, as ISO lists them"),
    );
    const r = runGate(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain(EARLY);
    expect(r.stdout).toMatch(/design-review: challenged/);
    expect(r.stdout).toMatch(/design-gate: OK/);
  });

  // The PASSING narrative is the half read twice, so it keeps the canonical
  // order: the pre-flight is silent and design-review reports in its own slot,
  // between typecheck and freeze.
  test("a fresh review on a re-freeze reads in the canonical order, and says nothing early", () => {
    const dir = fixtureRepo("design-refreeze-fresh-", CLEAN_CONTRACT);
    review(dir);
    expect(runGate(dir).status).toBe(0);
    const r = runGate(dir); // re-freeze, review still fresh
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain(EARLY);
    const order = r.stdout
      .split("\n")
      .filter((l) => /^(contract-purity|scaffold|typecheck|design-review|freeze): (PASS|BLOCK|ERROR)/.test(l))
      .map((l) => l.split(":")[0]);
    expect(order).toEqual([...DESIGN_STEPS]);
    expect(r.stdout).toMatch(/design-gate: OK — contract-purity → scaffold → typecheck → design-review → freeze/);
    const composite = readGuardLog(dir).filter((e) => e.guard === "design-gate");
    expect((composite[1].detail as { reFreeze: boolean }).reFreeze).toBe(true);
  });

  // A FIRST run has nothing to be stale against, and scaffolding must happen
  // before anything can typecheck. So it keeps today's order: the skeleton is
  // generated, the typecheck runs, and only then is the missing review named.
  test("a FIRST run keeps today's order: it scaffolds and typechecks before naming the review", () => {
    const dir = fixtureRepo("design-firstrun-", CLEAN_CONTRACT);
    const r = runGate(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain(EARLY);
    expect(r.stdout).toMatch(/contract-purity: PASS/);
    expect(r.stdout).toMatch(/scaffold: PASS/);
    expect(r.stdout).toMatch(/typecheck: PASS/);
    expect(r.stdout).toContain("design-review: BLOCK — this design has not been challenged");
    expect(r.stdout).toContain("design-gate: FAIL — design-review missing (or stale); freeze did not run");
    expect(existsSync(join(dir, SKELETON))).toBe(true);
    expect(existsSync(join(dir, MANIFEST))).toBe(false);
    expect((readGuardLog(dir).find((e) => e.guard === "design-gate")!.detail as { reFreeze: boolean }).reFreeze)
      .toBe(false);
  });
});
