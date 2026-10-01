import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  isMutableSourceFile,
  mutantSites,
  parseCliArgs,
  runMutationScore,
  selectMutants,
  type MutantSite,
  type SuiteRunner,
} from "./mutation-score.ts";
import { readGuardLog } from "../../../src/guard-log.ts";

const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

// --- fixtures -------------------------------------------------------------------

/** A parse function with one of every operator's site: two guards (each an
 *  `if` with a `return undefined` and something after it), a comparison in
 *  each, and one `||`. */
const MONEY_TS = `export function parseAmount(raw: unknown): number | undefined {
  if (typeof raw !== "number") {
    return undefined;
  }
  if (raw < 0 || raw > 100) return undefined;
  return Math.round(raw);
}
`;

const TIER_TS = `export function tierFor(score: number): string {
  if (score >= 90) return "gold";
  if (score >= 50) return "silver";
  return "bronze";
}
`;

const CONTRACT_TS = `export declare function parseAmount(raw: unknown): number | undefined;
export declare const MAX: number;
`;

const INDEX_TS = `// Public API of this package — one line per module. Generated at delivery.
export * from "./money.js";
export * from "./tier.js";
`;

const SKELETON_TS = `import { NotImplementedError } from "./domain/shared/errors.ts";

export function later(n: number): boolean {
  if (n > 0) throw new NotImplementedError("later");
  throw new NotImplementedError("later");
}
`;

/** A test of the money logic, and a generated file: neither is the builder's. */
const TEST_TS = `export function check(n: number): boolean { return n > 0 && n < 10; }\n`;
const GENERATED_TS = `export function isValid(n: number): boolean { return n > 0 || n < -10; }\n`;

/** The composition the fixtures declare: the hexagonal layout's roots,
 *  test suffixes and generated globs. */
const COMPOSITION = JSON.stringify(["ts", "ts-hexagonal"]);
const LAYOUT = { testSuffixes: [".test.ts", ".test-support.ts"], isGenerated: (p: string) => p.endsWith(".command.ts") };

const PACKAGE_JSON = `{
  "name": "fixture",
  "private": true,
  "type": "module",
  "scripts": { "test": "bun test" }
}
`;

/** The files a mutant may touch, so a test can prove they came back intact. */
const MUTABLE = ["contexts/pm/src/money.ts", "contexts/pm/src/tier.ts"] as const;

/** Total sites across the fixture: money 8 + tier 4 (everything else excluded). */
const FIXTURE_SITES = 12;

