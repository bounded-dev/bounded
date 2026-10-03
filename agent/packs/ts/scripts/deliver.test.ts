import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { readGuardLog } from "../../../src/guard-log.ts";
import { generatedFileGlobs } from "../../../src/pack-contrib.ts";
import type { PhaseDurations } from "../../../src/phase-durations.ts";
import { writeProjectPacks } from "../../../src/project-composition.ts";
import { checkSummaryLine, runDeliver, SURFACE_SCRIPT } from "./deliver.ts";
import type { CommandOutcome, CommandRun } from "./deliver.ts";
import { emitProject, projectFactsOf } from "./project-emitters.ts";
import { writeEmittedFiles } from "./scaffold-project.ts";

// Delivery on the hexagonal monorepo (TN-26-012). Every fixture is a small
// project built from the pipeline fixture's design (one context, `notebook`,
// with three concepts and two features), emitted at phase `red` exactly as the
// design gate scaffolds it, then implemented by the builder's files.

const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const FIXTURE = join(import.meta.dirname, "testdata", "pipeline");
const SCOPE = "@fixture";
const ERRORS = "contexts/notebook/src/domain/shared/errors.ts";
const NOTE_TEXT = "contexts/notebook/src/domain/notes/note-text.ts";
const TS_MORPH_PIN = (JSON.parse(readFileSync(join(import.meta.dirname, "../../../package.json"), "utf8")) as {
  dependencies: Record<string, string>;
}).dependencies["ts-morph"]!;

/** One part of the pipeline fixture (`design`, `tests`, `build`), project-relative
 *  path → content, scoped to `@fixture`. Apps and TNs are left out: these
 *  fixtures compose no app pack. */
function fixturePart(part: string, keepExposure: boolean): Record<string, string> {
  const root = join(FIXTURE, part);
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const rel = relative(root, full).split("\\").join("/").replace(/\.txt$/, "");
        if (!rel.startsWith("contexts/")) continue;
        let text = readFileSync(full, "utf8").replaceAll("{{scope}}", SCOPE);
        if (!keepExposure) text = text.split("\n").filter((l) => !/^\s*\*\s*@exposedVia\b/.test(l)).join("\n");
        out[rel] = text;
      }
    }
  };
  walk(root);
  return out;
}

function write(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
}

const PACKAGE_JSON = JSON.stringify({
  name: "fixture",
  private: true,
  type: "module",
  workspaces: ["contexts/*", "apps/*"],
  scripts: { check: "bun test && bun run check:surface", "check:surface": SURFACE_SCRIPT },
  devDependencies: { "ts-morph": TS_MORPH_PIN, typescript: "5.9.3" },
}, null, 2) + "\n";

interface ProjectOptions {
  readonly packs?: readonly string[];
  /** Overlay the builder's implementation (default true). */
  readonly implemented?: boolean;
  /** Overlay the test-writer's files (default true). */
  readonly tests?: boolean;
  /** Pretend ts-morph is installed (default true). */
  readonly tsMorph?: boolean;
  readonly extra?: Record<string, string>;
}

/** A finished run on the monorepo: design, emitted files, tests, implementation. */
function proj(options: ProjectOptions = {}): string {
  const packs = options.packs ?? ["ts", "ts-hexagonal"];
  const keepExposure = packs.includes("ts-trpc");
  const dir = mkdtempSync(join(tmpdir(), "pi-deliver-"));
  tmpDirs.push(dir);
  writeProjectPacks(dir, packs);
  write(dir, { "package.json": PACKAGE_JSON, ".gitignore": "node_modules/\n", ...fixturePart("design", keepExposure) });
  writeEmittedFiles(dir, emitProject(projectFactsOf(dir, "red"), generatedFileGlobs(dir)));
  if (options.tests ?? true) write(dir, fixturePart("tests", keepExposure));
  if (options.implemented ?? true) write(dir, fixturePart("build", keepExposure));
  if (options.tsMorph ?? true) write(dir, { "node_modules/ts-morph/package.json": '{"name":"ts-morph"}\n' });
  write(dir, options.extra ?? {});
  return dir;
}

