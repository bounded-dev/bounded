import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { readGuardLog } from "../../../src/guard-log.ts";
import { pathLayoutFor } from "../../../src/pack-contrib.ts";
import { cannedGateEnv, cannedRun, withEnv } from "./junit-fixture.test-support.ts";
import { CONTEXT_SRC, type Fixture, pipelineProject, placeStage } from "./pipeline-fixture.test-support.ts";
import { emitProject, projectFactsOf } from "./project-emitters.ts";
import { generatedFileGlobs } from "../../../src/pack-contrib.ts";
import {
  classifyGeneratedLaws,
  classifyRed,
  isNotImplementedFailure,
  materializeShadow,
  redBeforeHash,
  redShadowPlan,
  runRedGate,
  SHADOW_RELATIVE,
  shadowContamination,
  shadowProjectDir,
  testFilesHash,
  testSideFiles,
  withGeneratedOnly,
  withoutPolicySkips,
  withTestLint,
} from "./red-gate.ts";
import { runTests, type RunTestsResult } from "./run-tests.ts";
import { runScaffold } from "./scaffold-project.ts";
import type { TypecheckResult } from "./typecheck.ts";

// The layout a hexagonal ts project composes: who owns each file a diagnostic names.
const TS_ZONE = pathLayoutFor(["ts", "ts-hexagonal"]);
const NI = (member: string): string => `NotImplementedError: Not implemented: ${member}`;
const TYPE_CLEAN: TypecheckResult = { ok: true, errorCount: 0, diagnostics: [] };
const tsc = (...diagnostics: string[]): TypecheckResult => ({ ok: false, errorCount: diagnostics.length, diagnostics });
const run = (partial: Partial<RunTestsResult>): RunTestsResult => ({ ok: false, total: 0, passed: 0, failed: 0, skipped: 0, results: [], ...partial });
const TEST_TYPE_ERR = `${CONTEXT_SRC}/domain/notes/note.test.ts(12,5): error TS2532: Object is possibly 'undefined'.`;
const CONTRACT_TYPE_ERR = `${CONTEXT_SRC}/domain/notes/note.contract.ts(9,1): error TS2304: Cannot find name 'Isbn'.`;

const fixtures: Fixture[] = [];
afterAll(() => { for (const f of fixtures) f.cleanup(); });

/** The notebook pipeline: designed and scaffolded, the test-writer's files in. */
function notebook(stages: readonly ("tests" | "build" | "half")[] = ["tests"]): Fixture {
  const f = pipelineProject(["design"]);
  fixtures.push(f);
  expect(runScaffold(f.dir).code).toBe(0);
  for (const stage of stages) placeStage(f.dir, stage, f.scope);
  return f;
}

describe("isNotImplementedFailure", () => {
  test("matches the generated errors module's error by name", () => {
    expect(isNotImplementedFailure(NI("Note.equals"))).toBe(true);
    expect(isNotImplementedFailure("AssertionError: expected 1 to be 2")).toBe(false);
    expect(isNotImplementedFailure(undefined)).toBe(false);
  });
});

