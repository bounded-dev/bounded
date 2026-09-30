// lint-src gate (TN-26-001, BUILD stage): src/** may not switch the type
// checker off. Thin CLI over an ESLint flat config the gate owns outright.
//
//   node lint-src.ts [targetDir]
//
// Exit 0 clean · 1 problems (one greppable line each) · 2 no files matched
// (silence is not success — a gate that matches nothing is a broken gate).
//
// WHY THIS EXISTS. Dogfood Run 7 shipped a runtime contract violation, and
// the type checker had already caught it: `tsc` correctly typed
// `findInvoiceByOperationId(...)` as `Invoice | undefined`, and the builder
// wrote `!` to make the error go away. The type checker is a harness layer,
// and TypeScript ships exactly four switches that turn it off for one
// expression:
//
//   x!            no-non-null-assertion
//   x as T        consistent-type-assertions (assertionStyle: "never")
//   any           no-explicit-any
//   @ts-*         ban-ts-comment
//
// A model under pressure to reach green takes the cheapest path out, so the
// ban has NO exemption list: @ts-expect-error is banned even WITH a
// description (the plausible-sounding description is exactly what a model
// under pressure produces), and `linterOptions.noInlineConfig` means an
// `eslint-disable` comment cannot reopen any of the four from inside the file
// it is meant to police.
//
// `as const` REMAINS LEGAL, and that is not an exemption we granted:
// assertionStyle "never" exempts const assertions itself (verified against
// @typescript-eslint 8.68 — see lint-src.test.ts). `as const` narrows a
// literal; it never widens a type or silences a check. `satisfies` is legal
// for the same reason — it asks the checker a question instead of overruling
// its answer.
//
// Like contract-purity, this gate owns its ENTIRE flat config
// programmatically and consults no project config file: the target project
// never has an eslint config, so nothing in the target tree can weaken these
// rules. *.contract.ts is out of scope — that is the architect's zone, and
// contract-purity polices it.

import { fileURLToPath } from "node:url";
import { relative } from "node:path";
import { realpathSync } from "node:fs";
import { ESLint } from "eslint";
import { formatProblems, toProblems, type Problem } from "./lint-report.ts";
export type { Problem };
import parser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import harnessPlugin from "../eslint/index.ts";
import { composedPacks, installedPacks } from "../../installed.ts";
import { lintSrcRuleId, lintSrcRules, type LintSrcRuleContribution } from "../pack.ts";
// Harness-core guard log (NOTE: this relative import only resolves when the
// pack runs inside the harness checkout; pack distribution is issue #4).
import { logGuardEvent, type GuardVerdict } from "../../../src/guard-log.ts";
import { generatedFileGlobsFor, sourceRootsFor, testFileSuffixesFor } from "../../../src/pack-contrib.ts";
import { readProjectPacks } from "../../../src/project-composition.ts";

const GUARD = "lint-src";

const NOTHING_TO_LINT = /No files matching|are ignored/;

/** What the gate walks when no explicit patterns are given.
 *
 *  `.tsx` IS an implementation extension (TN-26-006 A1). A React component is
 *  ordinary `src/**` code that happens to be spelled with JSX, and every reason
 *  the four escape hatches are banned in a `.ts` module applies verbatim in a
 *  `.tsx` one — `props as any` is the same lie about the same type checker.
 *  Contracts stay `.ts`-ONLY: a contract is declaration-only by lint, so it has
 *  no JSX to spell, and `*.contract.tsx` would be a second name for the one
 *  artifact both blind roles code against. */
export const DEFAULT_PATTERNS: readonly string[] = ["src/**/*.ts", "src/**/*.tsx"];

/** Test sources get the same escape-hatch ban — Run 10's test helpers used `!`
 *  freely because only src/** was watched, and a suite that silences the type
 *  checker can assert its way past anything. Size ceilings deliberately do NOT
 *  apply here: a thorough suite legitimately runs long, and a describe block
 *  is one "function" to max-lines-per-function. `.tsx` for the same reason it
 *  is an implementation extension: a component test that renders JSX inline is
 *  the normal shape, and it must not be the one file in the tree where `any`
 *  is free. */