const SURFACE_STUB = "// stub surface checker (the real one ships from the pack)\n";

function surfaceStub(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-deliver-stub-"));
  tmpDirs.push(dir);
  const path = join(dir, "surface-check.ts");
  writeFileSync(path, SURFACE_STUB);
  return path;
}

/** A passing `bun run check`, shaped like the real thing. */
const CHECK_OK: CommandOutcome = {
  code: 0,
  stdout: "bun test v1.3.14\n\n 58 pass\n 0 fail\nRan 58 tests across 15 files. [146.00ms]\n$ bun scripts/surface-check.ts\nsurface-check: OK (5 contract pairs)\n",
  stderr: "",
};

interface Call {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** Did the red-phase errors module still exist when this call was made? */
  readonly errorsPresent: boolean;
}

interface FakeBunOptions {
  readonly install?: CommandOutcome;
  /** Should a "successful" `bun add` create node_modules/<pkg>? */
  readonly materialize?: boolean;
  readonly check?: CommandOutcome;
}

/** bun, faked at the seam deliver spawns through. */
function fakeBun(options: FakeBunOptions = {}): { calls: Call[]; run: CommandRun } {
  const calls: Call[] = [];
  const run: CommandRun = (command, args, cwd) => {
    calls.push({ command, args: [...args], cwd, errorsPresent: existsSync(join(cwd, ERRORS)) });
    if (args[0] === "add") {
      const outcome = options.install ?? { code: 0, stdout: "installed ts-morph\n", stderr: "" };
      if (outcome.code === 0 && (options.materialize ?? true)) {
        const spec = args[args.length - 1] ?? "ts-morph";
        const name = spec.split("@")[0] ?? spec;
        mkdirSync(join(cwd, "node_modules", name), { recursive: true });
        writeFileSync(join(cwd, "node_modules", name, "package.json"), JSON.stringify({ name }) + "\n");
      }
      return outcome;
    }
    return options.check ?? CHECK_OK;
  };
  return { calls, run };
}

function deliver(cwd: string, options: FakeBunOptions = {}) {
  return runDeliver(cwd, { surfaceCheckSource: surfaceStub(), run: fakeBun(options).run });
}

const text = (lines: readonly string[]): string => lines.join("\n");

const guardLog = (events: readonly Record<string, unknown>[]): string => events.map((e) => JSON.stringify(e)).join("\n") + "\n";

const SEEDED_GUARD_LOG = guardLog([
  { ts: "2026-03-01T09:00:00.000Z", guard: "contract-purity", verdict: "pass", summary: "OK (1 file)" },
  { ts: "2026-03-01T09:04:00.000Z", guard: "checksum-gate", verdict: "pass", summary: "wrote manifest (1 contract file)" },
  {
    ts: "2026-03-01T09:12:00.000Z", guard: "red-gate", verdict: "block",
    summary: "2 wrong-reason failures (route: test-writer)", detail: { reason: "wrong-reason", route: "test-writer" },
  },
  { ts: "2026-03-01T09:20:00.000Z", guard: "red-gate", verdict: "pass", summary: "RED OK (5 NotImplemented failures, 0 passed)" },
  { ts: "2026-03-01T09:48:00.000Z", guard: "green-gate", verdict: "pass", summary: "GREEN (5/5 passed, typecheck clean)" },
]);

const FRICTION_GUARD_LOG = guardLog([
  { ts: "2026-03-01T09:00:00.000Z", guard: "contract-purity", verdict: "pass", summary: "OK (1 file)" },
  { ts: "2026-03-01T09:01:00.000Z", guard: "path-gate", verdict: "block", summary: "architect may not write x.ts" },
  { ts: "2026-03-01T09:02:00.000Z", guard: "phase-gate", verdict: "block", summary: "test-writer may not spawn yet" },
  { ts: "2026-03-01T09:04:00.000Z", guard: "checksum-gate", verdict: "pass", summary: "wrote manifest (1 contract file)" },
  { ts: "2026-03-01T09:20:00.000Z", guard: "red-gate", verdict: "pass", summary: "RED OK (5 NotImplemented failures, 0 passed)" },
  { ts: "2026-03-01T09:30:00.000Z", guard: "path-gate", verdict: "block", summary: "builder may not write y.test.ts" },
  { ts: "2026-03-01T09:40:00.000Z", guard: "green-gate", verdict: "block", summary: "1 failing test (route: builder)", detail: { route: "builder" } },
  { ts: "2026-03-01T09:48:00.000Z", guard: "green-gate", verdict: "pass", summary: "GREEN (5/5 passed, typecheck clean)" },
]);

