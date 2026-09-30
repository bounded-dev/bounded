// The reference (packs/ts-hexagonal/reference/) is the worked example's
// project-management context with tests at every level this pack owns, plus
// the shipped architecture test and rulebook. This file keeps it honest:
//
//   - the pack's emitters reproduce every generated file in it exactly, and
//     every skeleton's declarations;
//   - it passes this pack's nine lint rules and a strict type check;
//   - it runs green under `bun test` in a throwaway project;
//   - the shipped architecture.test.ts fails on each seeded violation (and the
//     lint flags the same file), and passes on the reference.
//
// Bun is needed for the last two. Without it they skip with a logged reason.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import tsParser from "@typescript-eslint/parser";
import { ESLint } from "eslint";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { composePacks } from "../../src/socket-registry.ts";
import { INSTALLED_PACKS } from "../installed.ts";
import { adapterTechnologies, skeletonEmitters, workspaceTemplates } from "../ts/pack.ts";
import { TS_HEXAGONAL_LINT_RULES, TS_HEXAGONAL_PLUGIN } from "./eslint/index.ts";
import { TS_HEXAGONAL_EMITTERS } from "./scripts/emitters.ts";
import { declarationShape } from "./scripts/testdata/declaration-shape.ts";
import { TECHNOLOGIES } from "./scripts/testdata/example-contracts.ts";
import { readProjectFacts } from "./scripts/workspaces.ts";

const here = dirname(fileURLToPath(import.meta.url));
const REFERENCE = join(here, "reference");
const AGENT = join(here, "..", "..");
const PACKS = ["ts", "ts-hexagonal"];
const CONTEXT_SRC = "contexts/project-management/src";
const ARCHITECTURE_SOURCE = "architecture-test.ts";

const temporary: string[] = [];
afterAll(() => { for (const dir of temporary) rmSync(dir, { recursive: true, force: true }); });

function walk(dir: string, relative = ""): string[] {
  return readdirSync(join(dir, relative)).sort().flatMap((entry) => {
    const path = relative === "" ? entry : `${relative}/${entry}`;
    return statSync(join(dir, path)).isDirectory() ? walk(dir, path) : [path];
  });
}

/** The reference's facts: this pack's technologies, and the in-adapter
 *  technologies its contracts are tagged with (their packs contribute them). */
function referenceFacts(phase: "red" | "deliver") {
  const inTechnologies = TECHNOLOGIES.filter((t) => t.direction === "in");
  return readProjectFacts(REFERENCE, {
    scope: "@example", phase, packs: PACKS,
    adapterTechnologies: [...adapterTechnologies(PACKS), ...inTechnologies],
    workspaceTemplates: workspaceTemplates(PACKS),
  });
}

describe("the pack's emitters reproduce the reference", () => {
  const emitted = TS_HEXAGONAL_EMITTERS.flatMap((e) => e.emit(referenceFacts("deliver")));

  test("every generated file in the reference is exactly what the emitters produce", () => {
    const generated = emitted.filter((f) => f.mode === "generated");
    expect(generated.length).toBeGreaterThanOrEqual(9);
    for (const file of generated) expect(readFileSync(join(REFERENCE, file.path), "utf8"), file.path).toBe(file.content);
  });

  test("every skeleton's declarations are the reference implementation's", () => {
    const skeletons = emitted.filter((f) => f.mode === "skeleton");
    expect(skeletons.length).toBe(12);
    for (const file of skeletons) {
      expect(declarationShape(file.content), file.path).toEqual(declarationShape(readFileSync(join(REFERENCE, file.path), "utf8")));
    }
  });

  test("at delivery nothing of the red phase is left: no errors module, no import of one", () => {
    expect(emitted.some((f) => f.path.endsWith("/errors.ts"))).toBe(false);
    const sources = walk(REFERENCE).filter((p) => p.endsWith(".ts"));
    expect(sources.filter((p) => readFileSync(join(REFERENCE, p), "utf8").includes("shared/errors.ts"))).toEqual([]);
  });
});