export const TEST_PATTERNS: readonly string[] = ["tests/**/*.ts", "tests/**/*.tsx"];
const SIZE_RULES = new Set(["complexity", "max-lines-per-function", "max-lines", "max-depth"]);

/** What the two runs walk, and what each leaves out. */
export interface LintScope {
  /** Implementation globs (the src run). */
  readonly src: readonly string[];
  /** Test-side globs (the tests run). */
  readonly tests: readonly string[];
  /** Left out of the src run: test-side files and generated files. */
  readonly srcIgnores: readonly string[];
  /** Left out of the tests run: generated files (the laws). */
  readonly testIgnores: readonly string[];
}

/** The flat layout's scope: `src/**` and `tests/**` (no source roots composed). */
export const FLAT_SCOPE: LintScope = { src: DEFAULT_PATTERNS, tests: TEST_PATTERNS, srcIgnores: [], testIgnores: [] };

/**
 * The lint scope a composition declares (ADRs 2026-056 to 2026-058). With
 * source roots, the src run walks every `.ts`/`.tsx` under each root except
 * the test-side and generated files; the tests run walks every test-side
 * file under each root except the generated ones (the generator answers for
 * those, as it does for skeletons). Without source roots, the flat layout.
 * An unreadable composition is the flat scope too: in a monorepo that
 * matches nothing, and a gate that matches nothing errors — fail-closed.
 */
export function lintScope(cwd: string, packsDir?: string): LintScope {
  let packs: readonly string[];
  try {
    packs = readProjectPacks(cwd);
  } catch {
    return FLAT_SCOPE;
  }
  const roots = sourceRootsFor(packs, packsDir);
  if (roots.length === 0) return FLAT_SCOPE;
  const suffixes = testFileSuffixesFor(packs, packsDir).filter((s) => /\.tsx?$/.test(s));
  const generated = generatedFileGlobsFor(packs, packsDir);
  return {
    src: roots.flatMap((root) => [`${root}/**/*.ts`, `${root}/**/*.tsx`]),
    tests: roots.flatMap((root) => suffixes.map((suffix) => `${root}/**/*${suffix}`)),
    srcIgnores: [...suffixes.map((suffix) => `**/*${suffix}`), ...generated],
    testIgnores: generated,
  };
}
// Value objects live in src/**; a test file declares none, so the zod rule
// would only ever fire on a test HELPER faking one — which the laws own.
const SRC_ONLY_RULES = new Set(["bounded-ts/zod-backed-parse"]);

/** Every rule id the src gate enforces — exported so guard-doc-drift.test.ts
 *  can require each one to be named in builder.md. The deterministic-check
 *  principle runs both ways: everything guarded must also be TOLD to the
 *  agent, so it can get it right the first time instead of learning the rule
 *  from a block. */
export const SRC_RULE_IDS: readonly string[] = [
  "complexity",
  "max-lines-per-function",
  "max-lines",
  "max-depth",
  "@typescript-eslint/no-non-null-assertion",
  "@typescript-eslint/consistent-type-assertions",
  "@typescript-eslint/no-explicit-any",
  "@typescript-eslint/ban-ts-comment",
  "bounded-ts/blessed-stacks-only",
  "bounded-ts/zod-backed-parse",
];

/** The subset enforced on tests/** (size ceilings excluded). */
export const TEST_RULE_IDS: readonly string[] = SRC_RULE_IDS.filter(
  (r) => !SIZE_RULES.has(r) && !SRC_ONLY_RULES.has(r),
);

// --- Contributed rules (TN-26-005, the ts pack's `lintSrcRules` socket) -------
//
// The ts pack DEFINES the socket (packs/ts/pack.ts); this gate READS it. The
// rules above stay hard-wired — gate and plugin are the same pack, and a base
// config that could be composed away is not a gate — so everything below is
// strictly additive: other packs' rules, appended after the ts pack's own.
//
// A harness composed without ts-web appends nothing and lints exactly as it did
// before the socket existed. That is the property the whole design is for.

/** Every rule contributed to this gate by a composed pack, in pack order. */
export function contributedSrcRules(cwd?: string): readonly LintSrcRuleContribution[] {
  return (cwd === undefined ? installedPacks() : composedPacks(cwd)).read(lintSrcRules);
}