function blockEvent(dir: string): { step?: string; route?: string } | undefined {
  return readGuardLog(dir).find((e) => e.guard === "deliver" && e.verdict === "block")?.detail as { step?: string; route?: string } | undefined;
}

// --- the whole pass ----------------------------------------------------------------

describe("runDeliver on the monorepo", () => {
  test("full pass on a finished run: every step reports, exit 0, summary line", async () => {
    const dir = proj();
    const bun = fakeBun();
    const r = await runDeliver(dir, { surfaceCheckSource: surfaceStub(), run: bun.run });
    expect(r.code, text(r.lines)).toBe(0);
    expect(r.lines).toContain(`deliver: scaffolding — removed ${ERRORS} (nothing imports it)`);
    expect(existsSync(join(dir, ERRORS))).toBe(false);
    expect(text(r.lines)).toMatch(/^deliver: generated — \d+ generated files in sync; no skeleton left unimplemented$/m);
    expect(r.lines).toContain("deliver: surface-check — shipped scripts/surface-check.ts");
    expect(readFileSync(join(dir, "scripts/surface-check.ts"), "utf8")).toBe(SURFACE_STUB);
    expect(r.lines).toContain("deliver: gitignore — added .bounded/ to .gitignore");
    expect(r.lines).toContain('deliver: readme — created README.md with a "## Contracts" section');
    expect(readFileSync(join(dir, "README.md"), "utf8")).toContain("<feature>.handler.ts");
    expect(r.lines.at(-1)).toMatch(/^deliver: OK — \d+ steps applied$/);
    // no install was needed; the project's own check ran once, on the delivered tree
    expect(bun.calls.map((c) => c.args)).toEqual([["run", "check"]]);
    expect(bun.calls[0]!.errorsPresent).toBe(false);
    expect(bun.calls[0]!.cwd).toBe(dir);
  });

  test("idempotent: the second run applies 0 steps and changes no file", async () => {
    const dir = proj();
    const stub = surfaceStub();
    await runDeliver(dir, { surfaceCheckSource: stub, run: fakeBun().run });
    const snapshot = ["package.json", "README.md", ".gitignore", "scripts/surface-check.ts"].map((f) => readFileSync(join(dir, f), "utf8"));
    const second = await runDeliver(dir, { surfaceCheckSource: stub, run: fakeBun().run });
    expect(second.code).toBe(0);
    expect(second.lines.at(-1)).toBe("deliver: OK — 0 steps applied");
    expect(second.lines).toContain("deliver: scaffolding — no red-phase module left");
    expect(["package.json", "README.md", ".gitignore", "scripts/surface-check.ts"].map((f) => readFileSync(join(dir, f), "utf8"))).toEqual(snapshot);
  });

  test("appends to an existing README rather than clobbering it", async () => {
    const dir = proj({ extra: { "README.md": "# Fixture\n\nOur notes app.\n" } });
    await deliver(dir);
    const readme = readFileSync(join(dir, "README.md"), "utf8");
    expect(readme.startsWith("# Fixture\n\nOur notes app.\n")).toBe(true);
    expect(readme).toContain("## Contracts");
  });

  test("preserves a project-local harness ignore rule and its committed exceptions", async () => {
    const ignore = ".bounded/*\n!.bounded/harness/\n";
    const dir = proj({ extra: { ".gitignore": ignore } });
    const r = await deliver(dir);
    expect(r.lines).toContain("deliver: gitignore — .bounded/ already ignored");
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(ignore);
  });
});

// --- 1. red-phase scaffolding ---------------------------------------------------------

