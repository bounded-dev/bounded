// The dogfood structure comparer lives with the other repo experiments in
// scripts/dogfood/ (ADR 2026-042); its tests run here so `npm run check`
// covers it. Every tree is a fixture built in a temporary directory: the
// worked example itself is a local checkout and is never read by a test.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  compareTrees, EXAMPLE_ENV, exportedNames, formatReport, main, namedPath, productFiles, shapeOf, signatureOf, testLevel,
} from "../../scripts/dogfood/structure-compare.ts";

const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function tree(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "structure-compare-"));
  temporary.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const CREATE_NOTE_CONTRACT = [
  'import type { Note, NoteText, ProjectId, Result } from "@example/project-management/domain";',
  "export interface CreateNoteInput { readonly projectId: string; readonly text: string; }",
  "export interface CreateNoteCommand { readonly __brand: \"CreateNoteCommand\"; }",
  "export interface CreateNoteCommandFactory { parse(raw: unknown): Result<CreateNoteCommand>; }",
  "export interface CreateNote { execute(command: CreateNoteCommand): Promise<Result<Note>>; }",
  "export interface CreateNoteStore { save(note: Note): Promise<void>; }",
].join("\n");

/** A small tree in the worked example's shape. */
function exampleFiles(context = "project-management", migration = "0000_mute_wong"): Record<string, string> {
  const c = `contexts/${context}`;
  return {
    "package.json": "{}",
    "tsconfig.json": "{}",
    ".gitignore": "node_modules/\n",
    ".env.example": "DATABASE_URL=\n",
    "architecture.test.ts": "",
    [`${c}/package.json`]: "{}",
    [`${c}/src/domain/index.ts`]: "",
    [`${c}/src/domain/shared/result.ts`]: "",
    [`${c}/src/domain/notes/note-text.contract.ts`]: "export interface NoteText {}\nexport interface NoteTextFactory {}\n",
    [`${c}/src/domain/notes/note-text.ts`]: "",
    [`${c}/src/domain/notes/note-text.test.ts`]: "",
    [`${c}/src/domain/notes/note-text.laws.test.ts`]: "",
    [`${c}/src/application/notes/create-note/create-note.contract.ts`]: CREATE_NOTE_CONTRACT,
    [`${c}/src/application/notes/create-note/create-note.command.ts`]: "",
    [`${c}/src/application/notes/create-note/create-note.handler.ts`]: "",
    [`${c}/src/application/notes/create-note/create-note.test.ts`]: "",
    [`${c}/src/application/notes/create-note/create-note.store.test-support.ts`]: "",
    [`${c}/src/adapters/in/trpc/notes/notes.router.ts`]: "",
    [`${c}/src/adapters/in/trpc/notes/create-note.procedure.ts`]: "",
    [`${c}/src/adapters/out/in-memory/notes/create-note.store.ts`]: "",
    [`${c}/src/adapters/out/in-memory/notes/create-note.store.test.ts`]: "",
    [`${c}/src/adapters/out/drizzle/schema/${context}.schema.ts`]: "",
    [`${c}/src/adapters/out/drizzle/schema/notes.ts`]: "",
    [`${c}/src/adapters/out/drizzle/migrations/${migration}.sql`]: "",
    [`${c}/src/adapters/out/drizzle/migrations/meta/${migration.slice(0, 4)}_snapshot.json`]: "{}",
    "apps/web/src/server/composition-root.ts": "",
    "apps/web/src/server/composition-root.test.ts": "",
  };
}