/** Their ids (`<plugin>/<name>`), paired with the brief that must name each —
 *  read by guard-doc-drift.test.ts, which holds a contributed rule to exactly
 *  the same bidirectional obligation as a built-in one (ADR 2026-018). */
export function contributedSrcRuleIds(): readonly { id: string; namedIn: string }[] {
  return contributedSrcRules().map((c) => ({ id: lintSrcRuleId(c), namedIn: c.namedIn }));
}

/** Flat-config `plugins` for the contributed rules: one entry per distinct
 *  namespace, each holding every rule contributed under it. Assembled here
 *  rather than imported as a ready-made plugin object, so the gate's config is
 *  a function of what was COMPOSED — a pack left out of the composition leaves
 *  no namespace behind for a stale rule id to resolve through. */
function contributedPlugins(cwd?: string): Record<string, ESLint.Plugin> {
  const namespaces = new Map<string, Record<string, unknown>>();
  for (const contribution of contributedSrcRules(cwd)) {
    const rules = namespaces.get(contribution.plugin) ?? {};
    rules[contribution.name] = contribution.rule;
    namespaces.set(contribution.plugin, rules);
  }
  const out: Record<string, ESLint.Plugin> = {};
  // @typescript-eslint RuleModule and eslint's flat-config Plugin type are
  // structurally incompatible (the same known upstream friction the two
  // hard-wired plugins below are cast through); runtime fine.
  for (const [name, rules] of namespaces) out[name] = { rules } as unknown as ESLint.Plugin;
  return out;
}

/** Flat-config `rules` for the contributed rules — every one at "error". A
 *  contributed rule is a gate rule; "warn" would make it advice, and advice is
 *  what the deterministic-check principle exists to replace. */
function contributedRuleSettings(cwd?: string): Record<string, "error"> {
  const out: Record<string, "error"> = {};
  for (const contribution of contributedSrcRules(cwd)) out[lintSrcRuleId(contribution)] = "error";
  return out;
}

/** Contributed ids that do NOT bind the tests tree.
 *
 *  A contribution declares the brief that must name it, and that brief is also
 *  the tree its author is policing: the builder writes `src/**`, the
 *  test-writer writes `tests/**`. So `namedIn: "builder"` behaves exactly like
 *  the hard-wired SRC_ONLY_RULES above — registered for the src gate, filtered
 *  out of the tests run — except that it is DERIVED from the contribution
 *  rather than listed in a set the contributing pack cannot see. */
function contributedSrcOnlyIds(cwd?: string): ReadonlySet<string> {
  return new Set(
    contributedSrcRules(cwd).filter((c) => c.namedIn === "builder").map((c) => lintSrcRuleId(c)),
  );
}

