import { writeProjectPacks } from "../../../src/project-composition.ts";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, test } from "vitest";
import {
  contributedSrcRuleIds,
  createSrcLinter,
  FLAT_SCOPE,
  formatSrcProblems,
  lintScope,
  lintSrc,
  lintSrcText,
  lintTests,
  SRC_RULE_IDS,
} from "./lint-src.ts";
import { scaffoldContract } from "./scaffold-contract.ts";
import { readGuardLog } from "../../../src/guard-log.ts";

const SRC = "src/orders/orders.ts";

async function rules(source: string, fileName = SRC): Promise<string[]> {
  return (await lintSrcText(source, fileName)).map((p) => p.ruleId);
}

// --- the four escape hatches --------------------------------------------------

describe("lintSrcText bans every way to switch the type checker off", () => {
  test("a clean implementation produces no problems", async () => {
    expect(
      await rules(
        "import type { Order } from './orders.contract.js';\n" +
          "export function total(o: Order): number { return o.total; }\n",
      ),
    ).toEqual([]);
  });

  // Dogfood Run 7: tsc correctly typed findInvoiceByOperationId as
  // `Invoice | undefined` and the builder wrote `!` to make it go away.
  test("a non-null assertion is reported", async () => {
    const problems = await lintSrcText(
      "declare const find: (id: string) => string | undefined;\n" +
        "export const x: string = find('a')!;\n",
      SRC,
    );
    expect(problems.map((p) => p.ruleId)).toEqual(["@typescript-eslint/no-non-null-assertion"]);
    expect(problems[0].line).toBe(2);
  });

  test("an `as` assertion is reported", async () => {
    expect(await rules("export const x = JSON.parse('{}') as { a: number };\n")).toEqual([
      "@typescript-eslint/consistent-type-assertions",
    ]);
  });

  test("an angle-bracket assertion is reported", async () => {
    expect(await rules("export const x = <number>(<unknown>1);\n")).toEqual([
      "@typescript-eslint/consistent-type-assertions",
      "@typescript-eslint/consistent-type-assertions",
    ]);
  });

  // VERIFIED against @typescript-eslint 8.68: assertionStyle "never" exempts
  // const assertions by design. `as const` narrows — it never widens a type or
  // silences a check — so it must stay legal, and this test pins that.
  test("`as const` stays legal", async () => {
    expect(await rules("export const modes = ['a', 'b'] as const;\n")).toEqual([]);
  });

  test("`satisfies` stays legal (it checks, it does not assert)", async () => {
    expect(await rules("export const p = { x: 1 } satisfies { x: number };\n")).toEqual([]);
  });

  test("`any` is reported, including in rest args", async () => {
    expect(await rules("export function f(...args: any[]): any { return args; }\n")).toEqual([
      "@typescript-eslint/no-explicit-any",
      "@typescript-eslint/no-explicit-any",
    ]);
  });

  test("@ts-expect-error is reported even WITH a description (no exemption list)", async () => {
    expect(
      await rules("// @ts-expect-error the contract is wrong, honestly\nexport const x: number = 'a';\n"),
    ).toEqual(["@typescript-eslint/ban-ts-comment"]);
  });

  test("@ts-ignore is reported", async () => {
    expect(await rules("// @ts-ignore\nexport const x: number = 'a';\n")).toEqual([
      "@typescript-eslint/ban-ts-comment",
    ]);
  });

  test("@ts-nocheck is reported", async () => {
    expect(await rules("// @ts-nocheck\nexport const x: number = 'a';\n")).toEqual([
      "@typescript-eslint/ban-ts-comment",
    ]);
  });
});

describe("the ban cannot be reopened from inside the file", () => {
  test("eslint-disable-next-line does not silence a rule (noInlineConfig)", async () => {
    expect(
      await rules(
        "declare const find: (id: string) => string | undefined;\n" +
          "// eslint-disable-next-line @typescript-eslint/no-non-null-assertion\n" +
          "export const x: string = find('a')!;\n",
      ),
    ).toEqual(["@typescript-eslint/no-non-null-assertion"]);
  });

  test("a file-wide /* eslint-disable */ does not silence a rule", async () => {
    expect(await rules("/* eslint-disable */\nexport const x: any = 1;\n")).toEqual([
      "@typescript-eslint/no-explicit-any",
    ]);
  });

  test("a rule cannot be downgraded to a warning from inside the file", async () => {
    expect(
      await rules('/* eslint @typescript-eslint/no-explicit-any: "off" */\nexport const x: any = 1;\n'),
    ).toEqual(["@typescript-eslint/no-explicit-any"]);
  });
});

