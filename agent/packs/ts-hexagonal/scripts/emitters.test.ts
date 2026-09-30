import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { generatedFileGlobsFor, pathGlobMatcher } from "../../../src/pack-contrib.ts";
import { type EmittedFile, emittedFileProblem, type ProjectFacts, type WorkspaceTemplate } from "../../ts/pack.ts";
import {
  applicationBarrelEmitter,
  commandEmitter,
  domainBarrelEmitter,
  domainErrorsEmitter,
  ERRORS_SOURCE,
  handlerEmitter,
  inMemoryEmitter,
  outAdapterEmitter,
  outBarrelEmitter,
  renderTemplate,
  TS_HEXAGONAL_EMITTERS,
  workspaceSeedEmitter,
} from "./emitters.ts";
import { declarationShape } from "./testdata/declaration-shape.ts";
import {
  APPLICATION_CONTRACTS,
  CREATE_NOTE,
  contextWorkspace,
  contracts,
  exampleFacts,
  ROOT,
  TECHNOLOGIES,
} from "./testdata/example-contracts.ts";
import { GENERATED, SKELETONS } from "./testdata/example-files.ts";

/** The example composes no Drizzle stores yet, so its golden run leaves Drizzle out. */
const EXAMPLE_TECHNOLOGIES = TECHNOLOGIES.filter((t) => t.id !== "drizzle");
const facts = (overrides: Partial<ProjectFacts> = {}): ProjectFacts =>
  exampleFacts({ adapterTechnologies: EXAMPLE_TECHNOLOGIES, ...overrides });

function emitAll(input: ProjectFacts): EmittedFile[] {
  return TS_HEXAGONAL_EMITTERS.flatMap((e) => e.emit(input));
}

const byPath = (files: readonly EmittedFile[]): Map<string, EmittedFile> => new Map(files.map((f) => [f.path, f]));

describe("golden: the worked example's contracts reproduce its files", () => {
  const emitted = byPath(emitAll(facts()));

  test.each(Object.keys(GENERATED))("generated %s is byte-for-byte the example's", (path) => {
    const file = emitted.get(`${ROOT}/${path}`);
    expect(file?.mode).toBe("generated");
    expect(file?.content).toBe(GENERATED[path]);
  });

  test.each(Object.keys(SKELETONS))("skeleton %s declares what the example declares", (path) => {
    const file = emitted.get(`${ROOT}/${path}`);
    expect(file?.mode).toBe("skeleton");
    expect(declarationShape(file!.content)).toEqual(declarationShape(SKELETONS[path]!));
  });

  test("the emitted set is exactly the example's files plus red-phase and laws files", () => {
    const expected = [
      ...Object.keys(GENERATED),
      ...Object.keys(SKELETONS),
      "domain/shared/errors.ts",
      "application/notes/create-note/create-note.command.laws.test.ts",
      "application/projects/create-project/create-project.command.laws.test.ts",
    ].map((p) => `${ROOT}/${p}`).sort();
    expect([...emitted.keys()].sort()).toEqual(expected);
  });

  test("skeleton bodies throw NotImplementedError naming the member, and import it by relative path", () => {
    const handler = emitted.get(`${ROOT}/application/notes/create-note/create-note.handler.ts`)!.content;
    expect(handler).toBe([
      'import type { Note, Result } from "@example/project-management/domain";',
      'import { NotImplementedError } from "../../../domain/shared/errors.ts";',
      'import type { CreateNote, CreateNoteCommand, CreateNoteStore } from "./create-note.contract.ts";',
      "",
      "export class CreateNoteHandler implements CreateNote {",
      "  constructor(private readonly store: CreateNoteStore) {}",
      "",
      "  async execute(command: CreateNoteCommand): Promise<Result<Note>> {",
      '    throw new NotImplementedError("CreateNoteHandler.execute");',
      "  }",
      "}",
      "",
    ].join("\n"));
    const store = emitted.get(`${ROOT}/adapters/out/in-memory/notes/create-note.store.ts`)!.content;
    expect(store).toContain('import { NotImplementedError } from "../../../../domain/shared/errors.ts";');
    expect(store).toContain('throw new NotImplementedError("InMemoryCreateNoteStore.projectExists");');
    expect(store).toContain('throw new NotImplementedError("InMemoryCreateNoteStore.save");');
    expect(emitted.get(`${ROOT}/adapters/out/in-memory/in-memory-database.ts`)!.content).toBe("export class InMemoryDatabase {}\n");
    expect(emitted.get(`${ROOT}/domain/shared/errors.ts`)!.content).toBe(ERRORS_SOURCE);
  });
});