describe("runDeliver: the red-phase errors module", () => {
  test("BLOCK when a source file still imports it — an unimplemented skeleton, routed to the builder", async () => {
    // The builder never replaced NoteText's skeleton.
    const dir = proj();
    const skeleton = emitProject(projectFactsOf(dir, "red"), generatedFileGlobs(dir)).find((f) => f.path === NOTE_TEXT)!;
    writeFileSync(join(dir, NOTE_TEXT), skeleton.content);
    const r = await deliver(dir);
    expect(r.code).toBe(1);
    // The throwing-skeleton check runs before anything mutates, so it names it first.
    expect(r.lines).toContain(`deliver: BLOCK — ${NOTE_TEXT} still throws NotImplementedError — a skeleton the builder never finished`);
    expect(r.lines).toContain("deliver: route → builder");
    expect(existsSync(join(dir, ERRORS))).toBe(true);
    expect(blockEvent(dir)).toMatchObject({ step: "generated", route: "builder" });
  });

  test("BLOCK when a test imports it — the suite may not depend on red-phase scaffolding", async () => {
    const test = "contexts/notebook/src/domain/notes/red.test.ts";
    const dir = proj({ extra: { [test]: 'import { NotImplementedError } from "../shared/errors.ts";\nexport const E = NotImplementedError;\n' } });
    const r = await deliver(dir);
    expect(r.code).toBe(1);
    expect(text(r.lines)).toContain(`deliver: BLOCK — ${test} imports the red-phase errors module`);
    expect(r.lines).toContain("deliver: route → test-writer");
    expect(existsSync(join(dir, ERRORS))).toBe(true);
  });

  test("a mention of the module in a comment or a string is not an import", async () => {
    const dir = proj({ extra: { "contexts/notebook/src/domain/notes/note.mapper.ts": '// see ../shared/errors.ts\nexport const where = "../shared/errors.ts";\n' } });
    expect((await deliver(dir)).code).toBe(0);
    expect(existsSync(join(dir, ERRORS))).toBe(false);
  });
});

// --- 2. the shadow ---------------------------------------------------------------------

describe("runDeliver: the red-phase shadow", () => {
  test("removes .bounded/shadow-red/, says so, and logs it as its own event", async () => {
    const dir = proj({ extra: { ".bounded/shadow-red/contexts/x.ts": "export {};\n" } });
    const r = await deliver(dir);
    expect(r.lines).toContain("deliver: shadow — removed .bounded/shadow-red/ (red_gate rebuilds it on demand)");
    expect(existsSync(join(dir, ".bounded/shadow-red"))).toBe(false);
    expect(readGuardLog(dir).some((e) => e.guard === "deliver" && (e.detail as { step?: string }).step === "shadow")).toBe(true);
  });

  test("no shadow is no step, and the rest of .bounded/ survives", async () => {
    const dir = proj({ extra: { ".bounded/guard-log.jsonl": SEEDED_GUARD_LOG } });
    const r = await deliver(dir);
    expect(r.lines).toContain("deliver: shadow — no .bounded/shadow-red/ to remove");
    expect(existsSync(join(dir, ".bounded/composed-packs.json"))).toBe(true);
    expect(existsSync(join(dir, ".bounded/guard-log.jsonl"))).toBe(true);
  });
});

// --- 3. generated files ---------------------------------------------------------------