export function createSrcLinter(cwd?: string, ignores: readonly string[] = []): ESLint {
  return new ESLint({
    // The gate owns the whole config: no project eslint config is consulted,
    // so results are identical in every repo.
    overrideConfigFile: true,
    ...(cwd === undefined ? {} : { cwd }),
    // The gate walks two extensions and most trees hold only one of them, so an
    // unmatched pattern is the NORMAL case, not a misuse: a service with no
    // components matches no `src/**/*.tsx` and a frontend-only slice matches no
    // `src/**/*.ts`. ESLint's default is to throw per unmatched pattern, which
    // would turn "this project has no components" into a broken-gate error.
    // "Did this gate match anything?" is answered once, downstream, by the file
    // count in classify() — one verdict, independent of how many globs it took
    // to get there.
    errorOnUnmatchedPattern: false,
    overrideConfig: [
      // Global ignore (a config object with only `ignores`): contract files
      // never enter the results at all, so they cannot inflate the file count
      // that decides "did this gate match anything?". Contracts are `.ts`-only
      // by design (see DEFAULT_PATTERNS), so one pattern still covers them all.
      { ignores: ["**/*.contract.ts", ...ignores] },
      {
        // @typescript-eslint/parser turns JSX parsing on from the FILENAME, so
        // the same parser instance handles both extensions with no options
        // (pinned by lint-src.test.ts, which lints a component through it).
        files: ["**/*.ts", "**/*.tsx"],
        languageOptions: { parser },
        // @typescript-eslint RuleModule and eslint's flat-config Plugin type
        // are structurally incompatible (known upstream friction); runtime fine.
        plugins: {
          "@typescript-eslint": tsPlugin as unknown as ESLint.Plugin,
          "bounded-ts": harnessPlugin as unknown as ESLint.Plugin,
          // Namespaces of packs that depend on ts (TN-26-005). Empty object
          // when nothing was composed — spreading it changes nothing.
          ...contributedPlugins(cwd),
        },
        // The file under inspection does not get a vote on whether it is
        // inspected: no eslint-disable, no inline severity override.
        linterOptions: { noInlineConfig: true },
        rules: {
          // --- Size and complexity ceilings -------------------------------
          // Run 10: kimi produced a 483-line single-module implementation and
          // a 148-test monolith; opus, same prompt and gates, produced four
          // focused modules. Decomposition quality tracks the model — but a
          // CEILING is mechanical, and these are core ESLint rules (the
          // complexity half of the CRAP metric; its coverage half is
          // deliberately absent — an assertion-blind coverage signal is the
          // exact lie test-obligations.ts exists to close).
          // Thresholds are ceilings, not targets: generous enough that a
          // correct design never meets them, low enough that a god-module
          // cannot ship. A block's remedy is decomposition, and for a builder
          // that usually means CONTRACT-DISPUTE — the architect owns the
          // module boundaries.
          complexity: ["error", { max: 15 }],
          "max-lines-per-function": ["error", { max: 60, skipBlankLines: true, skipComments: true }],
          "max-lines": ["error", { max: 350, skipBlankLines: true, skipComments: true }],
          "max-depth": ["error", { max: 4 }],
          "@typescript-eslint/no-non-null-assertion": "error",
          // "never" bans both `x as T` and `<T>x`, and exempts `as const`.
          "@typescript-eslint/consistent-type-assertions": [
            "error",
            { assertionStyle: "never" },
          ],
          "@typescript-eslint/no-explicit-any": ["error", { ignoreRestArgs: false }],
          // `true` = always report, so a description buys nothing. ts-check is
          // left alone: it turns checking ON.
          "@typescript-eslint/ban-ts-comment": [
            "error",
            {
              "ts-expect-error": true,
              "ts-ignore": true,
              "ts-nocheck": true,
              "ts-check": false,
            },
          ],
          // --- The blessed-stack binding (ADR 2026-029) --------------------
          // Known non-blessed API frameworks and schema engines may not be
          // imported: the stack is harness policy, and this is the layer of
          // the binding that holds when no skill loaded and no dependency
          // rule intervened. tRPC and zod are the blessed members.
          "bounded-ts/blessed-stacks-only": "error",
          // --- zod inside every value object (ADR 2026-031) ----------------
          // A branded class's static parse must delegate to a zod schema;
          // hand-rolled typeof-chains drift across builders and blunt the
          // generated hostile laws. src/** only (see TEST_RULE_IDS).
          "bounded-ts/zod-backed-parse": "error",
          // --- Contributed rules (the ts pack's lintSrcRules socket) --------
          // Appended LAST, so a contributed rule can never quietly restate one
          // of the ts pack's own at a lower severity: everything above is
          // "error", and everything here is "error" too.
          ...contributedRuleSettings(cwd),
        },
      },
    ],
  });
}

/** Lint one source text as if it lived at `fileName`. Pure: touches no disk. */
export async function lintSrcText(source: string, fileName: string): Promise<Problem[]> {
  const results = await createSrcLinter().lintText(source, { filePath: fileName });
  return toProblems(results);
}

/** One greppable line per problem: path:line:col  rule  message */
export function formatSrcProblems(results: ESLint.LintResult[], cwd: string): string[] {
  return formatProblems(results, cwd);
}

/** Verdict of one lint-src run: the same shape the red/green gates return. */
export interface LintSrcResult {
  readonly code: 0 | 1 | 2;
  readonly verdict: GuardVerdict;
  readonly summary: string;
  /** Greppable output lines (last line is the verdict headline). */
  readonly lines: string[];
  readonly detail: Readonly<Record<string, unknown>>;
}

/**
 * Run the lint-src gate over a target project and return its verdict without
 * printing or exiting. The CLI below is a thin wrapper over this, so there is
 * exactly one implementation of "does this src/ switch the checker off".
 */