describe("normalising a tree", () => {
  test("harness artifacts, dependencies, build output, lockfiles and local settings are not structure", () => {
    const root = tree({
      ...exampleFiles(),
      ".bounded/harness/x.ts": "", ".claude/agents/builder.md": "", "AGENTS.md": "", "CLAUDE.md": "",
      "docs/tn/TN-1.md": "", "scripts/surface-check.ts": "", "apps/README.md": "", "ADRs/x.md": "",
      "node_modules/zod/index.js": "", "contexts/project-management/node_modules/x/index.js": "",
      "apps/web/dist/main.js": "", "bun.lock": "", "package-lock.json": "", ".env": "", ".env.local": "",
      ".git/HEAD": "", ".DS_Store": "",
    });
    const files = productFiles(root);
    expect(files).toContain(".env.example");
    for (const ignored of [".bounded/", ".claude/", "AGENTS.md", "CLAUDE.md", "docs/tn/", "scripts/", "apps/README.md",
      "ADRs/", "node_modules/", "dist/", "bun.lock", "package-lock.json", ".git/", ".DS_Store"]) {
      expect(files.filter((f) => f.startsWith(ignored) || f.includes(`/${ignored}`)), ignored).toEqual([]);
    }
    expect(files).not.toContain(".env");
    expect(files).not.toContain(".env.local");
  });

  test("the sole context's name and a migration's random name are taken out of paths", () => {
    expect(namedPath("contexts/billing/src/adapters/out/drizzle/schema/billing.schema.ts", "billing"))
      .toBe("contexts/<context>/src/adapters/out/drizzle/schema/<context>.schema.ts");
    expect(namedPath("contexts/billing/src/adapters/out/drizzle/migrations/0003_brave_hulk.sql", "billing"))
      .toBe("contexts/<context>/src/adapters/out/drizzle/migrations/<migration>.sql");
    expect(namedPath("contexts/billing/src/adapters/out/drizzle/migrations/meta/0003_snapshot.json", "billing"))
      .toBe("contexts/<context>/src/adapters/out/drizzle/migrations/meta/<migration>_snapshot.json");
    expect(namedPath("apps/web/src/server/main.ts", "billing")).toBe("apps/web/src/server/main.ts");
  });

  test("a shape takes the business names out and keeps the role", () => {
    const c = "contexts/<context>/src";
    expect(shapeOf(`${c}/domain/notes/note-text.contract.ts`)).toBe(`${c}/domain/<area>/<concept>.contract.ts`);
    expect(shapeOf(`${c}/domain/shared/result.ts`)).toBe(`${c}/domain/shared/result.ts`);
    expect(shapeOf(`${c}/application/notes/create-note/create-note.handler.ts`))
      .toBe(`${c}/application/<area>/<feature>/<feature>.handler.ts`);
    expect(shapeOf(`${c}/adapters/in/trpc/notes/notes.router.ts`)).toBe(`${c}/adapters/in/trpc/<area>/<area>.router.ts`);
    expect(shapeOf(`${c}/adapters/in/lambda/projects/export-projects.lambda.ts`))
      .toBe(`${c}/adapters/in/lambda/<area>/<feature>.lambda.ts`);
    expect(shapeOf(`${c}/adapters/out/drizzle/notes/note.mapper.ts`)).toBe(`${c}/adapters/out/drizzle/<area>/<concept>.mapper.ts`);
    expect(shapeOf(`${c}/adapters/out/drizzle/schema/notes.ts`)).toBe(`${c}/adapters/out/drizzle/schema/<area>.ts`);
    expect(shapeOf(`${c}/adapters/out/in-memory/index.ts`)).toBe(`${c}/adapters/out/in-memory/index.ts`);
    expect(shapeOf("apps/web/src/server/main.ts")).toBe("apps/web/src/server/main.ts");
  });

  test("a contract's exported names are read from its declarations and export lists", () => {
    expect(exportedNames(CREATE_NOTE_CONTRACT)).toEqual([
      "CreateNote", "CreateNoteCommand", "CreateNoteCommandFactory", "CreateNoteInput", "CreateNoteStore",
    ]);
    expect(exportedNames("export type { A, B as C } from './x.ts';\nexport const D = 1;")).toEqual(["A", "C", "D"]);
  });

  test("every test file is placed at its level", () => {
    const c = "contexts/<context>/src";
    expect(testLevel("architecture.test.ts")).toBe("architecture");
    expect(testLevel(`${c}/domain/notes/note-text.test.ts`)).toBe("domain unit");
    expect(testLevel(`${c}/domain/notes/note-text.laws.test.ts`)).toBe("domain laws");
    expect(testLevel(`${c}/application/notes/create-note/create-note.test.ts`)).toBe("handler");
    expect(testLevel(`${c}/application/notes/create-note/create-note.command.laws.test.ts`)).toBe("command laws");
    expect(testLevel(`${c}/application/notes/create-note/create-note.store.test-support.ts`)).toBe("store conformance suite");
    expect(testLevel(`${c}/adapters/in/trpc/notes/create-note.procedure.laws.test.ts`)).toBe("in-adapter laws (trpc)");
    expect(testLevel(`${c}/adapters/out/drizzle/notes/create-note.store.test.ts`)).toBe("store (drizzle)");
    expect(testLevel(`${c}/adapters/out/drizzle/drizzle-test-database.test-support.ts`)).toBe("store test support (drizzle)");
    expect(testLevel(`${c}/adapters/out/console/projects/export-projects.exporter.test.ts`)).toBe("out adapter (console)");
    expect(testLevel("apps/web/src/server/composition-root.test.ts")).toBe("app smoke (web)");
  });

  test("test files count by level only, never as files", () => {
    const signature = signatureOf(tree(exampleFiles()));
    expect([...signature.files.keys()].some((path) => path.includes(".test."))).toBe(false);
    expect(Object.fromEntries(signature.testLevels)).toEqual({
      architecture: 1, "domain unit": 1, "domain laws": 1, handler: 1, "store conformance suite": 1,
      "store (in-memory)": 1, "app smoke (web)": 1,
    });
  });
});