describe("classifyRed", () => {
  test("valid red: every failure is NotImplemented, typecheck clean", () => {
    const r = classifyRed(run({ total: 2, failed: 2, results: [
      { name: "a", status: "failed", message: NI("a") },
      { name: "b", status: "failed", message: NI("b") },
    ] }), TYPE_CLEAN);
    expect(r).toMatchObject({ code: 0, verdict: "pass" });
    expect(r.lines[0]).toMatch(/red-gate: OK — 2 NotImplemented failures, 0 passed, 2 total, typecheck clean/);
  });

  test("a test passing against the skeleton, a skipped test or an unknown status cannot hide behind a NotImplemented failure", () => {
    const passing = classifyRed(run({ total: 2, passed: 1, failed: 1, results: [{ name: "a", status: "passed" }, { name: "b", status: "failed", message: NI("b") }] }), TYPE_CLEAN);
    expect(passing.lines).toContain("  passed against skeleton: a");
    expect(passing.detail).toMatchObject({ reason: "spurious-pass", passing: ["a"], route: "test-writer" });
    const skipped = classifyRed(run({ total: 2, failed: 1, skipped: 1, results: [{ name: "b", status: "failed", message: NI("b") }, { name: "later", status: "skipped" }] }), TYPE_CLEAN);
    expect(skipped.lines).toContain("  did not fail: later (skipped)");
    const unknown = classifyRed(run({ total: 2, failed: 1, results: [{ name: "b", status: "failed", message: NI("b") }, { name: "odd", status: "unknown" }] }), TYPE_CLEAN);
    expect(unknown.detail).toMatchObject({ reason: "non-red-tests" });
  });

  test("wrong-reason red names the failure and not the right-reason one", () => {
    const r = classifyRed(run({ total: 2, failed: 2, results: [
      { name: "pending", status: "failed", message: NI("a") },
      { name: "math", status: "failed", message: "AssertionError: expected 1 to be 2" },
    ] }), TYPE_CLEAN);
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toContain("wrong-reason: math — AssertionError: expected 1 to be 2");
    expect(r.lines.join("\n")).not.toContain("pending");
  });

  test("a blocked suite, a fully passing suite and an empty suite are not red", () => {
    expect(classifyRed(run({ blocked: "no report" }), TYPE_CLEAN).lines[0]).toMatch(/suite did not run/);
    expect(classifyRed(run({ total: 1, passed: 1, results: [{ name: "a", status: "passed" }] }), TYPE_CLEAN).lines[0]).toMatch(/suite fully passes/);
    expect(classifyRed(run({ total: 0 }), TYPE_CLEAN).lines[0]).toMatch(/no tests ran/);
  });

  test("a NotImplemented thrown while bun collects a file is wrong-reason, and explains itself", () => {
    const r = classifyRed(run({ failed: 2, total: 2, results: [
      { name: "Note > equals", status: "failed", message: NI("Note.equals") },
      { name: "(outside any test)", status: "failed", message: NI("Note.parse") },
    ] }), TYPE_CLEAN);
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toMatch(/IMPORT\/COLLECTION/);
    const plain = classifyRed(run({ failed: 1, total: 1, results: [{ name: "adds", status: "failed", message: "expected 2 to be 3" }] }), TYPE_CLEAN);
    expect(plain.lines.join("\n")).not.toMatch(/COLLECTION/);
  });

  test("a type error blocks a valid red and routes by owner: a test file to the test-writer, a contract to the architect", () => {
    const valid = run({ total: 1, failed: 1, results: [{ name: "a", status: "failed", message: NI("a") }] });
    const test1 = classifyRed(valid, tsc(TEST_TYPE_ERR), TS_ZONE);
    expect(test1.lines[0]).toMatch(/1 type error; red is valid but the project is not type-clean/);
    expect(test1.lines).toContain("red-gate: route → test-writer");
    expect(classifyRed(valid, tsc(CONTRACT_TYPE_ERR, TEST_TYPE_ERR), TS_ZONE).lines).toContain("red-gate: route → architect");
    expect(classifyRed(valid, { ok: false, errorCount: 0, diagnostics: ["tsc crashed"] })).toMatchObject({ code: 1, detail: { reason: "typecheck-failed" } });
  });
});