export async function lintSrc(
  cwd: string,
  patterns?: readonly string[],
  packsDir?: string,
): Promise<LintSrcResult> {
  const scope = lintScope(cwd, packsDir);
  const result = await classify(cwd, [...(patterns ?? scope.src)], { ignores: scope.srcIgnores });
  logGuardEvent(cwd, {
    guard: GUARD,
    verdict: result.verdict,
    summary: result.summary,
    detail: result.detail,
  });
  return result;
}

/**
 * The tests/** variant: same escape-hatch rules, size ceilings filtered out,
 * `tests/generated/**` excluded (machine-written; the generator is trusted the
 * way the scaffolder is). Run inside the red gate, so an offending helper is
 * the test-writer's to fix at the moment fixing is cheap.
 */
export async function lintTests(cwd: string, packsDir?: string): Promise<LintSrcResult> {
  const scope = lintScope(cwd, packsDir);
  const base = await classify(cwd, [...scope.tests], { dropSizeRules: true, ignores: scope.testIgnores });
  const result = base.code === 2
    ? // No test files yet is a legitimate state mid-loop, not a broken gate.
      { ...base, code: 0 as const, verdict: "pass" as const, summary: "no test files yet", lines: [`${GUARD}: no test files yet`] }
    : base;
  logGuardEvent(cwd, { guard: "lint-tests", verdict: result.verdict, summary: result.summary, detail: result.detail });
  return result;
}

async function classify(
  cwd: string,
  patterns: string[],
  options: { dropSizeRules?: boolean; ignores?: readonly string[] } = {},
): Promise<LintSrcResult> {
  // ESLint throws its own wording when a pattern matches nothing — two
  // wordings, in fact: "No files matching …" when the glob found nothing at
  // all, and "All files matched … are ignored" when src/ holds only contract
  // files. Both mean the same thing here; normalize to the gate's message.
  const noMatch = (): LintSrcResult => {
    const summary = `no files matched [${patterns.join(", ")}]`;
    return {
      code: 2,
      verdict: "error",
      summary,
      lines: [`${GUARD}: ${summary} — a gate that matches nothing is a broken gate`],
      detail: { patterns },
    };
  };

  let results: ESLint.LintResult[];
  try {
    results = await createSrcLinter(cwd, options.ignores).lintFiles(patterns);
  } catch (e) {
    if (e instanceof Error && NOTHING_TO_LINT.test(e.message)) return noMatch();
    throw e;
  }
  const fileCount = results.length;
  if (fileCount === 0) return noMatch();

  if (options.dropSizeRules) {
    const srcOnly = contributedSrcOnlyIds(cwd);
    for (const r of results) {
      r.messages = r.messages.filter(
        (m) =>
          m.ruleId === null ||
          (!SIZE_RULES.has(m.ruleId) && !SRC_ONLY_RULES.has(m.ruleId) && !srcOnly.has(m.ruleId)),
      );
    }
  }
  if (options.dropSizeRules) {
    // Machine-written laws are excluded the way scaffolded skeletons are:
    // the generator, not the test-writer, answers for them.
    results = results.filter((r) => !/tests[\/\\]generated[\/\\]/.test(r.filePath));
  }
  const lines = formatSrcProblems(results, cwd);
  const files = `${fileCount} file${fileCount === 1 ? "" : "s"}`;
  if (lines.length > 0) {
    const summary = `${lines.length} problem${lines.length === 1 ? "" : "s"} in ${files}`;
    return {
      code: 1,
      verdict: "block",
      summary,
      lines: [...lines, `${GUARD}: ${summary}`],
      detail: { problems: toProblems(results) },
    };
  }
  const summary = `OK (${files})`;
  return { code: 0, verdict: "pass", summary, lines: [`${GUARD}: ${summary}`], detail: {} };
}

async function main(argv: string[]): Promise<number> {
  const result = await lintSrc(argv[0] ?? process.cwd());
  for (const line of result.lines) {
    if (result.code === 2) console.error(line);
    else console.log(line);
  }
  return result.code;
}

// Symlink-safe main check: the harness is reached via the ~/.pi/agent symlink,
// so argv[1] (symlink path) and import.meta.url (realpath) differ — compare realpaths.
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(`${GUARD}: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    },
  );
}