describe("determinism and safety", () => {
  test("the same facts always emit the same bytes, whatever order the contracts arrive in", () => {
    const shuffled = facts({ workspaces: [contextWorkspace([...contracts()].reverse())] });
    expect(emitAll(facts())).toEqual(emitAll(facts()));
    expect(emitAll(shuffled)).toEqual(emitAll(facts()));
  });

  test("no emitter reads the clock or the environment", () => {
    const before = emitAll(facts());
    const now = Date.now;
    Date.now = () => 0;
    try {
      expect(emitAll(facts())).toEqual(before);
    } finally {
      Date.now = now;
    }
    expect(JSON.stringify(before)).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  test("every file is safe and ends with a newline, no two share a path, and generated paths are protected", () => {
    const files = emitAll(facts());
    const protectedPath = pathGlobMatcher(generatedFileGlobsFor(["ts", "ts-hexagonal"]));
    for (const file of files) {
      expect(emittedFileProblem(file, "test")).toBeUndefined();
      expect(protectedPath(file.path), `${file.path} is ${file.mode}`).toBe(file.mode === "generated");
    }
    expect(new Set(files.map((f) => f.path)).size).toBe(files.length);
  });

  test("the errors module exists only while skeletons may: at design and red, never at deliver", () => {
    expect(domainErrorsEmitter.emit(facts({ phase: "design" }))).toHaveLength(1);
    expect(domainErrorsEmitter.emit(facts({ phase: "red" }))).toHaveLength(1);
    expect(domainErrorsEmitter.emit(facts({ phase: "deliver" }))).toEqual([]);
  });

  test("an empty design emits nothing, and apps get no context files", () => {
    expect(emitAll(facts({ workspaces: [] }))).toEqual([]);
    const app = { dir: "apps/web", name: "web", kind: "web", packageName: "@example/web", sourceRoot: "apps/web/src", contracts: [] };
    const template: WorkspaceTemplate = { pack: "p", kind: "web", root: "apps", manifest: "m.json", files: [], description: "d" };
    expect(emitAll(facts({ workspaces: [app], workspaceTemplates: [template] }))).toEqual([]);
  });

  test("a context with only domain contracts still gets its barrels", () => {
    const domainOnly = contracts().filter((c) => c.path.includes("/domain/"));
    const files = byPath(emitAll(facts({ workspaces: [contextWorkspace(domainOnly)] })));
    expect([...files.keys()].sort()).toEqual([
      `${ROOT}/application/index.ts`, `${ROOT}/domain/index.ts`, `${ROOT}/domain/shared/errors.ts`, `${ROOT}/domain/shared/result.ts`,
    ]);
    expect(files.get(`${ROOT}/application/index.ts`)!.content).toMatch(/\nexport \{\};\n$/);
  });
});

describe("composition decides the out adapters", () => {
  test("without the in-memory technology there are no in-memory stores or barrel", () => {
    const without = facts({ adapterTechnologies: EXAMPLE_TECHNOLOGIES.filter((t) => t.id !== "in-memory") });
    expect(inMemoryEmitter.emit(without)).toEqual([]);
    expect(outBarrelEmitter.emit(without).map((f) => f.path)).toEqual([`${ROOT}/adapters/out/console/index.ts`]);
  });

  test("a second storage technology gets its own barrel: its database type first, then one store per store port", () => {
    const barrels = byPath(outBarrelEmitter.emit(facts({ adapterTechnologies: TECHNOLOGIES })));
    expect(barrels.get(`${ROOT}/adapters/out/drizzle/index.ts`)?.content).toBe([
      'export type { DrizzleDatabase } from "./drizzle-database.ts";',
      'export { DrizzleCreateNoteStore } from "./notes/create-note.store.ts";',
      'export { DrizzleListNotesStore } from "./notes/list-notes.store.ts";',
      'export { DrizzleCreateProjectStore } from "./projects/create-project.store.ts";',
      'export { DrizzleExportProjectsStore } from "./projects/export-projects.store.ts";',
      'export { DrizzleListProjectsStore } from "./projects/list-projects.store.ts";',
      "",
    ].join("\n"));
    // Drizzle's store skeletons are its own pack's (TN-26-012 §7), not this one's.
    expect(inMemoryEmitter.emit(facts({ adapterTechnologies: TECHNOLOGIES })).some((f) => f.path.includes("/drizzle/"))).toBe(false);
  });

  test("a storage technology that does not say what its database is, is refused", () => {
    const vague = TECHNOLOGIES.map((t) => (t.id === "drizzle" ? { ...t, database: undefined } : t));
    expect(() => outBarrelEmitter.emit(facts({ adapterTechnologies: vague }))).toThrow(/'drizzle' does not say whether its database/);
  });

  test("an @implementedBy technology no pack composes is refused, naming the contract", () => {
    const without = facts({ adapterTechnologies: EXAMPLE_TECHNOLOGIES.filter((t) => t.id !== "console") });
    expect(() => outAdapterEmitter.emit(without)).toThrow(/export-projects\.contract\.ts: @implementedBy names 'console'/);
  });

  test("an out port using a feature-local type imports it from the application barrel", () => {
    const source = CREATE_NOTE.replace("  save(note: Note): Promise<void>;", "  save(note: Note): Promise<void>;\n  audit(input: CreateNoteInput): Promise<void>;");
    const workspace = contextWorkspace(contracts({ "application/notes/create-note/create-note.contract.ts": source }));
    const store = inMemoryEmitter.emit(facts({ workspaces: [workspace] })).find((f) => f.path.endsWith("create-note.store.ts"))!;
    expect(store.content).toContain('import type { CreateNoteInput, CreateNoteStore } from "@example/project-management/application";');
    expect(store.content).toContain("  async audit(input: CreateNoteInput): Promise<void> {");
  });
});

describe("emitter edge cases", () => {
  test("a handler with no out ports has no constructor; one with two takes them one per line in order", () => {
    const noPorts = `import type { Note } from "@example/project-management/domain";

/**
 * Count the notes
 */
export interface CountNotes {
  execute(): Promise<Note[]>;
}
`;
    const workspace = contextWorkspace(contracts({ "application/notes/count-notes/count-notes.contract.ts": noPorts }));
    const handlers = byPath(handlerEmitter.emit(facts({ workspaces: [workspace] })));
    const count = handlers.get(`${ROOT}/application/notes/count-notes/count-notes.handler.ts`)!.content;
    expect(count).not.toContain("constructor");
    expect(count).toContain("export class CountNotesHandler implements CountNotes {\n  async execute(): Promise<Note[]> {");
    expect(handlers.get(`${ROOT}/application/projects/export-projects/export-projects.handler.ts`)!.content).toContain(
      "  constructor(\n    private readonly store: ExportProjectsStore,\n    private readonly exporter: ProjectExporter,\n  ) {}\n",
    );
  });

  test("a long command return line wraps the way the formatter does", () => {
    const source = CREATE_NOTE
      .replace("readonly text: string;\n}", "readonly text: string;\n  readonly extraLongFieldNameForWrapping: string;\n}")
      .replace("readonly text: NoteText;\n}", "readonly text: NoteText;\n  readonly extraLongFieldNameForWrapping: NoteText;\n}");
    const workspace = contextWorkspace(contracts({ "application/notes/create-note/create-note.contract.ts": source }));
    const command = commandEmitter.emit(facts({ workspaces: [workspace] })).find((f) => f.path.endsWith("create-note.command.ts"))!;
    for (const line of command.content.split("\n")) expect(line.length).toBeLessThanOrEqual(120);
    expect(command.content).toContain("    return extraLongFieldNameForWrapping.ok\n      ? { ok: true, value: new CreateNoteCommandImpl(");
  });

  test("the application barrel lists features by area, then feature", () => {
    const text = applicationBarrelEmitter.emit(facts())[0]!.content;
    const order = [...text.matchAll(/export \{ (\w+)Handler \}/g)].map((m) => m[1]);
    expect(order).toEqual(["CreateNote", "ListNotes", "CreateProject", "ExportProjects", "ListProjects"]);
  });

  test("two contexts emit independently", () => {
    const billing = {
      ...contextWorkspace(contracts().map((c) => ({
        path: c.path.replace("contexts/project-management/", "contexts/billing/"),
        source: c.source.replaceAll("@example/project-management/", "@example/billing/"),
      }))),
      dir: "contexts/billing", name: "billing", packageName: "@example/billing", sourceRoot: "contexts/billing/src",
    };
    const files = domainBarrelEmitter.emit(facts({ workspaces: [billing, contextWorkspace()] }));
    expect(files.map((f) => f.path)).toEqual(["contexts/billing/src/domain/index.ts", `${ROOT}/domain/index.ts`]);
  });

  test("a contract outside the layout, or a context in the wrong place, is refused", () => {
    const stray = contextWorkspace([...contracts(), { path: `${ROOT}/adapters/out/x.contract.ts`, source: "" }]);
    expect(() => emitAll(facts({ workspaces: [stray] }))).toThrow(/domain\/<area>\/ or application\/<area>\/<feature>\/ folders only/);
    const misplaced = { ...contextWorkspace(), sourceRoot: "contexts/project-management/lib" };
    expect(() => emitAll(facts({ workspaces: [misplaced] }))).toThrow(/source root at src/);
  });

  test("an in port name used by two features is refused", () => {
    const clash = APPLICATION_CONTRACTS["application/notes/list-notes/list-notes.contract.ts"]!;
    const workspace = contextWorkspace(contracts({
      "application/projects/list-notes/list-notes.contract.ts": clash,
    }));
    expect(() => emitAll(facts({ workspaces: [workspace] }))).toThrow(/ListNotes is also declared by/);
  });
});

describe("workspace seeds", () => {
  const dirs: string[] = [];
  afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

  test("renders each workspace's template files with its scope, name and package", () => {
    const packs = mkdtempSync(join(tmpdir(), "hex-seeds-"));
    dirs.push(packs);
    mkdirSync(join(packs, "web-pack", "templates"), { recursive: true });
    writeFileSync(join(packs, "web-pack", "templates", "main.ts"), 'import { composeApp } from "./composition-root.ts";\n// {{package}} in {{scope}} as {{name}}\n');
    const template: WorkspaceTemplate = {
      pack: "web-pack", kind: "web", root: "apps", manifest: "m.json", description: "d",
      files: [{ path: "src/server/main.ts", source: "templates/main.ts", mode: "skeleton" }],
    };
    const app = { dir: "apps/web", name: "web", kind: "web", packageName: "@example/web", sourceRoot: "apps/web/src", contracts: [] };
    expect(workspaceSeedEmitter(packs).emit(facts({ workspaces: [app], workspaceTemplates: [template] }))).toEqual([{
      path: "apps/web/src/server/main.ts",
      content: 'import { composeApp } from "./composition-root.ts";\n// @example/web in @example as web\n',
      mode: "skeleton",
    }]);
  });

  test("an unknown placeholder or an untemplated kind is refused", () => {
    expect(() => renderTemplate("{{project}}", { scope: "@x", name: "y", package: "@x/y" }, "t")).toThrow(/'\{\{project\}\}'/);
    const app = { dir: "apps/web", name: "web", kind: "web", packageName: "@example/web", sourceRoot: "apps/web/src", contracts: [] };
    expect(() => workspaceSeedEmitter("/nowhere").emit(facts({ workspaces: [app] }))).toThrow(/which no composed pack templates/);
  });
});