describe("generated laws are judged apart (ADR 2026-058)", () => {
  const LAWS = `${CONTEXT_SRC}/domain/notes/note.laws.test.ts`;
  const MINE = `${CONTEXT_SRC}/domain/notes/note.test.ts`;
  const isGenerated = (file: string): boolean => file.endsWith(".laws.test.ts");

  test("a law may pass against the skeletons: generated code runs before any skeleton does", () => {
    const r = classifyRed(run({ total: 2, passed: 1, failed: 1, results: [
      { name: "laws > refuses a non-object", status: "passed", file: LAWS },
      { name: "Note > equals", status: "failed", message: NI("Note.equals"), file: MINE },
    ] }), TYPE_CLEAN, undefined, isGenerated);
    expect(r).toMatchObject({ code: 0, verdict: "pass" });
    expect(r.lines[0]).toMatch(/1 NotImplemented failure, 0 passed, 1 total/);
  });

  test("a law failing for another reason, or skipping, blocks and routes to the architect", () => {
    const wrong = classifyGeneratedLaws([{ name: "laws > round-trips", status: "failed", message: "AssertionError: x", file: LAWS }]);
    expect(wrong).toMatchObject({ code: 1, detail: { reason: "generated-laws", route: "architect" } });
    const skipped = classifyRed(run({ total: 2, failed: 1, skipped: 1, results: [
      { name: "laws > parse accepts", status: "skipped", file: LAWS },
      { name: "Note > equals", status: "failed", message: NI("Note.equals"), file: MINE },
    ] }), TYPE_CLEAN, undefined, isGenerated);
    expect(skipped.lines).toContain("red-gate: route → architect");
    expect(skipped.lines.join("\n")).toContain("give the contract's value objects @accepts examples");
    expect(classifyGeneratedLaws([{ name: "x", status: "passed", file: LAWS }])).toBeUndefined();
  });

  test("a hand-written test still may not pass, and a result with no file is judged as hand-written", () => {
    const r = classifyRed(run({ total: 2, passed: 1, failed: 1, results: [
      { name: "mine passes", status: "passed" },
      { name: "laws", status: "failed", message: NI("x"), file: LAWS },
    ] }), TYPE_CLEAN, undefined, isGenerated);
    expect(r.detail).toMatchObject({ reason: "fully-green" });
  });
});

describe("skips a phase test policy asked for", () => {
  test("only the results a policy claims are set aside, and the tallies follow", () => {
    const raw = run({ total: 3, failed: 1, skipped: 2, results: [
      { name: "DrizzleCreateNoteStore > saves", status: "skipped" },
      { name: "Note > later", status: "skipped" },
      { name: "Note > equals", status: "failed", message: NI("Note.equals") },
    ] });
    const { run: kept, skipped } = withoutPolicySkips(raw, { skippedOnPurpose: (n) => n.startsWith("DrizzleCreateNoteStore") });
    expect(skipped).toEqual(["DrizzleCreateNoteStore > saves"]);
    expect(kept).toMatchObject({ total: 2, skipped: 1, failed: 1 });
    expect(withoutPolicySkips(raw, { skippedOnPurpose: () => false }).run).toBe(raw);
  });
});

describe("the test-side files a green is bound to (ADR 2026-057)", () => {
  test("every role-written test-side file under every source root, app tests included, generated laws excluded", () => {
    const f = notebook();
    const files = testSideFiles(f.dir);
    expect(files).toContain(`${CONTEXT_SRC}/domain/notes/note.test.ts`);
    expect(files).toContain(`${CONTEXT_SRC}/application/notes/create-note/create-note.store.test-support.ts`);
    expect(files).toContain("apps/web/src/server/composition-root.test.ts");
    expect(files.some((p) => p.endsWith(".laws.test.ts"))).toBe(false);
    expect(files).toEqual([...files].sort());
  });

  test("the hash is stable, moves with any test edit, rename or addition, and ignores CRLF churn and generated laws", () => {
    const f = notebook();
    const first = testFilesHash(f.dir);
    expect(testFilesHash(f.dir)).toBe(first);
    const test = join(f.dir, CONTEXT_SRC, "domain/notes/note.test.ts");
    const text = readFileSync(test, "utf8");
    writeFileSync(test, text.replaceAll("\n", "\r\n"));
    expect(testFilesHash(f.dir)).toBe(first);
    writeFileSync(test, `${text}// edited\n`);
    expect(testFilesHash(f.dir)).not.toBe(first);
    writeFileSync(test, text);
    writeFileSync(join(f.dir, CONTEXT_SRC, "domain/notes/note.laws.test.ts"), "// regenerated\n");
    expect(testFilesHash(f.dir)).toBe(first);
    writeFileSync(join(f.dir, "apps/web/src/server/extra.test.ts"), "// new\n");
    expect(testFilesHash(f.dir)).not.toBe(first);
  });

  test("red's before-hash is one list read from what the shadow copied: a test added or edited meanwhile is never recorded", () => {
    const f = notebook();
    const listed = testSideFiles(f.dir);
    const facts = projectFactsOf(f.dir, "red");
    const plan = redShadowPlan(f.dir, facts, emitProject(facts, generatedFileGlobs(f.dir)));
    const dir = materializeShadow(f.dir, plan);
    // Same files, same bytes: the before-hash IS the live hash.
    expect(redBeforeHash(f.dir, dir, listed, plan)).toBe(testFilesHash(f.dir));
    // A test added after the list was taken: the live after-hash moves.
    const late = join(f.dir, CONTEXT_SRC, "domain/notes/late.test.ts");
    writeFileSync(late, "// added during the run\n");
    expect(redBeforeHash(f.dir, dir, listed, plan)).not.toBe(testFilesHash(f.dir));
    rmSync(late);
    // A test edited after the copy: the before-hash keeps what ran.
    const test = join(f.dir, CONTEXT_SRC, "domain/notes/note.test.ts");
    const text = readFileSync(test, "utf8");
    writeFileSync(test, `${text}// edited after the copy\n`);
    expect(redBeforeHash(f.dir, dir, listed, plan)).not.toBe(testFilesHash(f.dir));
    writeFileSync(test, text);
    // An edit that landed BEFORE the copy but after the list is what ran: the
    // before-hash reads the copy, so it matches the live tree again.
    expect(redBeforeHash(f.dir, dir, listed, plan)).toBe(testFilesHash(f.dir));
  });

  test("an unreadable composition throws rather than hashing nothing", () => {
    const f = notebook();
    rmSync(join(f.dir, ".bounded/composed-packs.json"));
    expect(() => testFilesHash(f.dir)).toThrow(/composition/);
  });
});