describe("runDeliver: generated files and skeletons", () => {
  test("BLOCK when a generated file differs from what the design produces, routed to the orchestrator", async () => {
    const barrel = "contexts/notebook/src/domain/index.ts";
    const dir = proj();
    writeFileSync(join(dir, barrel), readFileSync(join(dir, barrel), "utf8") + "export const extra = 1;\n");
    const r = await deliver(dir);
    expect(r.code).toBe(1);
    expect(text(r.lines)).toContain(`1 generated file is not what the design produces (${barrel})`);
    expect(r.lines).toContain("deliver: route → orchestrator");
    expect(blockEvent(dir)).toMatchObject({ step: "generated", route: "orchestrator" });
  });

  test("BLOCK when an app's generated composition root is edited (ADR 2026-067)", async () => {
    const root = "apps/web/src/server/composition-root.ts";
    const dir = proj({ packs: ["ts", "ts-hexagonal", "ts-trpc", "ts-web"] });
    // Declare the fixture's web app, then emit again as the design gate would.
    write(dir, { "docs/tn/TN-1.md": readFileSync(join(FIXTURE, "design", "docs", "tn", "TN-1.md.txt"), "utf8") });
    writeEmittedFiles(dir, emitProject(projectFactsOf(dir, "red"), generatedFileGlobs(dir)));
    const generated = readFileSync(join(dir, root), "utf8");
    expect(generated).toContain("      create: new CreateNoteHandler(new InMemoryCreateNoteStore(db)),\n");
    // A builder's "improvement": a second database for one store.
    writeFileSync(join(dir, root), generated.replace("new InMemoryCreateNoteStore(db)", "new InMemoryCreateNoteStore(new InMemoryDatabase())"));
    const r = await deliver(dir);
    expect(r.code).toBe(1);
    expect(text(r.lines)).toContain(`1 generated file is not what the design produces (${root})`);
    expect(blockEvent(dir)).toMatchObject({ step: "generated", route: "orchestrator" });
  });

  test("a missing generated file blocks too", async () => {
    const laws = "contexts/notebook/src/domain/notes/note-text.laws.test.ts";
    const dir = proj();
    rmSync(join(dir, laws));
    const r = await deliver(dir);
    expect(r.code).toBe(1);
    expect(text(r.lines)).toContain(laws);
  });

  test("BLOCK when a skeleton still throws NotImplementedError after its module is gone", async () => {
    // A first delivery removed the errors module; the builder then reverts a
    // file to its skeleton. Step 1 has nothing to find; step 3 still does.
    const dir = proj();
    expect((await deliver(dir)).code).toBe(0);
    const skeleton = emitProject(projectFactsOf(dir, "red"), generatedFileGlobs(dir)).find((f) => f.path === NOTE_TEXT)!;
    writeFileSync(join(dir, NOTE_TEXT), skeleton.content);
    const r = await deliver(dir);
    expect(r.code).toBe(1);
    expect(r.lines).toContain(`deliver: BLOCK — ${NOTE_TEXT} still throws NotImplementedError — a skeleton the builder never finished`);
    expect(r.lines).toContain("deliver: route → builder");
  });

  test("BLOCK when the design cannot be emitted", async () => {
    const dir = proj({ extra: { "contexts/notebook/src/domain/notes/broken.contract.ts": "export interface Broken { readonly __brand: \"Broken\"; }\nexport interface BrokenFactory {}\n" } });
    const r = await deliver(dir);
    expect(r.code).toBe(1);
    expect(text(r.lines)).toMatch(/deliver: BLOCK — the design cannot be emitted: /);
    expect(existsSync(join(dir, ERRORS))).toBe(true);
  });
});

// --- 4. the surface check ----------------------------------------------------------------