describe("scope", () => {
  test("*.contract.ts is out of scope (the architect's zone, policed elsewhere)", async () => {
    expect(await rules("export declare const x: any;\n", "src/orders/orders.contract.ts")).toEqual([]);
  });
});

// --- the contributed-rules socket (TN-26-005) --------------------------------
//
// The gate's config is assembled from the ts pack's own rules PLUS whatever the
// composed packs contributed. `calculateConfigForFile` is what ESLint itself
// would resolve for a file, so these tests read the gate's real answer rather
// than a restatement of the code above it — the base rules must survive
// composition, and every contributed rule must arrive at "error".

describe("contributed rules reach the flat config", () => {
  async function resolvedRules(file: string): Promise<Record<string, unknown>> {
    const config = await createSrcLinter().calculateConfigForFile(file);
    return config.rules ?? {};
  }

  test("every one of the ts pack's own rules is still enforced", async () => {
    const resolved = await resolvedRules(SRC);
    expect(SRC_RULE_IDS.filter((id) => resolved[id] === undefined)).toEqual([]);
  });

  test("every contributed rule is registered, at error", async () => {
    const resolved = await resolvedRules(SRC);
    const missing: string[] = [];
    for (const { id } of contributedSrcRuleIds()) {
      const severity = resolved[id];
      // ESLint normalises "error" to 2 in a calculated config.
      if (severity !== 2 && severity !== "error" && !(Array.isArray(severity) && (severity[0] === 2 || severity[0] === "error"))) {
        missing.push(`${id} → ${JSON.stringify(severity)}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("a contributed rule's namespace is a plugin the config can resolve", async () => {
    const config = await createSrcLinter().calculateConfigForFile(SRC);
    const namespaces = new Set(contributedSrcRuleIds().map(({ id }) => id.split("/")[0]));
    for (const ns of namespaces) {
      expect(config.plugins?.[ns], `plugin '${ns}' is not registered`).toBeDefined();
    }
  });

  // End to end: the socket is not wired until a contributed rule actually
  // BLOCKS through the gate the ts pack owns. Everything above checks the
  // config; this checks the verdict.
  test("a contributed rule blocks real source through the src gate", async () => {
    const problems = await rules(
      'import { initTRPC } from "@trpc/server";\n' +
        "export const t = initTRPC.create();\n",
      "src/orders/api.ts",
    );
    expect(problems).toContain("bounded-ts-trpc/raw-framework-entry");
  });

  test("and a contributed rule is silent on code that obeys it", async () => {
    const problems = await rules(
      'import { fetchRequestHandler } from "@trpc/server/adapters/fetch";\n' +
        "export const x = fetchRequestHandler;\n",
      "src/orders/server.ts",
    );
    expect(problems).toEqual([]);
  });

  test("the contributed ids are well formed — <plugin>/<rule>, no collisions", () => {
    const ids = contributedSrcRuleIds().map(({ id }) => id);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/);
    expect(new Set(ids).size).toBe(ids.length);
    // A contributed rule may not shadow one of the gate's own.
    expect(ids.filter((id) => SRC_RULE_IDS.includes(id))).toEqual([]);
  });
});

// --- TSX is implementation, and implementation is policed (TN-26-006 A1) -----
//
// A React component is ordinary src/** code that happens to be spelled with
// JSX. If `.tsx` were outside the gate, every escape hatch the harness bans
// would be legal in the one part of the tree where the type checker is doing
// the most work — `props as any` is the same lie about the same checker, and a
// model under pressure takes the cheapest path out wherever it is offered.

const COMPONENT_TSX = `import type { ReactElement } from "react";

export interface BadgeProps {
  readonly tone: "ok" | "warn";
}

export function Badge(props: BadgeProps): ReactElement {
  return <span className={props.tone}>{props.tone === "ok" ? "OK" : "!"}</span>;
}
`;

describe("TSX sources", () => {
  const TSX = "src/ui/badge.tsx";

  // The whole plumbing claim in one assertion: @typescript-eslint/parser turns
  // JSX parsing on from the FILENAME, so the same parser instance the gate
  // already configures handles a component with no options and no second
  // config block. A parse failure here would surface as a phantom problem.
  test("a component with JSX parses and produces no problems", async () => {
    expect(await lintSrcText(COMPONENT_TSX, TSX)).toEqual([]);
  });

  test("the escape hatches are banned inside JSX too", async () => {
    const source = `import type { ReactElement } from "react";
export function Badge(props: any): ReactElement {
  return <span title={(props.tone as string)}>{props.label!}</span>;
}
`;
    expect((await lintSrcText(source, TSX)).map((p) => p.ruleId).sort()).toEqual([
      "@typescript-eslint/consistent-type-assertions",
      "@typescript-eslint/no-explicit-any",
      "@typescript-eslint/no-non-null-assertion",
    ]);
  });

  test("a @ts-expect-error above a JSX line is still reported", async () => {
    expect(
      await rules(
        `import type { ReactElement } from "react";
export function Badge(): ReactElement {
  // @ts-expect-error the prop types are wrong, honestly
  return <span aria-hidden={1}>x</span>;
}
`,
        TSX,
      ),
    ).toEqual(["@typescript-eslint/ban-ts-comment"]);
  });

  test("the ban cannot be reopened from inside a .tsx either", async () => {
    expect(
      await rules("/* eslint-disable */\nexport const x: any = 1;\n", TSX),
    ).toEqual(["@typescript-eslint/no-explicit-any"]);
  });

  // `*.contract.ts` is the ONLY contract spelling (a declaration-only file has
  // no JSX to write), so the global ignore needs no `.tsx` twin — and a file
  // named like one must not buy itself an exemption by changing extension.
  test("a *.contract.tsx is NOT exempt — contracts are .ts, so this is implementation", async () => {
    expect(await rules("export const x: any = 1;\n", "src/orders/orders.contract.tsx")).toEqual([
      "@typescript-eslint/no-explicit-any",
    ]);
  });
});

// --- the generated red-phase skeletons must survive the gate ------------------

describe("scaffolder skeletons lint clean", () => {
  const dataDir = join(import.meta.dirname, "testdata");
  for (const name of ["functions", "queue", "types", "values"]) {
    test(`${name}.contract.ts → skeleton has no escape hatches`, async () => {
      const contractPath = join(dataDir, `${name}.contract.ts`);
      const skeleton = scaffoldContract(readFileSync(contractPath, "utf8"), `src/${name}.contract.ts`);
      const problems = await lintSrcText(skeleton, `src/${name}.ts`);
      // Loud on purpose: a skeleton that trips this gate is a SCAFFOLDER bug.
      expect(problems.map((p) => `${p.ruleId}: ${p.message}`)).toEqual([]);
    });
  }
});

// --- formatting ---------------------------------------------------------------

describe("formatSrcProblems (one greppable line per problem)", () => {
  test("path:line:col, rule, message", async () => {
    const results = await createSrcLinter().lintText("export const x: any = 1;\n", {
      filePath: "src/orders/orders.ts",
    });
    const lines = formatSrcProblems(results, process.cwd());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^src\/orders\/orders\.ts:1:17\s+@typescript-eslint\/no-explicit-any\s+Unexpected any/,
    );
  });
});

// --- the gate over a project tree ---------------------------------------------

const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function project(prefix: string, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  writeProjectPacks(dir, ["ts"]);
  tmpDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

describe("lintSrc", () => {
  test("exit 0 / pass on a clean src tree, and the pass is logged", async () => {
    const dir = project("lint-src-ok-", {
      "src/orders/orders.contract.ts": "export declare const x: number;\n",
      "src/orders/orders.ts": "export const x = 1;\n",
    });
    const result = await lintSrc(dir);
    expect(result.code).toBe(0);
    expect(result.verdict).toBe("pass");
    expect(result.summary).toBe("OK (1 file)");
    expect(result.lines).toEqual(["lint-src: OK (1 file)"]);
    expect(readGuardLog(dir)).toMatchObject([{ guard: "lint-src", verdict: "pass" }]);
  });

  test("exit 1 / block with greppable lines and the problems in the log detail", async () => {
    const dir = project("lint-src-bad-", {
      "src/orders/orders.ts": "export const x: any = 1;\n",
    });
    const result = await lintSrc(dir);
    expect(result.code).toBe(1);
    expect(result.verdict).toBe("block");
    expect(result.summary).toBe("1 problem in 1 file");
    expect(result.lines[0]).toMatch(
      /^src\/orders\/orders\.ts:1:17\s+@typescript-eslint\/no-explicit-any\s+/,
    );
    expect(result.lines.at(-1)).toBe("lint-src: 1 problem in 1 file");
    const events = readGuardLog(dir);
    expect(events).toMatchObject([{ guard: "lint-src", verdict: "block" }]);
    const problems = events[0].detail?.["problems"] as { ruleId: string }[];
    expect(problems.map((p) => p.ruleId)).toEqual(["@typescript-eslint/no-explicit-any"]);
  });

  test("exit 2 / error when nothing matched — silence is not success", async () => {
    const dir = project("lint-src-none-", { "README.md": "no src here\n" });
    const result = await lintSrc(dir);
    expect(result.code).toBe(2);
    expect(result.verdict).toBe("error");
    expect(result.lines[0]).toMatch(/lint-src: no files matched/);
    expect(readGuardLog(dir)).toMatchObject([{ guard: "lint-src", verdict: "error" }]);
  });

  test("a tree of contracts alone matches nothing (contracts are not implementation)", async () => {
    const dir = project("lint-src-contracts-", {
      "src/orders/orders.contract.ts": "export declare const x: number;\n",
    });
    const result = await lintSrc(dir);
    expect(result.code).toBe(2);
  });

  // The gate now walks two globs, and ESLint's default is to throw the moment
  // one of them matches nothing. Every tree below matches exactly one — which
  // is the NORMAL state, not a misuse — so all three must come back with a
  // verdict about the files that DO exist.
  test("a src tree of .tsx alone is linted (one glob matching nothing is not an error)", async () => {
    const dir = project("lint-src-tsx-", { "src/ui/badge.tsx": COMPONENT_TSX });
    const result = await lintSrc(dir);
    expect(result.code).toBe(0);
    expect(result.summary).toBe("OK (1 file)");
  });

  test("a mixed tree counts both extensions, and blocks on the .tsx", async () => {
    const dir = project("lint-src-mixed-", {
      "src/orders/orders.ts": "export const x = 1;\n",
      "src/ui/badge.tsx": "export const Badge: any = null;\n",
    });
    const result = await lintSrc(dir);
    expect(result.code).toBe(1);
    expect(result.summary).toBe("1 problem in 2 files");
    expect(result.lines[0]).toMatch(/^src\/ui\/badge\.tsx:1:21\s+@typescript-eslint\/no-explicit-any\s+/);
  });

  test("still exit 2 when NEITHER glob matches — silence is not success", async () => {
    const dir = project("lint-src-neither-", { "README.md": "no src here\n" });
    expect((await lintSrc(dir)).code).toBe(2);
  });

  test("files outside src/ are not linted", async () => {
    const dir = project("lint-src-outside-", {
      "src/orders/orders.ts": "export const x = 1;\n",
      "tests/orders.test.ts": "export const y: any = 1;\n",
      "scripts/build.ts": "export const z: any = 1;\n",
    });
    const result = await lintSrc(dir);
    expect(result.code).toBe(0);
  });
});

// --- source roots (ADR 2026-056): the monorepo layout ---------------------------
//
// The composition's own ts pack, with the layout a ts-hexagonal composition
// adds: two source roots, the test-side suffixes and a generated glob. A
// fixture packs directory holds it, so the real composition (and its
// contributed rules) is unchanged.

function monorepoPacks(): string {
  const packsDir = mkdtempSync(join(tmpdir(), "lint-src-packs-"));
  tmpDirs.push(packsDir);
  const real = JSON.parse(readFileSync(join(import.meta.dirname, "..", "contrib.json"), "utf8")) as Record<string, unknown>;
  mkdirSync(join(packsDir, "ts"));
  writeFileSync(join(packsDir, "ts", "contrib.json"), JSON.stringify({
    ...real,
    sourceRoots: ["contexts/*/src", "apps/*/src"],
    generatedFileGlobs: [...(real["generatedFileGlobs"] as string[]), "contexts/*/src/application/index.ts"],
  }));
  return packsDir;
}

describe("the lint scope comes from the composed source roots", () => {
  test("flat without source roots; per root with them, test-side and generated files split out", () => {
    const flat = project("lint-scope-flat-", {});
    expect(lintScope(flat)).toEqual(FLAT_SCOPE);
    const packsDir = monorepoPacks();
    expect(lintScope(flat, packsDir)).toEqual({
      src: ["apps/*/src/**/*.ts", "apps/*/src/**/*.tsx", "contexts/*/src/**/*.ts", "contexts/*/src/**/*.tsx"],
      tests: [
        "apps/*/src/**/*.test-support.ts", "apps/*/src/**/*.test.ts", "apps/*/src/**/*.test.tsx",
        "contexts/*/src/**/*.test-support.ts", "contexts/*/src/**/*.test.ts", "contexts/*/src/**/*.test.tsx",
      ],
      srcIgnores: ["**/*.test-support.ts", "**/*.test.ts", "**/*.test.tsx", "**/*.laws.test.ts", "contexts/*/src/application/index.ts"],
      testIgnores: ["**/*.laws.test.ts", "contexts/*/src/application/index.ts"],
    });
  });

  test("the src run lints implementations under every root and nothing else", async () => {
    const packsDir = monorepoPacks();
    const dir = project("lint-src-monorepo-", {
      "contexts/pm/src/domain/note.ts": "export const x: any = 1;\n",
      "apps/web/src/main.ts": "export const y = 1 as number;\n",
      "contexts/pm/src/domain/note.test.ts": "export const t: any = 1;\n",
      "contexts/pm/src/application/notes.store.test-support.ts": "export const s: any = 1;\n",
      "contexts/pm/src/domain/note.contract.ts": "export const c: any = 1;\n",
      "contexts/pm/src/application/index.ts": "export const g: any = 1;\n",
      "src/legacy.ts": "export const l: any = 1;\n",
    });
    const result = await lintSrc(dir, undefined, packsDir);
    const files = [...new Set((result.detail["problems"] as { filePath: string }[]).map((p) => relative(dir, p.filePath)))].sort();
    expect(files).toEqual(["apps/web/src/main.ts", "contexts/pm/src/domain/note.ts"]);
  });

  test("the tests run lints every test-side file, never the generated laws", async () => {
    const packsDir = monorepoPacks();
    const dir = project("lint-tests-monorepo-", {
      "contexts/pm/src/domain/note.ts": "export const x: any = 1;\n",
      "contexts/pm/src/domain/note.test.ts": "export const t: any = 1;\n",
      "contexts/pm/src/application/notes.store.test-support.ts": "export const s: any = 1;\n",
      "contexts/pm/src/domain/note.laws.test.ts": "export const l: any = 1;\n",
    });
    const result = await lintTests(dir, packsDir);
    const files = [...new Set((result.detail["problems"] as { filePath: string }[]).map((p) => relative(dir, p.filePath)))].sort();
    expect(files).toEqual(["contexts/pm/src/application/notes.store.test-support.ts", "contexts/pm/src/domain/note.test.ts"]);
  });

  test("a monorepo with no implementation yet matches nothing: a broken gate, not a pass", async () => {
    const packsDir = monorepoPacks();
    const dir = project("lint-src-monorepo-empty-", { "contexts/pm/src/domain/note.contract.ts": "export {};\n" });
    expect((await lintSrc(dir, undefined, packsDir)).code).toBe(2);
  });
});

// --- the tests/** variant, run inside the red gate ----------------------------

describe("lintTests", () => {
  // A component test renders JSX inline — that IS the normal shape — so `.tsx`
  // has to be in the tests glob or the suite gets one file where `any` is free
  // and can assert its way past anything (Run 10, with a new extension).
  test("a .tsx test file is linted and the escape hatches still apply", async () => {
    const dir = project("lint-tests-tsx-", {
      "tests/badge.test.tsx": `import type { ReactElement } from "react";
const el: any = (<span>hi</span>) as ReactElement;
export const x = el;
`,
    });
    const result = await lintTests(dir);
    expect(result.code).toBe(1);
    const problems = result.detail["problems"] as { ruleId: string }[];
    expect(problems.map((p) => p.ruleId).sort()).toEqual([
      "@typescript-eslint/consistent-type-assertions",
      "@typescript-eslint/no-explicit-any",
    ]);
  });

  test("a .tsx test may be long and deeply nested — size ceilings are src-only", async () => {
    const body = Array.from({ length: 80 }, (_, i) => `  void ${i};`).join("\n");
    const dir = project("lint-tests-size-", {
      "tests/badge.test.tsx": `export function suite(): void {\n${body}\n}\n`,
    });
    expect((await lintTests(dir)).code).toBe(0);
  });

  // A contributed rule declares the brief that must name it, and that brief is
  // also the tree it polices: all three of ts-web's bind the BUILDER, so the
  // tests run drops them the way it drops the ts pack's own src-only rules. A
  // test rendering a component under a real QueryClientProvider is doing its
  // job, not smuggling in a second transport.
  test("a builder-bound contributed rule does not fire on tests/**", async () => {
    const dir = project("lint-tests-contributed-", {
      "tests/dashboard.test.tsx": `import { QueryClient } from "@tanstack/react-query";
export const client = new QueryClient();
`,
    });
    const result = await lintTests(dir);
    expect(result.code).toBe(0);
  });

  test("no test files at all is a legitimate mid-loop state, not a broken gate", async () => {
    const dir = project("lint-tests-none-", { "src/a.ts": "export const x = 1;\n" });
    const result = await lintTests(dir);
    expect(result.code).toBe(0);
    expect(result.summary).toBe("no test files yet");
  });
});

// --- CLI ----------------------------------------------------------------------

const SCRIPT = join(import.meta.dirname, "lint-src.ts");

describe("lint-src CLI", () => {
  test("exit 0 with an OK summary", () => {
    const dir = project("lint-src-cli-ok-", { "src/a.ts": "export const x = 1;\n" });
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/lint-src: OK \(1 file\)/);
  });

  test("exit 1 and prints the offending line", () => {
    const dir = project("lint-src-cli-bad-", {
      "src/a.ts": "declare const f: () => string | undefined;\nexport const x: string = f()!;\n",
    });
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/src\/a\.ts:2:26\s+@typescript-eslint\/no-non-null-assertion/);
  });

  test("exit 2 to stderr when nothing matched", () => {
    const dir = project("lint-src-cli-none-", { "README.md": "\n" });
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/lint-src: no files matched/);
  });

  test("takes the target directory as an argument", () => {
    const dir = project("lint-src-cli-arg-", { "src/a.ts": "export const x: any = 1;\n" });
    const r = spawnSync(process.execPath, [SCRIPT, dir], { cwd: tmpdir(), encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/src\/a\.ts:1:17\s+@typescript-eslint\/no-explicit-any/);
  });

  test("runs when invoked through a symlink (the ~/.pi/agent case)", () => {
    const dir = project("lint-src-cli-link-", { "src/a.ts": "export const x = 1;\n" });
    const link = join(dir, "lint-src.link.ts");
    symlinkSync(SCRIPT, link);
    const r = spawnSync(process.execPath, [link], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/lint-src: OK/);
  });
});

// Size and complexity ceilings (Run 10: kimi's 483-line module vs opus's four
// focused ones — a ceiling is mechanical even though decomposition taste is not).

describe("size and complexity ceilings", () => {
  test("a function over 60 real lines is blocked", async () => {
    const body = Array.from({ length: 65 }, (_, i) => `  const v${i} = ${i};`).join("\n");
    const problems = await lintSrcText(`export function big(): void {\n${body}\n}\n`, "src/big.ts");
    expect(problems.map((p) => p.ruleId)).toContain("max-lines-per-function");
  });

  test("a file over 350 real lines is blocked", async () => {
    const lines = Array.from({ length: 360 }, (_, i) => `export const c${i} = ${i};`).join("\n");
    const problems = await lintSrcText(lines + "\n", "src/huge.ts");
    expect(problems.map((p) => p.ruleId)).toContain("max-lines");
  });

  test("cyclomatic complexity over 15 is blocked", async () => {
    const branches = Array.from({ length: 20 }, (_, i) => `  if (n === ${i}) return ${i};`).join("\n");
    const problems = await lintSrcText(`export function f(n: number): number {\n${branches}\n  return -1;\n}\n`, "src/f.ts");
    expect(problems.map((p) => p.ruleId)).toContain("complexity");
  });

  test("comments and blank lines do not count against the ceilings", async () => {
    const body = Array.from({ length: 50 }, (_, i) => `  const v${i} = ${i};\n  // note\n`).join("");
    const problems = await lintSrcText(`export function ok(): void {\n${body}}\n`, "src/ok.ts");
    expect(problems.filter((p) => p.ruleId === "max-lines-per-function")).toEqual([]);
  });
});