describe("the shadow project", () => {
  function plan(f: Fixture) {
    const facts = projectFactsOf(f.dir, "red");
    return redShadowPlan(f.dir, facts, emitProject(facts, generatedFileGlobs(f.dir)));
  }

  test("copies contracts, the context's tests, generated files and config; never an implementation", () => {
    const f = notebook(["tests", "build"]);
    const { copy, workspaces } = plan(f);
    expect(copy).toContain(`${CONTEXT_SRC}/domain/notes/note.contract.ts`);
    expect(copy).toContain(`${CONTEXT_SRC}/domain/notes/note.test.ts`);
    expect(copy).toContain(`${CONTEXT_SRC}/application/notes/list-notes/list-notes.store.test-support.ts`);
    expect(copy).toContain(`${CONTEXT_SRC}/domain/index.ts`);
    expect(copy).toContain("package.json");
    for (const impl of ["domain/notes/note.ts", "application/notes/create-note/create-note.handler.ts", "adapters/out/in-memory/notes/create-note.store.ts"]) {
      expect(copy).not.toContain(`${CONTEXT_SRC}/${impl}`);
    }
    // The composition root is generated (ADR 2026-066), so it is copied like any generated file.
    expect(copy).toContain("apps/web/src/server/composition-root.ts");
    expect(workspaces).toEqual(["apps/web", "contexts/notebook"]);
  });

  test("an app's tests and root-level test files run at green only", () => {
    const f = notebook();
    writeFileSync(join(f.dir, "architecture.test.ts"), "// generated at the root\n");
    const { copy } = plan(f);
    expect(copy).not.toContain("apps/web/src/server/composition-root.test.ts");
    expect(copy).not.toContain("architecture.test.ts");
  });

  test("no tests in any context is not a red; no contract is nothing to run against", () => {
    const f = notebook([]);
    expect(() => plan(f)).toThrow(/no tests found in any context workspace/);
  });

  test("the builder's code never reaches the shadow: skeletons are emitted fresh over it", () => {
    const f = notebook(["tests", "build"]);
    const dir = materializeShadow(f.dir, plan(f));
    expect(dir).toBe(shadowProjectDir(f.dir));
    expect(dir.startsWith(join(f.dir, ".bounded"))).toBe(true);
    const handler = readFileSync(join(dir, CONTEXT_SRC, "application/notes/create-note/create-note.handler.ts"), "utf8");
    expect(handler).toContain('throw new NotImplementedError("CreateNoteHandler.execute")');
    expect(readFileSync(join(dir, CONTEXT_SRC, "domain/shared/errors.ts"), "utf8")).toContain("class NotImplementedError");
    // The live tree is untouched.
    expect(readFileSync(join(f.dir, CONTEXT_SRC, "application/notes/create-note/create-note.handler.ts"), "utf8")).not.toContain("NotImplementedError");
  });

  test("it is rebuilt from scratch on every run", () => {
    const f = notebook();
    const dir = materializeShadow(f.dir, plan(f));
    writeFileSync(join(dir, CONTEXT_SRC, "poison.ts"), "export const poison = true;\n");
    materializeShadow(f.dir, plan(f));
    expect(existsSync(join(dir, CONTEXT_SRC, "poison.ts"))).toBe(false);
  });

  test("dependency links point at the live store; workspace links, root and nested, point into the shadow", () => {
    const f = notebook();
    const store = join(f.dir, "node_modules/.bun/zod@4.0.0/node_modules/zod");
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "package.json"), "{}\n");
    symlinkSync(".bun/zod@4.0.0/node_modules/zod", join(f.dir, "node_modules/zod"));
    mkdirSync(join(f.dir, "node_modules/@demo"), { recursive: true });
    symlinkSync("../../contexts/notebook", join(f.dir, "node_modules/@demo/notebook"));
    mkdirSync(join(f.dir, "apps/web/node_modules/@demo"), { recursive: true });
    symlinkSync("../../../../contexts/notebook", join(f.dir, "apps/web/node_modules/@demo/notebook"));
    symlinkSync("../../../node_modules/.bun/zod@4.0.0/node_modules/zod", join(f.dir, "apps/web/node_modules/zod"));
    const dir = materializeShadow(f.dir, plan(f));

    expect(lstatSync(join(dir, "node_modules")).isSymbolicLink()).toBe(false);
    expect(realpathSync(join(dir, "node_modules/@demo/notebook"))).toBe(realpathSync(join(dir, "contexts/notebook")));
    expect(realpathSync(join(dir, "apps/web/node_modules/@demo/notebook"))).toBe(realpathSync(join(dir, "contexts/notebook")));
    expect(realpathSync(join(dir, "node_modules/zod"))).toBe(realpathSync(store));
    expect(realpathSync(join(dir, "apps/web/node_modules/zod"))).toBe(realpathSync(store));
    expect(readlinkSync(join(dir, "apps/web/node_modules/@demo/notebook"))).toBe("../../../../contexts/notebook");
    expect(shadowContamination(f.dir, dir, ["apps/web", "contexts/notebook"])).toEqual([]);
    // The wipe unlinks, never follows: the live store survives a rebuild.
    materializeShadow(f.dir, plan(f));
    expect(existsSync(join(store, "package.json"))).toBe(true);
  });

  test("a dependency-store link into a live workspace is refused: the shadow could not be isolated", () => {
    const f = notebook();
    mkdirSync(join(f.dir, "node_modules/.bun/node_modules/@demo"), { recursive: true });
    symlinkSync("../../../../contexts/notebook", join(f.dir, "node_modules/.bun/node_modules/@demo/notebook"));
    expect(() => materializeShadow(f.dir, plan(f))).toThrow(/would load live workspace code through node_modules\/\.bun\/node_modules\/@demo\/notebook/);
  });

  test("an absolute workspace link is re-pointed too", () => {
    const f = notebook();
    mkdirSync(join(f.dir, "node_modules/@demo"), { recursive: true });
    symlinkSync(join(f.dir, "contexts/notebook"), join(f.dir, "node_modules/@demo/notebook"));
    const dir = materializeShadow(f.dir, plan(f));
    expect(realpathSync(join(dir, "node_modules/@demo/notebook"))).toBe(realpathSync(join(dir, "contexts/notebook")));
  });
});