/** A throwaway project around the reference, resolving packages from the
 *  harness's own node_modules (no network). */
function fixture(modules: readonly string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "hex-reference-"));
  temporary.push(dir);
  cpSync(REFERENCE, dir, { recursive: true });
  // Shipped as architecture.test.ts; kept under another name in the pack so
  // the published package, which drops every *.test.ts, still carries it.
  renameSync(join(dir, ARCHITECTURE_SOURCE), join(dir, "architecture.test.ts"));
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({
    name: "reference", private: true, type: "module", workspaces: ["contexts/*", "apps/*"],
  }, null, 2)}\n`);
  mkdirSync(join(dir, "node_modules", "@example"), { recursive: true });
  for (const name of ["zod", "typescript", ...modules]) symlinkSync(join(AGENT, "node_modules", name), join(dir, "node_modules", name), "dir");
  symlinkSync(join(dir, "contexts", "project-management"), join(dir, "node_modules", "@example", "project-management"), "dir");
  return dir;
}

const SHIM = `declare module "bun:test" {
  interface Matchers {
    toBe(value: unknown): void;
    toEqual(value: unknown): void;
    toHaveLength(length: number): void;
    toContainEqual(value: unknown): void;
    toHaveBeenCalledTimes(times: number): void;
    toHaveBeenCalledWith(...values: unknown[]): void;
  }
  export function expect(value: unknown): Matchers & { not: Matchers };
  export function test(name: string, run: () => unknown): void;
  export function describe(name: string, run: () => void): void;
  export function afterEach(run: () => unknown): void;
  export function spyOn<T extends object>(target: T, key: keyof T): {
    mockImplementation(run: (...args: never[]) => unknown): { mockClear(): void };
    mockClear(): void;
  };
}
declare module "bun" {
  export class Glob {
    constructor(pattern: string);
    scan(options?: { cwd?: string; onlyFiles?: boolean; dot?: boolean }): AsyncIterable<string>;
  }
}
declare module "node:fs" {
  export function readdirSync(path: string, options?: { recursive?: boolean }): string[];
  export function statSync(path: string): { isFile(): boolean };
}
declare const Bun: { file(path: string): { text(): Promise<string>; json(): Promise<unknown> } };
interface ImportMeta { readonly dir: string }
`;

describe("the reference passes its own checks", () => {
  test("the pack's nine lint rules find nothing, reading the workspaces from the manifests", async () => {
    const dir = fixture();
    const results = await linter(dir).lintFiles(["contexts/**/*.ts"]);
    expect(results.length).toBeGreaterThan(40);
    expect(results.flatMap((r) => r.messages.map((m) => `${r.filePath}: ${m.ruleId}: ${m.message}`))).toEqual([]);
  });

  test("it type-checks strictly, with the example's compiler options", () => {
    const dir = fixture();
    writeFileSync(join(dir, "bun-shim.d.ts"), SHIM);
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        lib: ["ESNext", "DOM"], target: "ESNext", module: "Preserve", moduleDetection: "force", types: [],
        moduleResolution: "bundler", allowImportingTsExtensions: true, verbatimModuleSyntax: true, noEmit: true,
        strict: true, skipLibCheck: true, noFallthroughCasesInSwitch: true, noUncheckedIndexedAccess: true,
        noImplicitOverride: true,
      },
      include: ["contexts/*/src", "architecture.test.ts", "bun-shim.d.ts"],
    }));
    const tsc = spawnSync(process.execPath, [join(AGENT, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"], {
      cwd: dir, encoding: "utf8",
    });
    expect(tsc.stdout + tsc.stderr).toBe("");
    expect(tsc.status).toBe(0);
  });
});

function linter(cwd: string): ESLint {
  const rules = Object.fromEntries(TS_HEXAGONAL_LINT_RULES.map((r) => [r.name, r.rule]));
  return new ESLint({
    cwd,
    overrideConfigFile: true,
    overrideConfig: [{
      files: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
      languageOptions: { parser: tsParser as never },
      plugins: { [TS_HEXAGONAL_PLUGIN]: { rules } as never },
      rules: Object.fromEntries(TS_HEXAGONAL_LINT_RULES.map((r) => [`${TS_HEXAGONAL_PLUGIN}/${r.name}`, "error"])),
    }],
  });
}

const bun = spawnSync("bun", ["--version"], { encoding: "utf8" });
const HAS_BUN = bun.status === 0;
if (!HAS_BUN) console.log("[ts-hexagonal] bun is not on PATH: skipping the reference and architecture-test runs under bun test");

function bunTest(dir: string, ...files: string[]): { status: number | null; output: string } {
  const run = spawnSync("bun", ["test", ...files], { cwd: dir, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

const failed = (output: string): string[] =>
  [...output.matchAll(/^\(fail\) architecture > (.+?)(?: \[[\d.]+m?s\])?$/gm)].map((m) => m[1]!).sort();

describe.skipIf(!HAS_BUN)("the out barrels load under bun with the real Postgres pack composed", () => {
  const PG_PACKS = ["ts", "ts-hexagonal", "ts-drizzle-postgres"];

  test("the drizzle barrel re-exports DrizzleDatabase as a type, and every store as a value", () => {
    const dir = fixture(["drizzle-orm", "pg"]);
    const facts = readProjectFacts(dir, {
      scope: "@example", phase: "red", packs: PG_PACKS,
      adapterTechnologies: [...adapterTechnologies(PG_PACKS), ...TECHNOLOGIES.filter((t) => t.direction === "in")],
      workspaceTemplates: workspaceTemplates(PG_PACKS),
    });
    const files = composePacks(INSTALLED_PACKS, PG_PACKS).read(skeletonEmitters).flatMap((e) => e.emit(facts));
    for (const file of files) {
      const target = join(dir, file.path);
      if (existsSync(target)) continue;
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content);
    }
    const barrel = `${CONTEXT_SRC}/adapters/out/drizzle/index.ts`;
    expect(readFileSync(join(dir, barrel), "utf8")).toMatch(/^export type \{ DrizzleDatabase \} from "\.\/drizzle-database\.ts";$/m);
    const load = (path: string) => {
      writeFileSync(join(dir, "load.ts"), `const m = await import("./${path}");\nconsole.log(JSON.stringify(Object.keys(m).sort()));\n`);
      return spawnSync("bun", ["load.ts"], { cwd: dir, encoding: "utf8" });
    };
    const loaded = load(barrel);
    expect(loaded.stderr).toBe("");
    expect(JSON.parse(loaded.stdout)).toEqual([
      "DrizzleCreateNoteStore", "DrizzleCreateProjectStore", "DrizzleExportProjectsStore", "DrizzleListNotesStore", "DrizzleListProjectsStore",
    ]);
    expect(JSON.parse(load(`${CONTEXT_SRC}/adapters/out/in-memory/index.ts`).stdout)).toContain("InMemoryDatabase");
    // The value form this replaces: Bun refuses a type re-exported as a value.
    writeFileSync(join(dir, barrel), readFileSync(join(dir, barrel), "utf8").replace("export type {", "export {"));
    const broken = load(barrel);
    expect(broken.status).not.toBe(0);
    expect(broken.stderr).toMatch(/DrizzleDatabase/);
  });
});

describe.skipIf(!HAS_BUN)("under bun test", () => {
  test("the reference is green at every level", () => {
    const run = bunTest(fixture());
    expect(run.output).toMatch(/\b0 fail\b/);
    expect(run.status).toBe(0);
    for (const level of ["architecture", "NoteText", "CreateNoteCommand laws", "CreateNoteHandler", "conforms to CreateNoteStore", "ConsoleProjectExporter"]) {
      expect(run.output).not.toMatch(new RegExp(`\\(fail\\) ${level}`));
    }
    expect(Number(/(\d+) pass/.exec(run.output)?.[1])).toBeGreaterThan(60);
  });

  const LAYERS = "dependencies point inwards: domain <- application <- adapters";
  const CONTEXTS = "contexts never import each other or an app";
  const APPS = "apps import contexts only through their export paths, and never each other";
  const BROWSER = "browser code imports server code as types only";
  const IN_ADAPTERS = "in adapters depend on in ports, never on handler classes";
  const PLACEMENT = "every context file sits in a layer";
  const KEBAB = "workspace directories are kebab-case";
  const WIRING = "only composition roots load application and adapter code at runtime";

  /** [description, path, source, the one architecture test that must fail, the lint rule that must flag it]. */
  const SEEDS: readonly [string, string, string, readonly string[], string | undefined][] = [
    ["domain imports application (relative)", `${CONTEXT_SRC}/domain/notes/seed.ts`, `import type { CreateNote } from "../../application/index.ts";\n`, [LAYERS], "layer-dependency"],
    ["domain imports adapters (single quotes)", `${CONTEXT_SRC}/domain/notes/seed.ts`, `import type { X } from '../../adapters/out/in-memory/index.ts';\n`, [LAYERS], "layer-dependency"],
    ["domain imports its own adapters package", `${CONTEXT_SRC}/domain/notes/seed.ts`, `export type { X } from "@example/project-management/adapters/in-memory";\n`, [LAYERS], "layer-dependency"],
    ["domain side-effect import of application", `${CONTEXT_SRC}/domain/notes/seed.ts`, `import "../../application/index.ts";\n`, [LAYERS], "layer-dependency"],
    ["domain dynamic import of adapters", `${CONTEXT_SRC}/domain/notes/seed.ts`, "export const m = () => import(`../../adapters/out/console/index.ts`);\n", [LAYERS, WIRING], "layer-dependency"],
    ["domain require of application", `${CONTEXT_SRC}/domain/notes/seed.ts`, `import x = require("../../application/index.ts");\nexport { x };\n`, [LAYERS, WIRING], "layer-dependency"],
    ["domain import-type of application", `${CONTEXT_SRC}/domain/notes/seed.ts`, `export type T = import("../../application/index.ts").CreateNote;\n`, [LAYERS], "layer-dependency"],
    ["domain uses a library other than zod", `${CONTEXT_SRC}/domain/notes/seed.ts`, `import { readFileSync } from "node:fs";\nexport { readFileSync };\n`, [LAYERS], "layer-dependency"],
    ["domain computed import", `${CONTEXT_SRC}/domain/notes/seed.ts`, `const name = "x";\nexport const m = () => import(name);\n`, [LAYERS], "layer-dependency"],
    ["application imports adapters", `${CONTEXT_SRC}/application/notes/create-note/create-note.seed.ts`, `export * from "@example/project-management/adapters/in-memory";\n`, [LAYERS], "layer-dependency"],
    ["an out adapter imports another technology", `${CONTEXT_SRC}/adapters/out/console/projects/seed.exporter.ts`, `import { InMemoryDatabase } from "../../in-memory/in-memory-database.ts";\nexport { InMemoryDatabase };\n`, [LAYERS], "layer-dependency"],
    ["a context file outside the layers", `${CONTEXT_SRC}/utils.ts`, "export const x = 1;\n", [PLACEMENT], "file-role-suffix"],
    ["a context imports another context", `${CONTEXT_SRC}/domain/notes/seed.ts`, `import type { InvoiceId } from "@example/billing/domain";\nexport type { InvoiceId };\n`, [CONTEXTS], "no-cross-context-import"],
    ["a context reaches another by relative path", `${CONTEXT_SRC}/domain/notes/seed.ts`, `import type { X } from "../../../../billing/src/domain/index.ts";\nexport type { X };\n`, [CONTEXTS], "no-cross-context-import"],
    ["a context imports an app", `${CONTEXT_SRC}/adapters/out/console/projects/seed.exporter.ts`, `import { x } from "@example/web";\nexport { x };\n`, [CONTEXTS], "no-cross-context-import"],
    ["an app imports another app", "apps/web/src/server/seed.ts", `import { x } from "@example/mcp";\nexport { x };\n`, [APPS], "layer-dependency"],
    ["an app deep-imports a context", "apps/web/src/server/seed.ts", `import { x } from "@example/project-management/src/domain/index.ts";\nexport { x };\n`, [APPS], "layer-dependency"],
    ["an app reaches a context by relative path", "apps/web/src/server/seed.ts", `import { x } from "../../../../contexts/project-management/src/domain/index.ts";\nexport { x };\n`, [APPS], "layer-dependency"],
    ["the browser imports server code by value", "apps/web/src/client/seed.ts", `import { NoteText } from "@example/project-management/domain";\nexport { NoteText };\n`, [BROWSER], "client-type-only-server-imports"],
    ["the browser imports with inline type modifiers", "apps/web/src/client/seed.ts", `import { type NoteText } from "@example/project-management/domain";\nexport type { NoteText };\n`, [BROWSER], "client-type-only-server-imports"],
    ["the browser imports the app's server code", "apps/web/src/client/seed.ts", `import { x } from "../server/main.ts";\nexport { x };\n`, [BROWSER], "client-type-only-server-imports"],
    ["the desktop renderer imports server code by value", "apps/web/src/renderer/seed.ts", `export { NoteText } from "@example/project-management/domain";\n`, [BROWSER], "client-type-only-server-imports"],
    ["an in adapter imports a handler class", `${CONTEXT_SRC}/adapters/in/trpc/notes/create-note.procedure.ts`, `import type { CreateNoteHandler } from "@example/project-management/application";\nexport type { CreateNoteHandler };\n`, [IN_ADAPTERS], "in-adapter-uses-in-port"],
    ["an in adapter reads a handler off a namespace", `${CONTEXT_SRC}/adapters/in/trpc/notes/create-note.procedure.ts`, `import * as App from "@example/project-management/application";\nexport const h = App.CreateNoteHandler;\n`, [IN_ADAPTERS], "in-adapter-uses-in-port"],
    ["a workspace directory that is not kebab-case", "apps/Web_App/src/main.ts", "export const x = 1;\n", [KEBAB], undefined],
    // Files and loaders a TypeScript-only, dot-blind scan used to miss.
    ["a dot-file imports application", `${CONTEXT_SRC}/domain/notes/.hidden.ts`, `import type { X } from "../../application/index.ts";\nexport type { X };\n`, [LAYERS], "layer-dependency"],
    ["a .js file imports application", `${CONTEXT_SRC}/domain/notes/legacy.js`, `import { x } from "../../application/index.ts";\nexport { x };\n`, [LAYERS], "layer-dependency"],
    ["a .jsx file imports application", `${CONTEXT_SRC}/domain/notes/legacy.jsx`, `import { x } from "../../application/index.ts";\nexport { x };\n`, [LAYERS], "layer-dependency"],
    ["a .mjs file re-exports adapters", `${CONTEXT_SRC}/domain/notes/legacy.mjs`, `export { x } from "../../adapters/out/console/index.ts";\n`, [LAYERS], "layer-dependency"],
    ["a .cjs file imports application", `${CONTEXT_SRC}/domain/notes/legacy.cjs`, `import { x } from "../../application/index.ts";\nexport { x };\n`, [LAYERS], "layer-dependency"],
    ["import.meta.require of application", `${CONTEXT_SRC}/domain/notes/seed.ts`, `export const m = import.meta.require("../../application/index.ts");\n`, [LAYERS, WIRING], "layer-dependency"],
    ["require.resolve of adapters", `${CONTEXT_SRC}/domain/notes/seed.ts`, `export const m = require.resolve("../../adapters/out/in-memory/index.ts");\n`, [LAYERS, WIRING], "layer-dependency"],
    ["a legal dot-file and .js file are scanned", `${CONTEXT_SRC}/domain/notes/.note-tools.js`, `export const x = 1;\n`, [], undefined],
    // Handler-class evasions: the in adapter never takes application code whole.
    ["an in adapter destructures a dynamic import", `${CONTEXT_SRC}/adapters/in/trpc/notes/create-note.procedure.ts`, `export const load = async () => {\n  const { CreateNoteHandler: H } = await import("@example/project-management/application");\n  return H;\n};\n`, [IN_ADAPTERS, WIRING], "in-adapter-uses-in-port"],
    ["an in adapter indexes a namespace", `${CONTEXT_SRC}/adapters/in/trpc/notes/create-note.procedure.ts`, `import * as App from "@example/project-management/application";\nexport const H = App["CreateNoteHandler"];\n`, [IN_ADAPTERS], "in-adapter-uses-in-port"],
    ["an in adapter aliases a namespace", `${CONTEXT_SRC}/adapters/in/trpc/notes/create-note.procedure.ts`, `import * as App from "@example/project-management/application";\nconst A = App;\nexport const H = A.CreateNoteHandler;\n`, [IN_ADAPTERS], "in-adapter-uses-in-port"],
    ["an in adapter re-exports application as a namespace", `${CONTEXT_SRC}/adapters/in/trpc/app.ts`, `export * as App from "@example/project-management/application";\n`, [IN_ADAPTERS], "in-adapter-uses-in-port"],
    ["an in adapter re-exports all of application", `${CONTEXT_SRC}/adapters/in/trpc/app.ts`, `export * from "@example/project-management/application";\n`, [IN_ADAPTERS], "in-adapter-uses-in-port"],
    // Wiring: only composition roots load application and adapter code at runtime, or construct it.
    ["an entry file loads application code at runtime", "apps/web/src/server/main.ts", `export const load = () => import("@example/project-management/application");\n`, [WIRING], "composition-root-only-constructs"],
    ["an entry file constructs a handler off a namespace", "apps/web/src/server/main.ts", `import * as App from "@example/project-management/application";\nexport const h = new App.CreateNoteHandler(undefined as never);\n`, [], "composition-root-only-constructs"],
  ];

  let dir = "";
  beforeAll(() => {
    dir = fixture();
    for (const [name, pkg] of [["contexts/billing", "@example/billing"], ["apps/web", "@example/web"], ["apps/mcp", "@example/mcp"]] as const) {
      mkdirSync(join(dir, name, "src"), { recursive: true });
      writeFileSync(join(dir, name, "package.json"), `${JSON.stringify({ name: pkg, private: true, type: "module" })}\n`);
    }
    writeFileSync(join(dir, "apps/web/src/main.ts"), "export const x = 1;\n");
    mkdirSync(join(dir, "apps/web/src/server"), { recursive: true });
    writeFileSync(join(dir, "apps/web/src/server/main.ts"), "export const x = 1;\n");
    writeFileSync(join(dir, "apps/mcp/src/main.ts"), "export const x = 1;\n");
  });

  test("the architecture test passes on the reference with apps and a second context beside it", () => {
    const run = bunTest(dir, "architecture.test.ts");
    expect(failed(run.output)).toEqual([]);
    expect(run.status).toBe(0);
  });

  test.each(SEEDS)("%s: fails exactly the named architecture tests, and the lint flags it", async (_, path, source, failing, rule) => {
    const target = join(dir, path);
    const existed = existsSync(target);
    const before = existed ? readFileSync(target, "utf8") : undefined;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, existed ? `${before}\n${source}` : source);
    try {
      const run = bunTest(dir, "architecture.test.ts");
      expect(failed(run.output)).toEqual([...failing].sort());
      expect(run.status === 0).toBe(failing.length === 0);
      if (rule !== undefined) {
        const [result] = await linter(dir).lintFiles([path]);
        expect(result!.messages.map((m) => m.ruleId)).toContain(`${TS_HEXAGONAL_PLUGIN}/${rule}`);
      }
    } finally {
      if (before !== undefined) writeFileSync(target, before);
      else rmSync(target);
    }
  });
});
