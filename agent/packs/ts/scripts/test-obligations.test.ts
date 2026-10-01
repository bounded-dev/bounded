import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type { ObligationInput, ObligationSource } from "../pack.ts";
import { BOUNDARY_DASH, boundaryDescribeName, checkBoundaries, MIN_REJECTIONS, type BoundaryTarget } from "./boundaries.ts";
import { callSites } from "./call-sites.ts";
import { CONTEXT_SRC, type Fixture, pipelineProject, placeStage } from "./pipeline-fixture.test-support.ts";
import { projectFactsOf } from "./project-emitters.ts";
import { runScaffold } from "./scaffold-project.ts";
import {
  checkObligations,
  domainObligation,
  obligationLines,
  projectObligations,
  readObligationInput,
  reachedName,
  reachedNames,
} from "./test-obligations.ts";

const fixtures: Fixture[] = [];
afterAll(() => { for (const f of fixtures) f.cleanup(); });

/** The notebook pipeline, scaffolded, with the test-writer's files in. */
function scaffolded(withTests = true): Fixture {
  const f = pipelineProject(["design"]);
  fixtures.push(f);
  expect(runScaffold(f.dir).code).toBe(0);
  if (withTests) placeStage(f.dir, "tests", f.scope);
  return f;
}

function input(f: Fixture, phase: "red" | "green" = "red", reached: string[] = []): ObligationInput {
  return readObligationInput(f.dir, projectFactsOf(f.dir, "red"), phase, reached);
}

const messages = (i: ObligationInput): string[] => checkObligations(i).map((g) => g.message);

describe("reached names", () => {
  test("a red failure names the member it reached, in every form a runner prints", () => {
    expect(reachedName("NotImplementedError: Not implemented: Note.equals")).toBe("Note.equals");
    expect(reachedName("Not implemented: CreateNoteHandler.execute")).toBe("CreateNoteHandler.execute");
    expect(reachedName("error: something else\nNotImplementedError: Not implemented: NoteText.parse\n")).toBe("NoteText.parse");
  });

  test("prose that mentions the words is not a reach, and neither is a mangled name", () => {
    expect(reachedName("expected the note to be implemented: Note.equals")).toBeUndefined();
    expect(reachedName("NotImplementedError: Not implemented: ")).toBeUndefined();
    expect(reachedName(undefined)).toBeUndefined();
    expect(reachedNames(["Not implemented: B.x", "Not implemented: A.y", "Not implemented: B.x", undefined])).toEqual(["A.y", "B.x"]);
  });
});

describe("call sites", () => {
  test("qualified calls, method calls on anything, constructions and imports", () => {
    const sites = callSites([{ path: "a.test.ts", source: 'import { x } from "./y.ts";\nconst n = new Note(id, t);\nNoteText.parse("a");\nstore.save(n);\n' }]);
    expect([...sites.qualified]).toEqual(["NoteText.parse", "store.save"]);
    expect([...sites.methods].sort()).toEqual(["parse", "save"]);
    expect([...sites.constructed]).toEqual(["Note"]);
    expect([...sites.imports]).toEqual(["./y.ts"]);
  });
});