describe("the canned run the gate tests replay", () => {
  test("reads back through the real runner as bun's own report would", async () => {
    const f = notebook();
    const env = cannedGateEnv(f.dir, [
      { name: "Note > equals", status: "failed", message: NI("Note.equals") },
      { name: "laws > x", status: "passed", file: `${CONTEXT_SRC}/domain/notes/note.laws.test.ts` },
    ]);
    const result = await runTests(f.dir, { command: env.BOUNDED_GATE_TEST_CMD, args: JSON.parse(env.BOUNDED_GATE_TEST_ARGS!) as string[] });
    expect(result.results).toEqual([
      { name: "Note > equals", status: "failed", message: NI("Note.equals"), file: "contexts/notebook/src/x.test.ts" },
      { name: "laws > x", status: "passed", file: `${CONTEXT_SRC}/domain/notes/note.laws.test.ts` },
    ]);
    expect(cannedRun([]).xml).toContain("<testsuites");
  });
});

describe("runRedGate on the monorepo (canned suite)", () => {
  const RIGHT = [
    { name: "NoteText > parses", status: "failed" as const, message: NI("NoteText.parse") },
    { name: "laws > refuses a non-object", status: "passed" as const, file: `${CONTEXT_SRC}/application/notes/create-note/create-note.command.laws.test.ts` },
  ];

  test("a right-reason red passes and records the contracts and test files it was measured over", async () => {
    const f = notebook(["tests", "half"]);
    const result = await withEnv(cannedGateEnv(f.dir, RIGHT), () => runRedGate(f.dir));
    expect(result).toMatchObject({ code: 0, verdict: "pass" });
    const event = readGuardLog(f.dir).filter((e) => e.guard === "red-gate").at(-1)!;
    expect(event).toMatchObject({ verdict: "pass", detail: { shadow: SHADOW_RELATIVE, contracts: 5, testFilesHash: testFilesHash(f.dir) } });
    expect(Object.keys((event.detail as { contractManifest: object }).contractManifest)).toHaveLength(5);
  });

  test("a wrong-reason failure blocks and is logged, routed to the test-writer", async () => {
    const f = notebook();
    const result = await withEnv(cannedGateEnv(f.dir, [{ name: "Note > equals", status: "failed", message: "AssertionError: expected true" }]), () => runRedGate(f.dir));
    expect(result.code).toBe(1);
    expect(result.lines).toContain("red-gate: route → test-writer");
    expect(readGuardLog(f.dir).filter((e) => e.guard === "red-gate").at(-1)).toMatchObject({ verdict: "block", detail: { reason: "wrong-reason" } });
  });

  test("a valid red with a type error in a test file blocks (#7)", async () => {
    const f = notebook();
    const env = cannedGateEnv(f.dir, RIGHT, { output: `${TEST_TYPE_ERR}\n`, code: 2 });
    const result = await withEnv(env, () => runRedGate(f.dir));
    expect(result.lines[0]).toMatch(/1 type error/);
    expect(result.lines).toContain("red-gate: route → test-writer");
  });

  test("a valid red that leaves a test obligation unmet blocks, naming the file to write", async () => {
    const f = notebook();
    rmSync(join(f.dir, CONTEXT_SRC, "adapters/out/in-memory/notes/list-notes.store.test.ts"));
    const result = await withEnv(cannedGateEnv(f.dir, RIGHT), () => runRedGate(f.dir));
    expect(result).toMatchObject({ code: 1, detail: { reason: "obligations", route: "test-writer" } });
    expect(result.lines.join("\n")).toContain("InMemoryListNotesStore has no store test");
  });

  test("an escape hatch in a test helper blocks an otherwise valid red", async () => {
    const f = notebook();
    const test = join(f.dir, CONTEXT_SRC, "domain/notes/note.test.ts");
    writeFileSync(test, readFileSync(test, "utf8").replace("return parsed.value;", "return parsed.value!;"));
    const result = await withEnv(cannedGateEnv(f.dir, RIGHT), () => runRedGate(f.dir));
    expect(result).toMatchObject({ code: 1, detail: { reason: "test-escape-hatches" } });
  });

  test("a project whose design cannot be emitted is an error, not a verdict", async () => {
    const f = notebook();
    writeFileSync(join(f.dir, CONTEXT_SRC, "application/notes/list-notes/list-notes.contract.ts"), "export interface Broken {}\n");
    const result = await withEnv(cannedGateEnv(f.dir, RIGHT), () => runRedGate(f.dir));
    expect(result).toMatchObject({ code: 2, verdict: "error", detail: { reason: "shadow-project" } });
  });
});