describe("comparing two trees", () => {
  test("the same structure under another context name and other migration names has no delta", () => {
    const report = compareTrees(tree(exampleFiles()), tree(exampleFiles("notebook", "0000_brave_hulk")));
    expect(report.deltas).toBe(0);
    expect(formatReport(report)).toMatch(/^structure: no structural delta/);
  });

  test("a missing file, an extra file, a changed contract and a missing test level are each a delta", () => {
    const project = exampleFiles();
    delete project["contexts/project-management/src/adapters/in/trpc/notes/notes.router.ts"];
    delete project["apps/web/src/server/composition-root.test.ts"];
    project["contexts/project-management/src/application/notes/create-note/create-note.contract.ts"] =
      CREATE_NOTE_CONTRACT.replace("CreateNoteStore", "NoteRepository");
    project["contexts/project-management/src/utils.ts"] = "";
    project["contexts/project-management/src/domain/notes/note-text.test.ts"] = "";
    project["contexts/project-management/src/domain/notes/note-body.test.ts"] = "";
    const report = compareTrees(tree(exampleFiles()), tree(project));
    expect(report.missingFiles).toEqual(["contexts/<context>/src/adapters/in/trpc/notes/notes.router.ts"]);
    expect(report.extraFiles).toEqual(["contexts/<context>/src/utils.ts"]);
    expect(report.contracts).toEqual([{
      path: "contexts/<context>/src/application/notes/create-note/create-note.contract.ts",
      missing: ["CreateNoteStore"], extra: ["NoteRepository"],
    }]);
    expect(report.missingTestLevels).toEqual(["app smoke (web)"]);
    expect(report.extraTestLevels).toEqual([]);
    expect(report.shapes).toEqual([
      { shape: "contexts/<context>/src/adapters/in/trpc/<area>/<area>.router.ts", expected: 1, actual: 0 },
      { shape: "contexts/<context>/src/utils.ts", expected: 0, actual: 1 },
    ]);
    // Two domain unit files instead of one is not a delta: levels are compared by presence.
    expect(report.testLevels.find((row) => row.level === "domain unit")).toEqual({ level: "domain unit", expected: 1, actual: 2 });
    expect(report.deltas).toBe(6);
    const text = formatReport(report);
    expect(text).toMatch(/^structure: 6 structural delta/);
    expect(text).toContain("missing CreateNoteStore  extra NoteRepository");
  });

  test("renamed business names show as file deltas but not as shape deltas", () => {
    const project = Object.fromEntries(Object.entries(exampleFiles()).map(([path, content]) => [
      path.replaceAll("create-note", "add-note"), content.replaceAll("CreateNote", "AddNote"),
    ]));
    const report = compareTrees(tree(exampleFiles()), tree(project));
    expect(report.shapes).toEqual([]);
    expect(report.missingFiles.length).toBeGreaterThan(0);
    expect(report.missingFiles.length).toBe(report.extraFiles.length);
  });

  test("the report is deterministic", () => {
    const a = tree(exampleFiles());
    const b = tree({ ...exampleFiles("other"), "contexts/other/src/extra.ts": "" });
    expect(JSON.stringify(compareTrees(a, b))).toBe(JSON.stringify(compareTrees(a, b)));
  });
});

describe("the command", () => {
  test("takes the example from the environment or --example, never a default", () => {
    const example = tree(exampleFiles());
    const project = tree(exampleFiles("notebook"));
    expect(main([project], {}).code).toBe(2);
    expect(main([project], {}).out).toContain(EXAMPLE_ENV);
    expect(main([project], { [EXAMPLE_ENV]: example })).toEqual({ code: 0, out: expect.stringMatching(/no structural delta/) });
    expect(main(["--example", example, project], {}).code).toBe(0);
    expect(main(["--example", example], {}).code).toBe(2);
  });

  test("exits 1 on a delta and can print JSON", () => {
    const example = tree(exampleFiles());
    const project = tree({ ...exampleFiles(), "contexts/project-management/src/utils.ts": "" });
    const { code, out } = main(["--json", "--example", example, project], {});
    expect(code).toBe(1);
    expect(JSON.parse(out)).toMatchObject({ extraFiles: ["contexts/<context>/src/utils.ts"], deltas: 2 });
  });
});