describe("runDeliver: the shipped surface check must actually resolve", () => {
  test("installs the pinned ts-morph with bun, exactly that dependency, in the target", async () => {
    const dir = proj({ tsMorph: false });
    const bun = fakeBun();
    const r = await runDeliver(dir, { surfaceCheckSource: surfaceStub(), run: bun.run });
    expect(r.code, text(r.lines)).toBe(0);
    const install = bun.calls.find((c) => c.args[0] === "add")!;
    expect(install.command).toBe("bun");
    expect(install.args).toEqual(["add", "--dev", "--exact", "--ignore-scripts", `ts-morph@${TS_MORPH_PIN}`]);
    expect(install.cwd).toBe(dir);
    expect(text(r.lines)).toContain(`installed ts-morph@${TS_MORPH_PIN}`);
  });

  test("wires check:surface and pins ts-morph where the manifest lacks them", async () => {
    const dir = proj({ extra: { "package.json": JSON.stringify({ name: "fixture", private: true, type: "module", workspaces: ["contexts/*"], scripts: { check: "bun test" } }) } });
    const r = await deliver(dir);
    expect(r.code, text(r.lines)).toBe(0);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.scripts["check:surface"]).toBe(SURFACE_SCRIPT);
    expect(pkg.scripts.check).toBe("bun test && bun run check:surface");
    expect(pkg.devDependencies["ts-morph"]).toBe(TS_MORPH_PIN);
  });

  test("BLOCK when the install fails — no repo ships with a check that cannot run", async () => {
    const dir = proj({ tsMorph: false });
    const bun = fakeBun({ install: { code: 1, stdout: "", stderr: "error: ConnectionRefused downloading package manifest ts-morph" } });
    const r = await runDeliver(dir, { surfaceCheckSource: surfaceStub(), run: bun.run });
    expect(r.code).toBe(1);
    expect(text(r.lines)).toMatch(/^deliver: BLOCK — could not install ts-morph@/m);
    expect(text(r.lines)).toContain("ERR_MODULE_NOT_FOUND");
    expect(r.lines).toContain("  install: error: ConnectionRefused downloading package manifest ts-morph");
    expect(bun.calls.map((c) => c.args[0])).toEqual(["add"]);
    expect(blockEvent(dir)?.step).toBe("surface-check");
  });

  test("BLOCK when bun claims success but ts-morph still does not resolve", async () => {
    const dir = proj({ tsMorph: false });
    const r = await deliver(dir, { materialize: false });
    expect(r.code).toBe(1);
    expect(text(r.lines)).toMatch(/could not install ts-morph@/);
  });

  test("misuse: a missing surface checker source is exit 2, before any mutation", async () => {
    const dir = proj();
    const r = await runDeliver(dir, { surfaceCheckSource: join(dir, "nope.ts"), run: fakeBun().run });
    expect(r.code).toBe(2);
    expect(existsSync(join(dir, ERRORS))).toBe(true);
  });
});

describe("runDeliver: the project's own check runs under the green policies", () => {
  test("its environment carries the throwaway database over an inherited DATABASE_URL, released after", async () => {
    const dir = proj();
    const envs: (string | undefined)[] = [];
    const events: string[] = [];
    const prior = process.env["DATABASE_URL"];
    process.env["DATABASE_URL"] = "postgres://me@localhost:5432/mine";
    try {
      const r = await runDeliver(dir, {
        surfaceCheckSource: surfaceStub(),
        run: (command, args, cwd, env) => {
          if (args[0] === "run") { envs.push(env?.["DATABASE_URL"]); events.push("check"); }
          return fakeBun().run(command, args, cwd, env);
        },
        policy: { refusals: [], env: { set: {}, unset: [] }, prepares: [{ name: "db", prepare: async () => {
          events.push("start");
          return { description: "started a throwaway database", env: { DATABASE_URL: "postgres://throwaway" }, release: () => void events.push("release") };
        } }] },
      });
      expect(r.code, text(r.lines)).toBe(0);
      expect(r.lines).toContain("deliver: check — started a throwaway database");
    } finally {
      if (prior === undefined) delete process.env["DATABASE_URL"];
      else process.env["DATABASE_URL"] = prior;
    }
    expect(envs).toEqual(["postgres://throwaway"]);
    expect(events).toEqual(["start", "check", "release"]);
  });

  test("a refusal (no container runtime) blocks the check without running it", async () => {
    const dir = proj();
    const bun = fakeBun();
    const r = await runDeliver(dir, {
      surfaceCheckSource: surfaceStub(), run: bun.run,
      policy: { refusals: ["green needs a container runtime … Start Docker"], env: { set: {}, unset: [] }, prepares: [] },
    });
    expect(r.code).toBe(1);
    expect(text(r.lines)).toMatch(/cannot run here: green needs a container runtime … Start Docker/);
    expect(bun.calls.some((c) => c.args[0] === "run")).toBe(false);
  });
});

// --- misuse and config ---------------------------------------------------------------------

