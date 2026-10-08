import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  test("a failed Result is a rejection guard too (ADR LEG-2026-059)", () => {
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
  /** `files` files of `perFile` sites each, in (file, offset) order. */
  const synthetic = (counts: readonly number[]): MutantSite[] =>
    counts.flatMap((count, f) => Array.from({ length: count }, (_, i) => ({
      file: `contexts/pm/src/f${String(f).padStart(2, "0")}.ts`,
      line: i + 1,
      start: i * 10,
      end: i * 10 + 1,
      replacement: "<=",
      operator: "comparison" as const,
      label: "< → <=",
    })));

  test("selection is spread over the whole tree, not the first files in path order", () => {
    const sites = synthetic(Array(10).fill(4));
    const picked = selectMutants(sites, 5);
    expect(picked).toHaveLength(5);
    const lastFive = new Set(sites.slice(20).map((s) => s.file));
    expect(picked.some((s) => lastFive.has(s.file))).toBe(true);
  });

  test("selection is proportional to where the sites are", () => {
    const sites = synthetic([30, 10]);
    const picked = selectMutants(sites, 8);
    expect(picked.filter((s) => s.file.endsWith("f00.ts"))).toHaveLength(6);
    expect(picked.filter((s) => s.file.endsWith("f01.ts"))).toHaveLength(2);
    const order = picked.map((s) => sites.indexOf(s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(selectMutants(sites, 8)).toEqual(picked);
  });

  test("takes every site when the sample is not smaller than the tree, and none for an empty sample", () => {
    const all = [...mutantSites(MONEY_TS, "contexts/pm/src/money.ts"), ...mutantSites(TIER_TS, "contexts/pm/src/tier.ts")];
    expect(selectMutants(all, 99)).toEqual(all);
    expect(selectMutants(all, all.length)).toEqual(all);
    expect(selectMutants(all, 0)).toEqual([]);
  });
});

// --- the apply → run → restore loop ---------------------------------------------

describe("runMutationScore", () => {
  test("scores kills and survivors, and reports each survivor as a finding", async () => {
    const dir = proj();
    const result = await runMutationScore(dir, {
      minimumSample: 1,
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
      "SURVIVED contexts/pm/src/money.ts:5 if (c) → if (!(c))",
      "KILLED   contexts/pm/src/money.ts:5 > → >=",
      "KILLED   contexts/pm/src/tier.ts:2 >= → >",
      "",
      "mutation-score: 4 mutants (sample) of 12 sites · 3 killed · 1 survived · score 75%",
      "mutation-score: survivors — each one is a finding: shipped parse/guard logic changed, suite still green.",
      "mutation-score:   contexts/pm/src/money.ts:5 if (c) → if (!(c))",
      "mutation-score: measurement only — no threshold is enforced (TN-26-002).",
    ]);
  });

  test("mutates exactly one file per run and restores it byte-for-byte", async () => {
    const dir = proj();
    const before = MUTABLE.map((rel) => readFileSync(join(dir, rel)));
    const log: RunnerLog = { dirtyPerCall: [] };

    await runMutationScore(dir, { minimumSample: 1, maxMutants: 6, runSuite: indexedRunner({}, log) });

    expect(log.dirtyPerCall[0]).toEqual([]); // baseline: pristine tree
    expect(log.dirtyPerCall.slice(1).map((d) => d.length)).toEqual([1, 1, 1, 1, 1, 1]);
    MUTABLE.forEach((rel, i) => expect(readFileSync(join(dir, rel)).equals(before[i]!)).toBe(true));
  });

  test("restores the file even when the suite runner throws, and does not swallow the throw", async () => {
    const dir = proj();
    const before = MUTABLE.map((rel) => readFileSync(join(dir, rel)));

    await expect(
      runMutationScore(dir, { minimumSample: 1, maxMutants: 4, runSuite: indexedRunner({ throwAt: 2 }) }),
    ).rejects.toThrow("runner exploded");

    MUTABLE.forEach((rel, i) => expect(readFileSync(join(dir, rel)).equals(before[i]!)).toBe(true));
    expect(dirtyFiles(dir)).toEqual([]);
  });

  test("a timed-out suite counts as killed and says so on its line", async () => {
    const dir = proj();
    const result = await runMutationScore(dir, {
      minimumSample: 1,
      maxMutants: 2,
      runSuite: indexedRunner({ timeout: new Set([1]) }),
    });

    expect(result.timedOut).toBe(1);
    expect(result.killed).toBe(2);
    expect(result.survived).toBe(0);
    expect(result.lines[0]).toBe("TIMEOUT  contexts/pm/src/money.ts:2 if (c) → if (!(c)) (counted as killed)");
    expect(result.lines).toContain("mutation-score: 2 mutants (sample) of 12 sites · 2 killed (1 by timeout) · 0 survived · score 100%");
  });

  test("two runs over the same tree pick the same mutants", async () => {
    const dir = proj();
    const once = await runMutationScore(dir, { minimumSample: 1, maxMutants: 5, runSuite: indexedRunner() });
    const twice = await runMutationScore(dir, { minimumSample: 1, maxMutants: 5, runSuite: indexedRunner() });
    expect(labels(twice.outcomes.map((o) => o.site))).toEqual(labels(once.outcomes.map((o) => o.site)));
  });

  test("a sample below the minimum is refused before anything runs", async () => {
    const dir = proj();
    let ran = false;
    const result = await runMutationScore(dir, {
      maxMutants: 4,
      runSuite: async () => { ran = true; return { ok: true, note: "green" }; },
    });

    expect(result.code).toBe(2);
    // Fewer sites than the minimum of 40: the minimum is every site, 12.
    expect(result.lines.some((l) => /minimum sample of 12\b/.test(l)), result.lines.join("\n")).toBe(true);
    expect(ran).toBe(false);
    expect(dirtyFiles(dir)).toEqual([]);
    expect(readGuardLog(dir).filter((e) => e.guard === "mutation-score").at(-1)?.verdict).toBe("error");
  });

  test("without --max-mutants the sample is the minimum", async () => {
    const dir = proj();
    const result = await runMutationScore(dir, { minimumSample: 6, runSuite: indexedRunner() });

    expect(result.code).toBe(0);
    expect(result.outcomes).toHaveLength(6);
  });

  test("the result and the guard event put the sample size and site count beside the score", async () => {
    const dir = proj();
    const result = await runMutationScore(dir, { minimumSample: 4, maxMutants: 4, runSuite: indexedRunner() });

    expect(result.summary).toContain("score");
    expect(result.summary).toContain("4");
    expect(result.summary).toContain("of 12 sites");
    const events = readGuardLog(dir).filter((e) => e.guard === "mutation-score");
    expect(events.at(-1)?.detail).toMatchObject({ sample: 4, sites: FIXTURE_SITES, complete: true });
  });

  test("logs one mutation-score guard event carrying the summary and the survivors", async () => {
    const dir = proj();
    await runMutationScore(dir, { minimumSample: 1, maxMutants: 4, runSuite: indexedRunner({ survive: new Set([2]) }) });

    const events = readGuardLog(dir).filter((e) => e.guard === "mutation-score");
    expect(events).toHaveLength(1);
    expect(events[0]!.verdict).toBe("pass");
    expect(events[0]!.summary).toBe("4 mutants (sample) of 12 sites · 3 killed · 1 survived · score 75%");
    expect(events[0]!.detail).toMatchObject({
      sites: FIXTURE_SITES,
      mutants: 4,
      killed: 3,
      survived: 1,
      score: 75,
      files: ["contexts/pm/src/money.ts", "contexts/pm/src/tier.ts"],
      survivors: [{ file: "contexts/pm/src/money.ts", line: 5, operator: "if-negation" }],
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
      minimumSample: 1,
      maxMutants: 2,
      runSuite: indexedRunner({ baselineOk: false }),
    });

    expect(result.code).toBe(2);
    expect(result.lines.at(-1)).toContain("the suite is not green before mutation (2 failed)");
    expect(dirtyFiles(dir)).toEqual([]);
    expect(readGuardLog(dir).at(-1)?.verdict).toBe("error");
  });

  test("the baseline and every mutant run inside ONE prepared service, never the inherited database", async () => {
    const dir = proj();
    const events: string[] = [];
    const urls = new Set<string | undefined>();
    const result = await runMutationScore(dir, {
      minimumSample: 1,
      maxMutants: 3,
      policy: {
        refusals: [],
        env: { set: {}, unset: ["DATABASE_URL"] },
        prepares: [{ name: "db", prepare: async () => {
          events.push("start");
          return { description: "started a throwaway database", env: { DATABASE_URL: "postgres://throwaway" }, release: () => void events.push("release") };
        } }],
      },
      runSuite: async (_cwd, _timeout, env) => {
        events.push("run");
        urls.add(env.set["DATABASE_URL"]);
        expect(env.unset).not.toContain("DATABASE_URL");
        return { ok: events.filter((e) => e === "run").length === 1, note: "x" };
      },
    });
    expect(result.code).toBe(0);
    expect(events).toEqual(["start", "run", "run", "run", "run", "release"]);
    expect([...urls]).toEqual(["postgres://throwaway"]);
    expect(result.lines[0]).toBe("mutation-score: started a throwaway database");
  });

  test("a run every failure of which is the machine's judges no mutant: it blocks, names the cause, and restores the tree", async () => {
    const dir = proj();
    let runs = 0;
    let classifierPassed = false;
    const infrastructure = () => ({ causes: ["x > (unnamed): the registry could not be reached"], all: true });
    const result = await runMutationScore(dir, {
      minimumSample: 1,
      maxMutants: 3,
      policy: { refusals: [], env: { set: {}, unset: [] }, prepares: [], infrastructure },
      runSuite: async (_cwd, _timeout, _env, classify) => {
        classifierPassed = classify === infrastructure;
        runs++;
        return runs === 1 ? { ok: true, note: "green" } : { ok: false, note: "the machine's failure", infrastructure: ["x > (unnamed): the registry could not be reached"] };
      },
    });
    expect(classifierPassed).toBe(true);
    expect(result).toMatchObject({ code: 1, outcomes: [], killed: 0 });
    expect(result.lines).toContain("mutation-score: BLOCK — the suite failed because of the machine, not the code; no mutant was judged");
    expect(result.lines).toContain("  x > (unnamed): the registry could not be reached");
    expect(runs).toBe(2);
    expect(dirtyFiles(dir)).toEqual([]);
  });

  test("a policy refusal (no container runtime) blocks before any suite runs or file is mutated", async () => {
    const dir = proj();
    let ran = false;
    const result = await runMutationScore(dir, {
      policy: { refusals: ["green needs a container runtime … Start Docker"], env: { set: {}, unset: [] }, prepares: [] },
      runSuite: async () => { ran = true; return { ok: true, note: "green" }; },
    });
    expect(result.code).toBe(1);
    expect(result.lines.at(-1)).toMatch(/BLOCK — .*Start Docker/);
    expect(ran).toBe(false);
    expect(dirtyFiles(dir)).toEqual([]);
  });

  test("a service that cannot start blocks, and the suite never runs against anything else", async () => {
    const dir = proj();
    let ran = false;
    const result = await runMutationScore(dir, {
      policy: { refusals: [], env: { set: {}, unset: [] }, prepares: [{ name: "db", prepare: async () => { throw new Error("no image"); } }] },
      runSuite: async () => { ran = true; return { ok: true, note: "green" }; },
    });
    expect(result.code).toBe(1);
    expect(result.lines.at(-1)).toMatch(/could not start what the run needs: no image/);
    expect(ran).toBe(false);
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

// --- the time budget and continuation (issue #48) -------------------------------
//
// A host kills a command that outlives its limit, and a measurement killed
// mid-run judged nothing. So a run stops between mutants when the next one's
// full timeout no longer fits its budget, keeps the verdicts it has, and the
// next run over the same tree carries on from there.

describe("runMutationScore within a time budget", () => {
  /** A clock the suite runner moves: every suite run takes `stepMs`. */
  function clock(stepMs: number): { readonly now: () => number; readonly advance: () => void } {
    let t = 0;
    return { now: () => t, advance: () => { t += stepMs; } };
  }

  /** A first call that cannot finish its 6-mutant sample in its budget. */
  async function partial(dir: string) {
    const c = clock(10_000);
    let calls = 0;
    const result = await runMutationScore(dir, {
      minimumSample: 6,
      timeoutMs: 10_000,
      budgetMs: 35_000,
      now: c.now,
      runSuite: async () => {
        c.advance();
        return calls++ === 0 ? { ok: true, note: "green" } : { ok: false, note: "1 failed" };
      },
    });
    return { result, calls };
  }

  test("a run that would outlast its budget stops between mutants, keeps its verdicts, and reports PARTIAL with no score", async () => {
    const dir = proj();
    const { result } = await partial(dir);

    expect(result.code).toBe(0);
    expect(result.complete).toBe(false);
    expect(result.score).toBeUndefined();
    expect(result.outcomes.length).toBeGreaterThan(0);
    expect(result.outcomes.length).toBeLessThan(6);
    const text = result.lines.join("\n");
    expect(text).toContain("PARTIAL");
    expect(text).toMatch(/run mutation-score again/i);
    expect(dirtyFiles(dir)).toEqual([]);
  });

  test("the next run over the same tree continues the sample without re-running the baseline", async () => {
    const dir = proj();
    const { result: first } = await partial(dir);
    expect(first.complete).toBe(false);

    let calls = 0;
    const second = await runMutationScore(dir, {
      minimumSample: 6,
      timeoutMs: 10_000,
      now: clock(10_000).now,
      // A baseline run here would be read as a red suite and refused.
      runSuite: async () => { calls++; return { ok: false, note: "1 failed" }; },
    });

    expect(calls).toBe(6 - first.outcomes.length);
    expect(second.code).toBe(0);
    expect(second.complete).toBe(true);
    expect(second.outcomes).toHaveLength(6);
    expect(second.score).toBe(100);
  });

  test("a budget that cannot fit the baseline and one mutant is an error naming the time needed, and starts nothing", async () => {
    const dir = proj();
    let prepared = 0;
    let ran = 0;
    const result = await runMutationScore(dir, {
      minimumSample: 6,
      timeoutMs: 10_000,
      budgetMs: 15_000,
      now: clock(10_000).now,
      policy: {
        refusals: [],
        env: { set: {}, unset: [] },
        prepares: [{ name: "db", prepare: async () => { prepared++; return { description: "started a database", env: {}, release: () => {} }; } }],
      },
      runSuite: async () => { ran++; return { ok: true, note: "green" }; },
    });

    expect(result.code).not.toBe(0);
    expect(result.complete).toBe(false);
    expect(prepared).toBe(0);
    expect(ran).toBe(0);
    const text = result.lines.join("\n");
    expect(text).toContain("20s");
    expect(text).toContain("--timeout-ms");
    expect(text).not.toMatch(/run mutation-score again/i);
    expect(readGuardLog(dir).filter((e) => e.guard === "mutation-score").at(-1)?.verdict).toBe("error");
    expect(dirtyFiles(dir)).toEqual([]);
  });

  test("a call whose baseline used up its time is PARTIAL, says so, and the next call starts with mutants", async () => {
    const dir = proj();
    const slow = clock(20_000);
    let calls = 0;
    const first = await runMutationScore(dir, {
      minimumSample: 6,
      timeoutMs: 10_000,
      budgetMs: 25_000,
      now: slow.now,
      runSuite: async () => { calls++; slow.advance(); return { ok: true, note: "green" }; },
    });
    expect(calls).toBe(1);
    expect(first.code).toBe(0);
    expect(first.complete).toBe(false);
    const text = first.lines.join("\n");
    expect(text).toMatch(/baseline/);
    expect(text).toMatch(/run mutation-score again/i);
    expect(text).not.toMatch(/judged nothing/);

    const fast = clock(1_000);
    const second = await runMutationScore(dir, {
      minimumSample: 6,
      timeoutMs: 10_000,
      budgetMs: 25_000,
      now: fast.now,
      runSuite: async () => { fast.advance(); return { ok: false, note: "1 failed" }; },
    });
    expect(second.outcomes.length).toBeGreaterThan(0);
  });

  test("a measurement leaves no signal listener and no journal behind", async () => {
    const dir = proj();
    const before = { int: process.listenerCount("SIGINT"), term: process.listenerCount("SIGTERM") };
    await runMutationScore(dir, { minimumSample: 3, runSuite: indexedRunner() });
    expect({ int: process.listenerCount("SIGINT"), term: process.listenerCount("SIGTERM") }).toEqual(before);
    expect(existsSync(join(dir, ".bounded/mutation-score/journal.json"))).toBe(false);
    expect(existsSync(join(dir, ".bounded/mutation-score/progress.json"))).toBe(false);
  });

  test("a change to the tree between runs starts the sample over", async () => {
    const dir = proj();
    const { result: first } = await partial(dir);
    expect(first.complete).toBe(false);
    writeFileSync(join(dir, "contexts/pm/src/tier.ts"), TIER_TS + "// a comment added between runs\n");

    let calls = 0;
    const second = await runMutationScore(dir, {
      minimumSample: 6,
      timeoutMs: 10_000,
      runSuite: async () => (calls++ === 0 ? { ok: true, note: "green" } : { ok: false, note: "1 failed" }),
    });

    expect(calls).toBe(1 + 6);
    expect(second.complete).toBe(true);
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
test("accepts zero", () => expect(parseAmount(0)).toEqual({ ok: true, value: 0 }));
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

    const result = await runMutationScore(dir, { minimumSample: 1, maxMutants: 3 });

    expect(result.code, result.lines.join("\n")).toBe(0);
    expect(result.outcomes.map((o) => o.site.file)).toEqual(Array(3).fill("contexts/pm/src/domain/money/money.ts"));
    expect(result.outcomes.map((o) => o.verdict)).toEqual(["killed", "killed", "killed"]);
    expect(result.score).toBe(100);
    expect(readFileSync(join(dir, "contexts/pm/src/domain/money/money.ts"), "utf8")).toBe(E2E_SRC);
  }, 120_000);
});