function proj(extra: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-mutation-"));
  tmpDirs.push(dir);
  const files: Record<string, string> = {
    "package.json": PACKAGE_JSON,
    "contexts/pm/src/money.ts": MONEY_TS,
    "contexts/pm/src/tier.ts": TIER_TS,
    "contexts/pm/src/money.contract.ts": CONTRACT_TS,
    "contexts/pm/src/index.ts": INDEX_TS,
    "contexts/pm/src/later.ts": SKELETON_TS,
    "contexts/pm/src/money.test.ts": TEST_TS,
    "contexts/pm/src/application/x/do-x/do-x.command.ts": GENERATED_TS,
    ".bounded/composed-packs.json": COMPOSITION,
    ...extra,
  };
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

/** Which of the mutable files currently differ from what was written. */
function dirtyFiles(dir: string): string[] {
  const pristine: Record<string, string> = { "contexts/pm/src/money.ts": MONEY_TS, "contexts/pm/src/tier.ts": TIER_TS };
  return MUTABLE.filter((rel) => readFileSync(join(dir, rel), "utf8") !== pristine[rel]);
}

interface RunnerLog {
  /** Per call (call 0 is the baseline), the mutable files that were modified. */
  readonly dirtyPerCall: string[][];
}

/**
 * Suite runner driven by call index, so a test says exactly which mutant
 * survives without reasoning about mutated source text. Call 0 is the
 * baseline run; calls 1..n are the mutants, in selection order.
 */
function indexedRunner(
  options: {
    survive?: ReadonlySet<number>;
    timeout?: ReadonlySet<number>;
    throwAt?: number;
    baselineOk?: boolean;
  } = {},
  log?: RunnerLog,
): SuiteRunner {
  let call = 0;
  return (dir: string) => {
    const n = call++;
    log?.dirtyPerCall.push(dirtyFiles(dir));
    if (n === 0) {
      return Promise.resolve(
        options.baselineOk === false ? { ok: false, note: "2 failed" } : { ok: true, note: "green" },
      );
    }
    if (options.throwAt === n) return Promise.reject(new Error("runner exploded"));
    if (options.timeout?.has(n) === true) {
      return Promise.resolve({ ok: false, timedOut: true, note: "timeout after 1ms" });
    }
    return Promise.resolve(
      options.survive?.has(n) === true ? { ok: true, note: "green" } : { ok: false, note: "1 failed" },
    );
  };
}

const labels = (sites: readonly MutantSite[]): string[] =>
  sites.map((s) => `${s.file}:${s.line} ${s.label}`);

const apply = (source: string, site: MutantSite): string =>
  source.slice(0, site.start) + site.replacement + source.slice(site.end);

// --- mutant enumeration ---------------------------------------------------------

describe("mutantSites", () => {
  test("finds exactly the documented operator set, in source order", () => {
    expect(mutantSites(MONEY_TS, "contexts/pm/src/money.ts").map((s) => `${s.line} [${s.operator}] ${s.label}`)).toEqual([
      "2 [if-negation] if (c) → if (!(c))",
      "2 [comparison] !== → ===",
      "3 [guard-fall-through] drop `return undefined` guard",
      "5 [if-negation] if (c) → if (!(c))",
      "5 [comparison] < → <=",
      "5 [logical] || → &&",
      "5 [comparison] > → >=",
      "5 [guard-fall-through] drop `return undefined` guard",
    ]);
  });

  test("flips both directions of every comparison pair", () => {
    const source = `export function f(a: number, b: number) {
  const x = a <= b;
  const y = a >= b;
  const z = a === b;
  return [x, y, z];
}
`;
    expect(mutantSites(source, "contexts/pm/src/f.ts").filter((s) => s.operator === "comparison").map((s) => s.label)).toEqual([
      "<= → <",
      ">= → >",
      "=== → !==",
    ]);
  });

  test("swaps && as well as ||, and leaves ?? alone", () => {
    const source = `export const f = (a: boolean, b: boolean, c: string | null) => (a && b) || (c ?? "x") !== "";\n`;
    expect(mutantSites(source, "contexts/pm/src/f.ts").filter((s) => s.operator === "logical").map((s) => s.label)).toEqual([
      "&& → ||",
      "|| → &&",
    ]);
  });

  test("the if-negation mutant wraps the whole condition", () => {
    const site = mutantSites(MONEY_TS, "contexts/pm/src/money.ts")[0]!;
    expect(apply(MONEY_TS, site)).toContain(`if (!(typeof raw !== "number")) {`);
  });

  test("the guard fall-through mutant leaves syntactically valid fall-through", () => {
    const site = mutantSites(MONEY_TS, "contexts/pm/src/money.ts").find((s) => s.operator === "guard-fall-through")!;
    expect(apply(MONEY_TS, site)).toContain(`if (typeof raw !== "number") {\n    ;\n  }`);
  });

  test("no guard site when the return is the function's last statement (an equivalent mutant)", () => {
    const source = `export function parseX(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
}
`;
    expect(mutantSites(source, "contexts/pm/src/x.ts").filter((s) => s.operator === "guard-fall-through")).toEqual([]);
  });

  test("no guard site outside a parse-shaped function", () => {
    const source = `export function lookup(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  return raw;
}
`;
    expect(mutantSites(source, "contexts/pm/src/x.ts").filter((s) => s.operator === "guard-fall-through")).toEqual([]);
  });

  test("a failed Result is a rejection guard too (ADR 2026-059)", () => {
    const source = `export function parseName(raw: unknown): Result<string> {
  if (typeof raw !== "string") return { ok: false, error: "not a string" };
  return { ok: true, value: raw };
}
`;
    const guards = mutantSites(source, "contexts/pm/src/name.ts").filter((s) => s.operator === "guard-fall-through");
    expect(guards.map((s) => s.label)).toEqual(["drop `return { ok: false }` guard"]);
    // The last statement's success return is not a site: dropping it changes nothing observable.
    expect(apply(source, guards[0]!)).toContain('if (typeof raw !== "string") ;');
  });

  test("a static parse method counts as parse-shaped", () => {
    const source = `export class Money {
  static parse(raw: unknown): Money | undefined {
    if (typeof raw !== "number") return undefined;
    return new Money();
  }
}
`;
    expect(mutantSites(source, "contexts/pm/src/money.ts").filter((s) => s.operator === "guard-fall-through")).toHaveLength(1);
  });
});

// --- exclusions -----------------------------------------------------------------

describe("isMutableSourceFile", () => {
  test("excludes contracts, barrels, declaration files and skeleton leftovers", () => {
    expect(isMutableSourceFile("contexts/pm/src/money.contract.ts", CONTRACT_TS, LAYOUT)).toBe(false);
    expect(isMutableSourceFile("contexts/pm/src/index.ts", INDEX_TS, LAYOUT)).toBe(false);
    expect(isMutableSourceFile("contexts/pm/src/nested/index.ts", INDEX_TS, LAYOUT)).toBe(false);
    expect(isMutableSourceFile("contexts/pm/src/types.d.ts", "export {};\n", LAYOUT)).toBe(false);
    expect(isMutableSourceFile("contexts/pm/src/later.ts", SKELETON_TS, LAYOUT)).toBe(false);
  });

  test("excludes test-side files and generated files: neither is the builder's logic", () => {
    expect(isMutableSourceFile("contexts/pm/src/money.test.ts", TEST_TS, LAYOUT)).toBe(false);
    expect(isMutableSourceFile("contexts/pm/src/money.store.test-support.ts", TEST_TS, LAYOUT)).toBe(false);
    expect(isMutableSourceFile("contexts/pm/src/application/x/do-x/do-x.command.ts", GENERATED_TS, LAYOUT)).toBe(false);
  });

  test("includes an implemented file that merely imports the errors module's neighbourhood", () => {
    const implemented = 'import type { Result } from "./domain/shared/result.ts";\n' + MONEY_TS;
    expect(isMutableSourceFile("contexts/pm/src/money.ts", implemented, LAYOUT)).toBe(true);
    expect(isMutableSourceFile("contexts/pm/src/money.ts", MONEY_TS, LAYOUT)).toBe(true);
  });
});

// --- selection ------------------------------------------------------------------

describe("selectMutants", () => {
  const all = [...mutantSites(MONEY_TS, "contexts/pm/src/money.ts"), ...mutantSites(TIER_TS, "contexts/pm/src/tier.ts")];

  test("deals round-robin across files so one file cannot eat the budget", () => {
    expect(labels(selectMutants(all, 4))).toEqual([
      "contexts/pm/src/money.ts:2 if (c) → if (!(c))",
      "contexts/pm/src/tier.ts:2 if (c) → if (!(c))",
      "contexts/pm/src/money.ts:2 !== → ===",
      "contexts/pm/src/tier.ts:2 >= → >",
    ]);
  });

  test("is deterministic and a prefix-stable function of the cap", () => {
    expect(labels(selectMutants(all, 6))).toEqual(labels(selectMutants(all, 6)));
    expect(labels(selectMutants(all, 6)).slice(0, 4)).toEqual(labels(selectMutants(all, 4)));
  });

  test("drains the longer file once the shorter one runs out, and honours the cap", () => {
    expect(selectMutants(all, 99)).toHaveLength(all.length);
    expect(selectMutants(all, 0)).toEqual([]);
    expect(labels(selectMutants(all, 10)).slice(8)).toEqual([
      "contexts/pm/src/money.ts:5 < → <=",
      "contexts/pm/src/money.ts:5 || → &&",
    ]);
  });
});

// --- the apply → run → restore loop ---------------------------------------------

describe("runMutationScore", () => {
  test("scores kills and survivors, and reports each survivor as a finding", async () => {
    const dir = proj();
    const result = await runMutationScore(dir, {
      maxMutants: 4,
      runSuite: indexedRunner({ survive: new Set([2]) }),
    });

    expect(result.code).toBe(0);
    expect(result.sites).toBe(FIXTURE_SITES);
    expect(result.outcomes).toHaveLength(4);
    expect(result.killed).toBe(3);
    expect(result.survived).toBe(1);
    expect(result.score).toBe(75);
    expect(result.lines).toEqual([
      "KILLED   contexts/pm/src/money.ts:2 if (c) → if (!(c))",
      "SURVIVED contexts/pm/src/tier.ts:2 if (c) → if (!(c))",
      "KILLED   contexts/pm/src/money.ts:2 !== → ===",
      "KILLED   contexts/pm/src/tier.ts:2 >= → >",
      "",
      "mutation-score: 4 mutants of 12 sites · 3 killed · 1 survived · score 75%",
      "mutation-score: survivors — each one is a finding: shipped parse/guard logic changed, suite still green.",
      "mutation-score:   contexts/pm/src/tier.ts:2 if (c) → if (!(c))",
      "mutation-score: measurement only — no threshold is enforced (TN-26-002).",
    ]);
  });

  test("mutates exactly one file per run and restores it byte-for-byte", async () => {
    const dir = proj();
    const before = MUTABLE.map((rel) => readFileSync(join(dir, rel)));
    const log: RunnerLog = { dirtyPerCall: [] };

    await runMutationScore(dir, { maxMutants: 6, runSuite: indexedRunner({}, log) });

    expect(log.dirtyPerCall[0]).toEqual([]); // baseline: pristine tree
    expect(log.dirtyPerCall.slice(1).map((d) => d.length)).toEqual([1, 1, 1, 1, 1, 1]);
    MUTABLE.forEach((rel, i) => expect(readFileSync(join(dir, rel)).equals(before[i]!)).toBe(true));
  });

  test("restores the file even when the suite runner throws, and does not swallow the throw", async () => {
    const dir = proj();
    const before = MUTABLE.map((rel) => readFileSync(join(dir, rel)));

    await expect(
      runMutationScore(dir, { maxMutants: 4, runSuite: indexedRunner({ throwAt: 2 }) }),
    ).rejects.toThrow("runner exploded");

    MUTABLE.forEach((rel, i) => expect(readFileSync(join(dir, rel)).equals(before[i]!)).toBe(true));
    expect(dirtyFiles(dir)).toEqual([]);
  });

  test("a timed-out suite counts as killed and says so on its line", async () => {
    const dir = proj();
    const result = await runMutationScore(dir, {
      maxMutants: 2,
      runSuite: indexedRunner({ timeout: new Set([1]) }),
    });

    expect(result.timedOut).toBe(1);
    expect(result.killed).toBe(2);
    expect(result.survived).toBe(0);
    expect(result.lines[0]).toBe("TIMEOUT  contexts/pm/src/money.ts:2 if (c) → if (!(c)) (counted as killed)");
    expect(result.lines).toContain("mutation-score: 2 mutants of 12 sites · 2 killed (1 by timeout) · 0 survived · score 100%");
  });

  test("two runs over the same tree pick the same mutants", async () => {
    const dir = proj();
    const once = await runMutationScore(dir, { maxMutants: 5, runSuite: indexedRunner() });
    const twice = await runMutationScore(dir, { maxMutants: 5, runSuite: indexedRunner() });
    expect(labels(twice.outcomes.map((o) => o.site))).toEqual(labels(once.outcomes.map((o) => o.site)));
  });

  test("logs one mutation-score guard event carrying the summary and the survivors", async () => {
    const dir = proj();
    await runMutationScore(dir, { maxMutants: 4, runSuite: indexedRunner({ survive: new Set([2]) }) });

    const events = readGuardLog(dir).filter((e) => e.guard === "mutation-score");
    expect(events).toHaveLength(1);
    expect(events[0]!.verdict).toBe("pass");
    expect(events[0]!.summary).toBe("4 mutants of 12 sites · 3 killed · 1 survived · score 75%");
    expect(events[0]!.detail).toMatchObject({
      sites: FIXTURE_SITES,
      mutants: 4,
      killed: 3,
      survived: 1,
      score: 75,
      files: ["contexts/pm/src/money.ts", "contexts/pm/src/tier.ts"],
      survivors: [{ file: "contexts/pm/src/tier.ts", line: 2, operator: "if-negation" }],
    });
  });

  test("a project with no mutable parse/guard logic is a clean 0, not an error", async () => {
    const dir = proj({ "contexts/pm/src/money.ts": "export const NAME = \"x\";\n", "contexts/pm/src/tier.ts": "export const N = 1;\n" });
    const result = await runMutationScore(dir, { runSuite: indexedRunner() });

    expect(result.code).toBe(0);
    expect(result.sites).toBe(0);
    expect(result.score).toBeUndefined();
    expect(result.lines).toEqual(["mutation-score: no mutable parse/guard sites under the source roots — nothing to measure"]);
  });

  test("refuses to score against a suite that is not already green", async () => {
    const dir = proj();
    const result = await runMutationScore(dir, {
      maxMutants: 2,
      runSuite: indexedRunner({ baselineOk: false }),
    });

    expect(result.code).toBe(2);
    expect(result.lines.at(-1)).toContain("the suite is not green before mutation (2 failed)");
    expect(dirtyFiles(dir)).toEqual([]);
    expect(readGuardLog(dir).at(-1)?.verdict).toBe("error");
  });

  test("misuse: a target that is not a project", async () => {
    const missing = join(tmpdir(), "pi-mutation-does-not-exist-" + String(Date.now()));
    expect((await runMutationScore(missing, { runSuite: indexedRunner() })).code).toBe(2);

    const noPkg = mkdtempSync(join(tmpdir(), "pi-mutation-bare-"));
    tmpDirs.push(noPkg);
    const bare = await runMutationScore(noPkg, { runSuite: indexedRunner() });
    expect(bare.code).toBe(2);
    expect(bare.lines.at(-1)).toContain("not a project root");

    const noSrc = mkdtempSync(join(tmpdir(), "pi-mutation-nosrc-"));
    tmpDirs.push(noSrc);
    writeFileSync(join(noSrc, "package.json"), PACKAGE_JSON);
    mkdirSync(join(noSrc, ".bounded"));
    writeFileSync(join(noSrc, ".bounded/composed-packs.json"), COMPOSITION);
    const srcless = await runMutationScore(noSrc, { runSuite: indexedRunner() });
    expect(srcless.code).toBe(2);
    expect(srcless.lines.at(-1)).toContain("nothing to mutate");

    // An unreadable composition is misuse too: the gate must not guess where source lives.
    const uncomposed = mkdtempSync(join(tmpdir(), "pi-mutation-uncomposed-"));
    tmpDirs.push(uncomposed);
    writeFileSync(join(uncomposed, "package.json"), PACKAGE_JSON);
    const unread = await runMutationScore(uncomposed, { runSuite: indexedRunner() });
    expect(unread.code).toBe(2);
    expect(unread.lines.at(-1)).toContain("composition");
  });
});

// --- CLI ------------------------------------------------------------------------

describe("parseCliArgs", () => {
  test("takes the target directory and both numeric flags, in either syntax", () => {
    expect(parseCliArgs([])).toEqual({});
    expect(parseCliArgs(["/tmp/p"])).toEqual({ targetDir: "/tmp/p" });
    expect(parseCliArgs(["--max-mutants", "10", "/tmp/p", "--timeout-ms=500"])).toEqual({
      targetDir: "/tmp/p",
      maxMutants: 10,
      timeoutMs: 500,
    });
  });

  test("rejects unknown options, non-positive numbers and a second target", () => {
    expect(parseCliArgs(["--nope"]).error).toContain("unknown option '--nope'");
    expect(parseCliArgs(["--max-mutants", "0"]).error).toContain("positive integer");
    expect(parseCliArgs(["--max-mutants", "abc"]).error).toContain("positive integer");
    expect(parseCliArgs(["--timeout-ms"]).error).toContain("positive integer");
    expect(parseCliArgs(["/a", "/b"]).error).toContain("unexpected argument '/b'");
  });
});

// --- the one test that spawns real bun ----------------------------------------
//
// Everything above injects a suite runner, because 40 mutants means 40 suite
// runs. This one proves the OTHER half is real: that `bunSuiteRunner` —
// run-tests' `runTests` composed with its `spawnRunner` under an AbortSignal —
// drives `bun test` in a monorepo and reports green/red. Three mutants, four
// suite runs. `bun:test` is built in, so nothing is installed.

const HAS_BUN = spawnSync("bun", ["--version"]).status === 0;
if (!HAS_BUN) console.warn("mutation-score.test.ts: skipping the real-bun run — `bun` is not on PATH");

const E2E_SRC = `import type { Result } from "../shared/result.ts";

export function parseAmount(raw: unknown): Result<number> {
  if (typeof raw !== "number") {
    return { ok: false, error: "not a number" };
  }
  if (raw < 0) return { ok: false, error: "negative" };
  return { ok: true, value: Math.round(raw) };
}
`;

const E2E_TEST = `import { expect, test } from "bun:test";
import { parseAmount } from "./money.ts";

test("accepts a number", () => expect(parseAmount(5)).toEqual({ ok: true, value: 5 }));
test("rejects a string", () => expect(parseAmount("x").ok).toBe(false));
test("rejects negatives", () => expect(parseAmount(-1).ok).toBe(false));
`;

describe.skipIf(!HAS_BUN)("runMutationScore, end to end", () => {
  test("drives real bun test through the run-tests seam, over the source roots only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-mutation-e2e-"));
    tmpDirs.push(dir);
    for (const [rel, content] of Object.entries({
      "package.json": PACKAGE_JSON,
      ".bounded/composed-packs.json": COMPOSITION,
      "contexts/pm/src/domain/shared/result.ts": "export type Result<T> = { ok: true; value: T } | { ok: false; error: string };\n",
      "contexts/pm/src/domain/money/money.ts": E2E_SRC,
      "contexts/pm/src/domain/money/money.test.ts": E2E_TEST,
      // Outside every source root: never mutated.
      "scripts/tool.ts": "export const t = (n: number) => n > 1;\n",
    })) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }

    const result = await runMutationScore(dir, { maxMutants: 3 });

    expect(result.code, result.lines.join("\n")).toBe(0);
    expect(result.outcomes.map((o) => o.site.file)).toEqual(Array(3).fill("contexts/pm/src/domain/money/money.ts"));
    expect(result.outcomes.map((o) => o.verdict)).toEqual(["killed", "killed", "killed"]);
    expect(result.score).toBe(100);
    expect(readFileSync(join(dir, "contexts/pm/src/domain/money/money.ts"), "utf8")).toBe(E2E_SRC);
  }, 120_000);
});