describe("runDeliver: preconditions", () => {
  test("a target with no package.json is misuse", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-deliver-empty-"));
    tmpDirs.push(dir);
    expect((await deliver(dir)).code).toBe(2);
  });

  test("a composition with no source roots is misuse", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-deliver-flat-"));
    tmpDirs.push(dir);
    writeProjectPacks(dir, ["ts"]);
    writeFileSync(join(dir, "package.json"), PACKAGE_JSON);
    const r = await deliver(dir);
    expect(r.code).toBe(2);
    expect(text(r.lines)).toContain("no composed pack declares source roots");
  });

  test("an unreadable composition is misuse", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-deliver-nocomp-"));
    tmpDirs.push(dir);
    writeFileSync(join(dir, "package.json"), PACKAGE_JSON);
    expect((await deliver(dir)).code).toBe(2);
  });

  test("a project whose config the packs generate is refused while it drifts, before anything mutates", async () => {
    const dir = proj({ extra: { ".bounded/installation.json": "{}\n" } });
    const r = await deliver(dir);
    expect(r.code).toBe(1);
    expect(text(r.lines)).toContain("deliver: BLOCK — project config differs");
    expect(existsSync(join(dir, ERRORS))).toBe(true);
  });
});

// --- 7. timing -------------------------------------------------------------------------

describe("runDeliver: phase timing", () => {
  test("prints the phase block from the project's own guard log", async () => {
    const r = await deliver(proj({ extra: { ".bounded/guard-log.jsonl": SEEDED_GUARD_LOG } }));
    expect(r.code).toBe(0);
    expect(text(r.lines)).toMatch(/^deliver: timing — where the minutes went \(\d+ guard events, taken as one run\)$/m);
    expect(r.lines).toContain("  timing: design    4m00s");
    expect(r.lines).toContain("  timing: tests    16m00s  (1 bounce: 1 → test-writer)");
    expect(r.lines).toContain("  timing: build    28m00s");
    expect(r.lines).toContain("  friction: 0 refusals — target 0");
  });

  test("the friction line totals the unrouted blocks, and the summary rides in the event detail", async () => {
    const dir = proj({ extra: { ".bounded/guard-log.jsonl": FRICTION_GUARD_LOG } });
    const r = await deliver(dir);
    expect(r.lines).toContain("  friction: 3 refusals (path-gate 2, phase-gate 1) — target 0");
    const event = readGuardLog(dir).find((e) => e.guard === "deliver" && (e.detail as { step?: string }).step === "timing");
    const timing = (event!.detail as { timing?: PhaseDurations }).timing!;
    expect(timing.friction.refusals).toBe(3);
    expect(timing.phases.map((p) => p.phase)).toEqual(["design", "tests", "build", "wrap"]);
  });

  test("an unavailable log costs one line, never the delivery", async () => {
    const dir = proj();
    process.env["BOUNDED_GUARD_LOG"] = "off";
    try {
      const r = await deliver(dir);
      expect(r.code).toBe(0);
      expect(r.lines).toContain(
        "deliver: timing — unavailable — the guard log is empty or absent (BOUNDED_GUARD_LOG=off, or no gate ran here)",
      );
    } finally {
      delete process.env["BOUNDED_GUARD_LOG"];
    }
  });
});

// --- 8. the project's own check -----------------------------------------------------------

describe("runDeliver: the project's own check", () => {
  test("runs `bun run check` in the target and prints its summary line", async () => {
    const r = await deliver(proj());
    expect(r.lines).toContain("deliver: check — bun run check passed — surface-check: OK (5 contract pairs)");
  });

  test("it runs after every mutating step and after the timing block", async () => {
    const dir = proj({ extra: { ".bounded/guard-log.jsonl": SEEDED_GUARD_LOG } });
    const r = await deliver(dir);
    const timingAt = r.lines.findIndex((l) => l.startsWith("deliver: timing —"));
    const checkAt = r.lines.findIndex((l) => l.startsWith("deliver: check —"));
    expect(timingAt).toBeGreaterThanOrEqual(0);
    expect(checkAt).toBeGreaterThan(timingAt);
    expect(r.lines.slice(checkAt + 1).at(-1)).toMatch(/^deliver: OK —/);
  });

  test("BLOCK when the project's own check is red, with the failing tail", async () => {
    const dir = proj({ extra: { ".bounded/guard-log.jsonl": SEEDED_GUARD_LOG } });
    const r = await deliver(dir, {
      check: { code: 1, stdout: "contexts/notebook/src/domain/notes/note.ts(4,3): error TS2322: bad\n", stderr: "error: script \"check\" exited with code 1\n" },
    });
    expect(r.code).toBe(1);
    expect(r.lines).toContain(
      "deliver: BLOCK — the project's own `bun run check` is RED (bun exited 1) — the repo does not " +
        "satisfy its own definition of done, so it is not ready to hand over; fix it and re-run deliver",
    );
    expect(r.lines).toContain("  check: contexts/notebook/src/domain/notes/note.ts(4,3): error TS2322: bad");
    expect(r.lines.findIndex((l) => l.startsWith("deliver: BLOCK —"))).toBeGreaterThan(r.lines.findIndex((l) => l.startsWith("deliver: timing —")));
    expect(blockEvent(dir)?.step).toBe("check");
  });

  test("a check that never completes (timeout) blocks too", async () => {
    const r = await deliver(proj(), { check: { code: null, stdout: "", stderr: "spawnSync bun ETIMEDOUT" } });
    expect(r.code).toBe(1);
    expect(text(r.lines)).toContain("is RED (it never completed)");
  });
});