describe("the obligations on the notebook pipeline", () => {
  test("the complete suite owes nothing at red", () => {
    expect(messages(input(scaffolded()))).toEqual([]);
  });

  test("the domain, boundaries and layout obligations all run, in that order", () => {
    const names = projectObligations(["ts", "ts-hexagonal"]).map((o) => o.name);
    expect(names.slice(0, 2)).toEqual(["domain-concepts", "value-object-boundaries"]);
    expect(names).toContain("hexagonal-features");
    expect(names).toContain("hexagonal-app-smoke");
    expect(projectObligations(["ts"]).map((o) => o.name)).toEqual(["domain-concepts", "value-object-boundaries"]);
  });

  test("a concept without its unit test file, or without laws, is named with the file to write", () => {
    const f = scaffolded();
    rmSync(join(f.dir, CONTEXT_SRC, "domain/notes/note.test.ts"));
    rmSync(join(f.dir, CONTEXT_SRC, "domain/notes/note-text.laws.test.ts"));
    const gaps = checkObligations(input(f));
    expect(gaps).toContainEqual(expect.objectContaining({ level: "domain", path: `${CONTEXT_SRC}/domain/notes/note.test.ts` }));
    expect(gaps).toContainEqual(expect.objectContaining({ level: "domain", path: `${CONTEXT_SRC}/domain/notes/note-text.laws.test.ts` }));
    expect(obligationLines(gaps).every((l) => l.startsWith("  "))).toBe(true);
  });

  test("a factory member no test calls is a gap; a red failure that named it discharges it", () => {
    const i = input(scaffolded());
    const constructs = (x: ObligationSource): boolean => x.source.includes("new Note(");
    const other = { ...i, tests: i.tests.filter((x) => !constructs(x)), generatedTests: i.generatedTests.filter((x) => !constructs(x)) };
    expect(domainObligation.check(other).map((g) => g.message)).toContain("no test constructs Note: call new Note(…)");
    expect(domainObligation.check({ ...other, reached: new Set(["Note.constructor"]) }).map((g) => g.message))
      .not.toContain("no test constructs Note: call new Note(…)");
  });

  test("an instance method is reached only from the concept's own unit test or laws", () => {
    const f = scaffolded();
    const i = input(f);
    const noEquals = (t: ObligationSource): ObligationSource => ({ ...t, source: t.source.replaceAll(".equals(", ".same(") });
    const tests = i.tests.map((t) => (t.path.endsWith("/note-text.test.ts") ? noEquals(t) : t));
    const generatedTests = i.generatedTests.map((t) => (t.path.endsWith("/note-text.laws.test.ts") ? noEquals(t) : t));
    expect(domainObligation.check({ ...i, tests, generatedTests }).map((g) => g.message)).toContain("no test of NoteText calls its equals(…)");
  });

  test("a feature without its handler test, or whose test never constructs the handler or calls execute", () => {
    const f = scaffolded();
    const featureTest = `${CONTEXT_SRC}/application/notes/list-notes/list-notes.test.ts`;
    writeFileSync(join(f.dir, featureTest), 'import { test } from "bun:test";\ntest("x", () => {});\n');
    expect(messages(input(f))).toEqual(expect.arrayContaining([
      `${featureTest} never constructs ListNotesHandler`,
      `${featureTest} never calls ListNotesHandler.execute(…)`,
    ]));
    rmSync(join(f.dir, featureTest));
    expect(messages(input(f))).toContain(`list-notes has no handler test; write ${featureTest} with fakes of its out ports`);
  });

  test("a store port needs a conformance suite calling every method, and a store test per storage technology that runs it", () => {
    const f = scaffolded();
    const suite = `${CONTEXT_SRC}/application/notes/list-notes/list-notes.store.test-support.ts`;
    const storeTest = `${CONTEXT_SRC}/adapters/out/in-memory/notes/list-notes.store.test.ts`;
    writeFileSync(join(f.dir, storeTest), 'import { test } from "bun:test";\ntest("x", () => {});\n');
    writeFileSync(join(f.dir, suite), "export function listNotesStoreConformance(): void {}\n");
    expect(messages(input(f))).toEqual(expect.arrayContaining([
      "the ListNotesStore conformance suite never calls findAll(…)",
      `${storeTest} does not run the shared conformance suite (list-notes.store.test-support.ts)`,
    ]));
    rmSync(join(f.dir, suite));
    rmSync(join(f.dir, storeTest));
    expect(messages(input(f))).toEqual(expect.arrayContaining([
      `ListNotesStore has no conformance suite; write ${suite}, exporting a suite every storage technology runs`,
      `InMemoryListNotesStore has no store test; write ${storeTest} running the ListNotesStore conformance suite`,
    ]));
  });

  test("a store test may import the suite without an extension, or with .js", () => {
    const f = scaffolded();
    const storeTest = join(f.dir, CONTEXT_SRC, "adapters/out/in-memory/notes/list-notes.store.test.ts");
    for (const ext of ['"', '.js"']) {
      writeFileSync(storeTest, readFileSync(storeTest, "utf8").replace(/list-notes\.store\.test-support(?:\.ts|\.js)?"/, `list-notes.store.test-support${ext}`));
      expect(messages(input(f)), ext).toEqual([]);
    }
  });

  test("the generated command and in-adapter laws must be present", () => {
    const f = scaffolded();
    rmSync(join(f.dir, CONTEXT_SRC, "application/notes/create-note/create-note.command.laws.test.ts"));
    rmSync(join(f.dir, CONTEXT_SRC, "adapters/in/trpc/notes/list-notes.procedure.laws.test.ts"));
    expect(messages(input(f))).toEqual(expect.arrayContaining([
      "create-note has no generated command laws; run the design gate",
      "list-notes has no generated trpc laws; run the design gate",
    ]));
  });

  test("the app smoke test is owed at green, not at red", () => {
    const f = scaffolded();
    const smoke = "apps/web/src/server/composition-root.test.ts";
    rmSync(join(f.dir, smoke));
    expect(messages(input(f, "red"))).toEqual([]);
    expect(messages(input(f, "green"))).toEqual([`apps/web has no smoke test; write ${smoke} against its compose function`]);
  });

  test("a smoke test must import its app's compose function from the composition root and call it", () => {
    const f = scaffolded();
    const smoke = "apps/web/src/server/composition-root.test.ts";
    const write = (source: string): void => writeFileSync(join(f.dir, smoke), source);
    write('import { test } from "bun:test";\ntest("exists", () => {});\n');
    expect(messages(input(f, "green"))).toEqual([`${smoke} does not import its app's compose function from ./composition-root.ts`]);
    write('import { test } from "bun:test";\nimport { composeApp } from "./composition-root.ts";\ntest("imports only", () => { void composeApp; });\n');
    expect(messages(input(f, "green"))).toEqual([`${smoke} never calls the compose function it imports from ./composition-root.ts`]);
    write('import { test } from "bun:test";\nimport type { composeApp } from "./composition-root.ts";\ntest("type only", () => {});\n');
    expect(messages(input(f, "green"))).toEqual([`${smoke} does not import its app's compose function from ./composition-root.ts`]);
    write('import { test } from "bun:test";\nimport * as root from "./composition-root.ts";\ntest("calls", () => { root.composeApp(); });\n');
    expect(messages(input(f, "green"))).toEqual([]);
    write('import { test } from "bun:test";\nimport { composeApp as build } from "./composition-root";\ntest("calls", () => { build().createCaller({}); });\n');
    expect(messages(input(f, "green"))).toEqual([]);
  });

  test("an obligation that cannot read the design is a gap naming it, never a pass", () => {
    const f = scaffolded();
    writeFileSync(join(f.dir, CONTEXT_SRC, "application/notes/list-notes/list-notes.contract.ts"), "export interface Nope {}\n");
    expect(checkObligations(readObligationInput(f.dir, projectFactsOf(f.dir, "red"), "red")).some((g) => g.level === "hexagonal-features")).toBe(true);
  });
});

// --- boundaries (ADR 2026-059 form: parse returns Result) ----------------------------

const TARGET: BoundaryTarget = { name: "Currency", base: "string", contractFile: "contexts/shop/src/domain/money/currency.contract.ts" };
const t = (source: string): ObligationSource[] => [{ path: "contexts/shop/src/domain/money/currency.test.ts", source }];
const block = (body: string, title = boundaryDescribeName("Currency")): string =>
  `import { describe, expect, test } from "bun:test";\ndescribe(${JSON.stringify(title)}, () => {\n${body}\n});\n`;
const GOOD = `
  test("accepts", () => { expect(Currency.parse("USD").ok).toBe(true); });
  test("rejects lowercase", () => { expect(Currency.parse("usd").ok).toBe(false); });
  test("rejects two letters", () => { expect(Currency.parse("US")).toEqual({ ok: false, error: "Invalid currency" }); });`;

describe("value-object boundaries", () => {
  test("an accepted literal and two distinct rejected literals of the base type discharge it", () => {
    expect(checkBoundaries([TARGET], t(block(GOOD)))).toEqual([]);
    expect(boundaryDescribeName("Currency")).toBe(`Currency ${BOUNDARY_DASH} boundaries`);
    expect(MIN_REJECTIONS).toBe(2);
  });

  test("the Result forms: .ok toBe, toEqual, toStrictEqual, toMatchObject, `as const`, and a bound const", () => {
    const body = `
  test("a", () => { expect(Currency.parse("EUR")).toMatchObject({ ok: true }); });
  test("b", () => { const r = Currency.parse("eur"); expect(r.ok).toBe(false); });
  test("c", () => { const r = Currency.parse("E1R"); expect(r).toStrictEqual({ ok: false as const, error: "x" }); });`;
    expect(checkBoundaries([TARGET], t(block(body)))).toEqual([]);
  });

  test("the retired undefined forms no longer count", () => {
    const body = `
  test("a", () => { expect(Currency.parse("USD")).toBeDefined(); });
  test("b", () => { expect(Currency.parse("usd")).toBeUndefined(); });
  test("c", () => { expect(Currency.parse("US")).toBeUndefined(); });`;
    const kinds = checkBoundaries([TARGET], t(block(body))).map((v) => v.kind);
    expect(kinds).toEqual(["no-accepted-parse", "too-few-rejections"]);
  });

  test("loose assertions prove nothing: toBeTruthy, a negated matcher, a non-literal input", () => {
    const body = `
  test("a", () => { expect(Currency.parse("USD").ok).toBeTruthy(); });
  test("b", () => { expect(Currency.parse("usd").ok).not.toBe(true); });
  test("c", () => { expect(Currency.parse(input()).ok).toBe(false); });`;
    expect(checkBoundaries([TARGET], t(block(body))).map((v) => v.kind)).toEqual(["no-accepted-parse", "too-few-rejections"]);
  });

  test("one rejection is not two, and a repeated literal is one rejection", () => {
    const body = `
  test("a", () => { expect(Currency.parse("USD").ok).toBe(true); });
  test("b", () => { expect(Currency.parse("usd").ok).toBe(false); });
  test("c", () => { expect(Currency.parse("usd")).toEqual({ ok: false, error: "x" }); });`;
    const [v] = checkBoundaries([TARGET], t(block(body)));
    expect(v).toMatchObject({ kind: "too-few-rejections", rejections: ['"usd"'] });
  });

  test("wrong-type rejections belong to the laws and do not count", () => {
    const body = `
  test("a", () => { expect(Currency.parse("USD").ok).toBe(true); });
  test("b", () => { expect(Currency.parse(42).ok).toBe(false); });
  test("c", () => { expect(Currency.parse("usd").ok).toBe(false); });`;
    const [v] = checkBoundaries([TARGET], t(block(body)));
    expect(v).toMatchObject({ kind: "too-few-rejections", wrongTypeRejections: ["42"] });
  });

  test("a hyphen instead of the em dash is a misnamed block; a skipped block or test does not count", () => {
    expect(checkBoundaries([TARGET], t(block(GOOD, "Currency - boundaries"))).map((v) => v.kind)).toEqual(["misnamed-block"]);
    expect(checkBoundaries([TARGET], t(block(GOOD).replace("describe(", "describe.skip("))).map((v) => v.kind)).toEqual(["skipped-block"]);
    const skippedTest = GOOD.replace('test("rejects two letters"', 'test.skip("rejects two letters"');
    expect(checkBoundaries([TARGET], t(block(skippedTest))).map((v) => v.kind)).toEqual(["too-few-rejections"]);
    expect(checkBoundaries([TARGET], t("")).map((v) => v.kind)).toEqual(["missing-block"]);
  });

  test("numbers are compared as numbers: -1 and 1.5 are two rejections of a number", () => {
    const n: BoundaryTarget = { ...TARGET, name: "Quantity", base: "number" };
    const body = `
  test("a", () => { expect(Quantity.parse(1).ok).toBe(true); });
  test("b", () => { expect(Quantity.parse(-1).ok).toBe(false); });
  test("c", () => { expect(Quantity.parse(1.5).ok).toBe(false); });`;
    expect(checkBoundaries([n], t(block(body, boundaryDescribeName("Quantity"))))).toEqual([]);
  });

  test("on the pipeline, NoteId and NoteText are held to it and Note, an entity, is not", () => {
    const f = scaffolded();
    const noteText = `${CONTEXT_SRC}/domain/notes/note-text.test.ts`;
    writeFileSync(join(f.dir, noteText), 'import { test } from "bun:test";\nimport { NoteText } from "./note-text.ts";\ntest("x", () => { NoteText.parse("a").ok; });\n');
    const gaps = checkObligations(input(f)).filter((g) => g.level === "boundaries");
    expect(gaps).toEqual([{ level: "boundaries", path: noteText, message: expect.stringContaining('NoteText has no "NoteText — boundaries" block') }]);
  });
});