// Issue #36: in the 2026-10-01 dogfood red refused eight tests of a generated
// command's parse as "passed against unimplemented skeleton", with nothing to
// say why or what to do; and the test lint's refusals only showed on a red
// that was otherwise valid.
describe("tests of generated code, and the test lint, at red", () => {
  const SPURIOUS = classifyRed(run({ total: 2, passed: 1, failed: 1, results: [
    { name: "CreateNoteCommand.parse > refuses a number", status: "passed" },
    { name: "b", status: "failed", message: NI("b") },
  ] }), TYPE_CLEAN);
  const ONLY = [{ name: "CreateNoteCommand.parse > refuses a number", subjects: ["CreateNoteCommand from ./create-note.command.ts"] }];
  const VALID = classifyRed(run({ total: 1, failed: 1, results: [{ name: "b", status: "failed", message: NI("b") }] }), TYPE_CLEAN);
  const CREATE_NOTE_TEST = `${CONTEXT_SRC}/application/notes/create-note/create-note.test.ts`;
  const RIGHT = [{ name: "NoteText > parses", status: "failed" as const, message: NI("NoteText.parse") }];

  test("a spurious pass that exercises only generated code says so and says to remove it; the route stays the test-writer's", () => {
    const r = withGeneratedOnly(SPURIOUS, ONLY);
    expect(r.lines.at(-1)).toBe("red-gate: route → test-writer");
    expect(r.lines.join("\n")).toMatch(/1 of the passing tests exercises only generated code\..*Remove these tests; do not rewrite them to fail/);
    expect(r.lines).toContain("  only generated code: CreateNoteCommand.parse > refuses a number (CreateNoteCommand from ./create-note.command.ts)");
    expect(r.detail).toMatchObject({ reason: "spurious-pass", route: "test-writer", generatedOnly: [ONLY[0]!.name] });
    expect(r.summary).toMatch(/1 exercises only generated code$/);
  });

  test("anything else is left as it was", () => {
    expect(withGeneratedOnly(SPURIOUS, [])).toBe(SPURIOUS);
    expect(withGeneratedOnly(VALID, ONLY)).toBe(VALID);
  });

  const lint = (ruleId: string) => ({
    code: 1 as const,
    summary: "1 problem in 3 files",
    lines: [`x.test.ts:1:1  ${ruleId}  the fix`, "lint-src: 1 problem in 3 files"],
    detail: { problems: [{ filePath: "x.test.ts", line: 1, column: 1, ruleId, message: "the fix" }] },
  });

  test("a valid red the test lint refuses blocks, naming each fix; escape hatches keep their own reason", () => {
    const imports = withTestLint(VALID, lint("bounded-ts-hexagonal/test-imports"));
    expect(imports).toMatchObject({ code: 1, detail: { reason: "test-lint", route: "test-writer" } });
    expect(imports.lines).toContain("x.test.ts:1:1  bounded-ts-hexagonal/test-imports  the fix");
    expect(imports.lines.join("\n")).not.toMatch(/non-null assertion/);
    expect(withTestLint(VALID, lint("@typescript-eslint/no-explicit-any")).detail).toMatchObject({ reason: "test-escape-hatches" });
  });

  test("a red already refused for the test-writer carries the lint's lines too, before the route", () => {
    const r = withTestLint(SPURIOUS, lint("bounded-ts/no-generated-subject"));
    expect(r.detail).toMatchObject({ reason: "spurious-pass", route: "test-writer" });
    expect(r.lines.at(-1)).toBe("red-gate: route → test-writer");
    expect(r.lines).toContain("x.test.ts:1:1  bounded-ts/no-generated-subject  the fix");
  });

  test("a red routed upstream keeps its owner, and carries the lint's lines marked for the test-writer after that owner", () => {
    const upstream = classifyRed(run({ total: 1, failed: 1, results: [{ name: "b", status: "failed", message: NI("b") }] }), tsc(CONTRACT_TYPE_ERR), TS_ZONE);
    expect(upstream.detail.route).toBe("architect");
    const r = withTestLint(upstream, lint("bounded-ts/no-generated-subject"));
    expect(r.detail.route).toBe("architect");
    expect(r.lines.at(-1)).toBe("red-gate: route → architect");
    expect(r.lines).toContain("x.test.ts:1:1  bounded-ts/no-generated-subject  the fix");
    expect(r.lines.join("\n")).toMatch(/for the test-writer, after the architect's fix above: the test lint also refused/);
  });

  test("a fully green suite whose tests exercise only generated code is explained too", () => {
    const green = classifyRed(run({ total: 1, passed: 1, results: [{ name: ONLY[0]!.name, status: "passed" }] }), TYPE_CLEAN);
    expect(green.detail.reason).toBe("fully-green");
    const r = withGeneratedOnly(green, ONLY);
    expect(r.lines).toContain(`  only generated code: ${ONLY[0]!.name} (CreateNoteCommand from ./create-note.command.ts)`);
    expect(r.detail).toMatchObject({ reason: "fully-green", route: "test-writer", generatedOnly: [ONLY[0]!.name] });
  });

  test("a test the generated-only explanation lists is not listed again among the lint's lines", () => {
    const listed = withGeneratedOnly(SPURIOUS, [{ ...ONLY[0]!, at: "x.test.ts:1" }]);
    const same = withTestLint(listed, lint("bounded-ts/no-generated-subject"));
    expect(same).toBe(listed);
    const other = withTestLint(listed, {
      ...lint("bounded-ts/no-generated-subject"),
      lines: ["x.test.ts:1:1  bounded-ts/no-generated-subject  the fix", "x.test.ts:9:1  bounded-ts/no-generated-subject  the fix", "lint-src: 2 problems"],
    });
    expect(other.lines.filter((l) => l.includes("no-generated-subject  "))).toEqual(["x.test.ts:9:1  bounded-ts/no-generated-subject  the fix"]);
  });

  test("end to end: red names the generated-only passes and the lint refusals, routed to the test-writer", async () => {
    const f = notebook();
    writeFileSync(join(f.dir, CREATE_NOTE_TEST), `${readFileSync(join(f.dir, CREATE_NOTE_TEST), "utf8")}
describe("CreateNoteCommand.parse", () => {
  test("refuses a number", () => {
    expect(CreateNoteCommand.parse(1).ok).toBe(false);
  });
});
`);
    const cases = [...RIGHT, { name: "CreateNoteCommand.parse > refuses a number", status: "passed" as const, file: CREATE_NOTE_TEST }];
    const result = await withEnv(cannedGateEnv(f.dir, cases), () => runRedGate(f.dir));
    expect(result).toMatchObject({
      code: 1,
      detail: { reason: "spurious-pass", route: "test-writer", generatedOnly: ["CreateNoteCommand.parse > refuses a number"] },
    });
    expect(result.lines).toContain(
      "  only generated code: CreateNoteCommand.parse > refuses a number (CreateNoteCommand from ./create-note.command.ts)",
    );
    // The test lint refused the same test; it is said once, not twice.
    expect(result.lines.filter((l) => l.includes("refuses a number") || l.includes("bounded-ts/no-generated-subject"))).toHaveLength(1);
    expect(result.lines.at(-1)).toBe("red-gate: route → test-writer");
  });

  test("end to end: a passing test that reaches the handler is not called generated-only", async () => {
    const f = notebook();
    const cases = [...RIGHT, { name: "CreateNoteHandler > creates the note and saves it", status: "passed" as const, file: CREATE_NOTE_TEST }];
    const result = await withEnv(cannedGateEnv(f.dir, cases), () => runRedGate(f.dir));
    expect(result.detail).toMatchObject({ reason: "spurious-pass" });
    expect(result.detail.generatedOnly).toBeUndefined();
  });
});