describe("checkSummaryLine (pure)", () => {
  test("prefers a test tally", () => {
    expect(checkSummaryLine({ code: 0, stdout: "x\nTests  5 passed (5)\ny\n", stderr: "" })).toBe("Tests  5 passed (5)");
  });

  test("falls back to the last line when the check speaks another language", () => {
    expect(checkSummaryLine({ code: 0, stdout: "all good\n\n", stderr: "" })).toBe("all good");
  });

  test("strips ANSI colour so the line is greppable", () => {
    expect(checkSummaryLine({ code: 0, stdout: "\u001b[32m Tests  3 passed (3)\u001b[39m\n", stderr: "" })).toBe("Tests  3 passed (3)");
  });

  test("silent output has no summary to print", () => {
    expect(checkSummaryLine({ code: 0, stdout: "", stderr: "" })).toBeUndefined();
  });
});

// --- 9. pack checks ----------------------------------------------------------------------

describe("runDeliver: pack-contributed checks", () => {
  test("a project that composed no pack with a check passes with nothing to check", async () => {
    const r = await deliver(proj());
    expect(r.lines).toContain("deliver: pack-checks — no composed pack contributes one");
    expect(r.lines).toContain("deliver: check-scripts — no composed pack folds a check script into this tree");
  });

  test("a contributed check runs, is named in its own line, and is never an applied step", async () => {
    const dir = proj({ packs: ["ts", "ts-hexagonal", "ts-trpc"] });
    const r = await deliver(dir);
    expect(r.code, text(r.lines)).toBe(0);
    expect(r.lines).toContain("deliver: trpc-obligation — ts-trpc: generated tRPC adapter in notebook");
    expect((await deliver(dir)).lines.at(-1)).toBe("deliver: OK — 0 steps applied");
  });

  test("a contributed check that blocks stops the delivery", async () => {
    // ts-trpc composed, but no in port is exposed through it.
    const dir = proj({ packs: ["ts", "ts-hexagonal", "ts-trpc"] });
    for (const feature of ["create-note", "list-notes"]) {
      const path = join(dir, `contexts/notebook/src/application/notes/${feature}/${feature}.contract.ts`);
      writeFileSync(path, readFileSync(path, "utf8").split("\n").filter((l) => !/@exposedVia/.test(l)).join("\n"));
    }
    rmSync(join(dir, "contexts/notebook/src/adapters/in"), { recursive: true, force: true });
    const r = await deliver(dir);
    expect(r.code, text(r.lines)).toBe(1);
    expect(text(r.lines)).toContain("deliver: BLOCK — trpc-obligation: ts-trpc: no context exposes a feature through tRPC");
  });

  test("a red check short-circuits them", async () => {
    const r = await deliver(proj({ packs: ["ts", "ts-hexagonal", "ts-trpc"] }), { check: { code: 1, stdout: "1 fail", stderr: "" } });
    expect(r.code).toBe(1);
    expect(text(r.lines)).not.toContain("trpc-obligation");
  });
});
