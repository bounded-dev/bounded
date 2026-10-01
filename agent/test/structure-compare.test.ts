// The dogfood structure comparer lives with the other repo experiments in
// scripts/dogfood/ (ADR 2026-042); its tests run here so `npm run check`
// covers it. Every tree is a fixture built in a temporary directory: the
// worked example itself is a local checkout and is never read by a test.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  checkConventions, compareTrees, declaredAppKinds, EXAMPLE_ENV, formatConventionsReport, interfaceTags, packTechnologies, EXPECTED_DELTAS, exportedNames, formatReport, main, namedPath, productFiles, requiredTestLevels,
  shapeOf, signatureOf, testLevel,
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
    [`${c}/src/application/notes/create-note/create-note.command.laws.test.ts`]: "",
    [`${c}/src/adapters/in/trpc/notes/notes.router.ts`]: "",
    [`${c}/src/adapters/in/trpc/notes/create-note.procedure.ts`]: "",
    [`${c}/src/adapters/in/trpc/notes/create-note.procedure.laws.test.ts`]: "",
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

  test("only the context segment and the schema namespace file are renamed, even when an area shares the name", () => {
    expect(namedPath("contexts/notes/src/domain/notes/note-text.ts", "notes")).toBe("contexts/<context>/src/domain/notes/note-text.ts");
    expect(namedPath("contexts/notes/src/application/notes/list-notes/list-notes.handler.ts", "notes"))
      .toBe("contexts/<context>/src/application/notes/list-notes/list-notes.handler.ts");
    expect(namedPath("contexts/notes/src/adapters/out/drizzle/schema/notes.schema.ts", "notes"))
      .toBe("contexts/<context>/src/adapters/out/drizzle/schema/<context>.schema.ts");
    expect(namedPath("contexts/notes/src/adapters/out/drizzle/schema/notes.ts", "notes"))
      .toBe("contexts/<context>/src/adapters/out/drizzle/schema/notes.ts");
    expect(namedPath("contexts/notes/src/domain/notes/notes-summary.contract.ts", "notes"))
      .toBe("contexts/<context>/src/domain/notes/notes-summary.contract.ts");
    expect(namedPath("apps/notes/src/main.ts", "notes")).toBe("apps/notes/src/main.ts");
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
      "store (in-memory)": 1, "app smoke (web)": 1, "command laws": 1, "in-adapter laws (trpc)": 1,
    });
  });
});

describe("comparing two trees", () => {
  test("the same structure under another context name and other migration names has no delta", () => {
    const report = compareTrees(tree(exampleFiles()), tree(exampleFiles("notebook", "0000_brave_hulk")));
    expect(report.deltas).toBe(0);
    expect(formatReport(report)).toMatch(/^structure: 0 unexpected structural deltas/);
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
    expect(report.shapes).toEqual([
      { shape: "contexts/<context>/src/adapters/in/trpc/<area>/<area>.router.ts", expected: 1, actual: 0 },
      { shape: "contexts/<context>/src/utils.ts", expected: 0, actual: 1 },
    ]);
    // Two domain unit files instead of one is not a delta: levels are checked by presence.
    expect(report.testLevels.find((row) => row.level === "domain unit")).toEqual({ level: "domain unit", expected: 1, actual: 2 });
    expect(report.deltas).toBe(6);
    const text = formatReport(report);
    expect(text).toMatch(/^structure: 6 unexpected structural delta/);
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

  test("test levels are checked against what the project's files require, not against the example's tests", () => {
    // An example with no tests beyond the architecture test, like the worked
    // example, does not excuse a project from any level.
    const bare = Object.fromEntries(Object.entries(exampleFiles())
      .filter(([path]) => !/\.test(?:-support)?\.ts$/.test(path) || path === "architecture.test.ts"));
    const project = exampleFiles();
    delete project["contexts/project-management/src/application/notes/create-note/create-note.test.ts"];
    project["contexts/project-management/src/adapters/out/console/notes/export-notes.exporter.ts"] = "";
    const report = compareTrees(tree(bare), tree(project));
    expect(report.missingTestLevels).toEqual(["handler", "out adapter (console)"]);
    expect(requiredTestLevels(signatureOf(tree(exampleFiles())).files.keys())).toEqual([
      "app smoke (web)", "architecture", "command laws", "domain laws", "domain unit", "handler",
      "in-adapter laws (trpc)", "store (in-memory)", "store conformance suite",
    ]);
  });

  test("the example's known gaps are listed with their reasons and not counted", () => {
    const example = { ...exampleFiles(), "apps/web/src/server/seed.ts": "" };
    const d = "contexts/project-management/src/adapters/out/drizzle";
    const project = {
      ...exampleFiles(),
      [`${d}/notes/create-note.store.ts`]: "", [`${d}/notes/create-note.store.test.ts`]: "",
      [`${d}/notes/note.mapper.ts`]: "", [`${d}/drizzle-database.ts`]: "", [`${d}/index.ts`]: "",
      "contexts/project-management/src/domain/shared/errors.ts": "",
    };
    const report = compareTrees(tree(example), tree(project));
    expect(report.deltas).toBe(0);
    expect(report.expectedDeltas.map((row) => `${row.side} ${row.path}`)).toEqual([
      "missing apps/web/src/server/seed.ts",
      "extra contexts/<context>/src/adapters/out/drizzle/drizzle-database.ts",
      "extra contexts/<context>/src/adapters/out/drizzle/index.ts",
      "extra contexts/<context>/src/adapters/out/drizzle/notes/create-note.store.ts",
      "extra contexts/<context>/src/adapters/out/drizzle/notes/note.mapper.ts",
      "extra contexts/<context>/src/domain/shared/errors.ts",
    ]);
    for (const row of report.expectedDeltas) expect(row.reason.length).toBeGreaterThan(20);
    for (const entry of EXPECTED_DELTAS) expect(entry.reason, String(entry.pattern)).toMatch(/\w{3,}/);
    expect(formatReport(report)).toMatch(/^structure: 0 unexpected structural deltas against the example \(6 expected/);
    // The allowlist is exact about its side: a seed file the project adds is
    // not the example's gap, and a Drizzle store the example has but the
    // project lacks is a real delta.
    const reversed = compareTrees(tree(project), tree(example));
    expect(reversed.expectedDeltas).toEqual([]);
    expect(reversed.deltas).toBeGreaterThan(0);
  });

  test("the report is deterministic", () => {
    const a = tree(exampleFiles());
    const b = tree({ ...exampleFiles("other"), "contexts/other/src/extra.ts": "" });
    expect(JSON.stringify(compareTrees(a, b))).toBe(JSON.stringify(compareTrees(a, b)));
  });
});

// --- the conventions alone -------------------------------------------------------

const PACKS = join(import.meta.dirname, "..", "packs");

/** Every file under a directory inside the repository, relative to it. */
function filesUnder(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (abs: string): void => {
    for (const name of readdirSync(abs).sort()) {
      const path = join(abs, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(dir, path).split("\\").join("/")] = readFileSync(path, "utf8");
    }
  };
  walk(dir);
  return out;
}

const prefixed = (prefix: string, files: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(files).map(([path, content]) => [`${prefix}/${path}`, content]));

/**
 * The current worked example as a delivered run of it stands, assembled from
 * the harness's in-repository copies: the root config and the domain's
 * generated laws (ts/reference), the tagged context with its tests and out
 * adapters (ts-hexagonal/reference), the generated in adapters and the four
 * apps (example-suite/reference). The copies leave out only what is generated
 * or written at green: each in adapter's laws and each app's smoke test.
 */
function workedExample(): Record<string, string> {
  const ex = join(PACKS, "example-suite", "reference", "example");
  const files: Record<string, string> = {
    ...Object.fromEntries(Object.entries(filesUnder(join(PACKS, "ts", "reference")))
      .filter(([path]) => path !== "README.md" && (!path.startsWith("contexts/") || path.endsWith(".laws.test.ts")))),
    ...prefixed("contexts", filesUnder(join(PACKS, "ts-hexagonal", "reference", "contexts"))),
    "architecture.test.ts": readFileSync(join(PACKS, "ts-hexagonal", "reference", "architecture-test.ts"), "utf8"),
    ...prefixed("docs", filesUnder(join(PACKS, "ts-hexagonal", "reference", "docs"))),
    ...prefixed("apps", filesUnder(join(ex, "apps"))),
  };
  for (const [path, content] of Object.entries(prefixed("contexts", filesUnder(join(ex, "contexts"))))) {
    if (path.includes("/adapters/in/")) files[path] = content;
  }
  for (const path of Object.keys(files)) {
    if (/\/adapters\/in\/[^/]+\/[^/]+\/[^/.]+\.[a-z]+\.ts$/.test(path) && !path.endsWith(".router.ts")) {
      files[path.replace(/\.ts$/, ".laws.test.ts")] = "";
    }
    if (path.endsWith("/composition-root.ts")) files[path.replace(/\.ts$/, ".test.ts")] = "";
  }
  return files;
}

const PM = "contexts/project-management";

/** The findings on a tree, as `rule path`. */
function findingsOf(files: Record<string, string>): string[] {
  return checkConventions(tree(files)).findings.map((f) => `${f.rule} ${f.path}`);
}

describe("judging a project against the conventions alone", () => {
  test("the current worked example follows them", () => {
    const report = checkConventions(tree(workedExample()));
    expect(report.findings).toEqual([]);
    expect(formatConventionsReport(report)).toMatch(/^structure: 0 convention findings/);
    expect(report.inventory).toEqual({
      contexts: ["project-management"], concepts: 6, features: 5,
      apps: [
        { app: "apps/desktop", kind: "desktop" }, { app: "apps/lambdas", kind: "lambdas" },
        { app: "apps/mcp", kind: "mcp" }, { app: "apps/web", kind: "web" },
      ],
    });
  });

  test("another product in the same shape follows them too: no example's names are needed", () => {
    const rename = (text: string): string => text
      .replaceAll("Project", "Clinician").replaceAll("project", "clinician")
      .replaceAll("Note", "Appointment").replaceAll("note", "appointment");
    const clinic = Object.fromEntries(Object.entries(workedExample()).map(([path, content]) => [rename(path), rename(content)]));
    const report = checkConventions(tree(clinic));
    expect(report.findings).toEqual([]);
    expect(report.inventory.contexts).toEqual(["clinician-management"]);
  });

  test.each<[string, (files: Record<string, string>) => void, string[]]>([
    ["a file outside the layout", (f) => { f[`${PM}/src/utils.ts`] = ""; }, [`layout ${PM}/src/utils.ts`]],
    ["a missing root config file", (f) => { delete f["tsconfig.base.json"]; }, ["layout tsconfig.base.json"]],
    ["a missing generated barrel", (f) => { delete f[`${PM}/src/application/index.ts`]; }, [`layout ${PM}/src/application/index.ts`]],
    ["a name that is not kebab-case", (f) => {
      f[`${PM}/src/domain/notes/noteBody.ts`] = "";
    }, [`naming ${PM}/src/domain/notes/noteBody.ts`, `feature files ${PM}/src/domain/notes/noteBody.contract.ts`]],
    ["an unknown role suffix", (f) => {
      f[`${PM}/src/application/notes/create-note/create-note.service.ts`] = "";
    }, [`naming ${PM}/src/application/notes/create-note/create-note.service.ts`]],
    ["a file not named for its feature", (f) => {
      f[`${PM}/src/application/notes/create-note/add-note.handler.ts`] = "";
    }, [`naming ${PM}/src/application/notes/create-note/add-note.handler.ts`]],
    ["a feature of one word", (f) => {
      for (const path of Object.keys(f).filter((p) => p.includes("/list-notes/") || p.includes("/list-notes."))) {
        f[path.replaceAll("list-notes", "notes")] = f[path]!.replaceAll("ListNotes", "Notes");
        delete f[path];
      }
    }, [`naming ${PM}/src/application/notes/notes`]],
    ["a singular area", (f) => {
      f[`${PM}/src/domain/billing/invoice.contract.ts`] = "export interface Invoice {}";
      f[`${PM}/src/domain/billing/invoice.ts`] = "";
      f[`${PM}/src/domain/billing/invoice.test.ts`] = "";
      f[`${PM}/src/domain/billing/invoice.laws.test.ts`] = "";
    }, [`naming ${PM}/src/*/billing`]],
    ["a store port under another name", (f) => {
      const path = `${PM}/src/application/notes/create-note/create-note.contract.ts`;
      f[path] = f[path]!.replace("CreateNoteStore", "NoteStore");
    }, [
      `naming ${PM}/src/application/notes/create-note/create-note.contract.ts`,
      `feature files ${PM}/src/adapters/out/in-memory/notes/create-note.store.ts`,
      `feature files ${PM}/src/application/notes/create-note/create-note.store.test-support.ts`,
    ]],
    ["a missing handler", (f) => {
      delete f[`${PM}/src/application/projects/list-projects/list-projects.handler.ts`];
    }, [`feature files ${PM}/src/application/projects/list-projects/list-projects.handler.ts`]],
    ["a missing generated command", (f) => {
      delete f[`${PM}/src/application/notes/create-note/create-note.command.ts`];
    }, [`feature files ${PM}/src/application/notes/create-note/create-note.command.ts`]],
    ["a missing store for a storage technology in use", (f) => {
      delete f[`${PM}/src/adapters/out/in-memory/projects/export-projects.store.ts`];
      delete f[`${PM}/src/adapters/out/in-memory/projects/export-projects.store.test.ts`];
    }, [
      `feature files ${PM}/src/adapters/out/in-memory/projects/export-projects.store.ts`,
      `test levels ${PM}/src/adapters/out/in-memory/projects/export-projects.store.test.ts`,
    ]],
    ["a missing in adapter its @exposedVia calls for", (f) => {
      delete f[`${PM}/src/adapters/in/mcp/projects/list-projects.tool.ts`];
      delete f[`${PM}/src/adapters/in/mcp/projects/list-projects.tool.laws.test.ts`];
    }, [`feature files ${PM}/src/adapters/in/mcp/projects/list-projects.tool.ts`]],
    ["an in adapter with the wrong feature role", (f) => {
      f[`${PM}/src/adapters/in/trpc/notes/list-notes.query.ts`] = "";
      f[`${PM}/src/adapters/in/trpc/notes/list-notes.query.laws.test.ts`] = "";
    }, [`naming ${PM}/src/adapters/in/trpc/notes/list-notes.query.ts`]],
    ["an adapter for a feature that does not exist", (f) => {
      f[`${PM}/src/adapters/out/console/projects/archive-projects.exporter.ts`] = "";
    }, [`feature files ${PM}/src/adapters/out/console/projects/archive-projects.exporter.ts`]],
    ["a missing out adapter its @implementedBy calls for", (f) => {
      delete f[`${PM}/src/adapters/out/console/projects/export-projects.exporter.ts`];
      delete f[`${PM}/src/adapters/out/console/projects/export-projects.exporter.test.ts`];
    }, [`feature files ${PM}/src/adapters/out/console/projects/export-projects.exporter.ts`]],
    ["missing tests at every level", (f) => {
      for (const path of [
        "architecture.test.ts", `${PM}/src/domain/notes/note-text.test.ts`, `${PM}/src/domain/notes/note-text.laws.test.ts`,
        `${PM}/src/application/notes/create-note/create-note.test.ts`,
        `${PM}/src/application/notes/create-note/create-note.command.laws.test.ts`,
        `${PM}/src/application/notes/create-note/create-note.store.test-support.ts`,
        `${PM}/src/adapters/out/in-memory/notes/create-note.store.test.ts`,
        `${PM}/src/adapters/out/console/projects/export-projects.exporter.test.ts`,
        `${PM}/src/adapters/in/trpc/notes/create-note.procedure.laws.test.ts`,
        "apps/web/src/server/composition-root.test.ts",
      ]) delete f[path];
    }, [
      "test levels apps/web/src/server/composition-root.test.ts",
      "test levels architecture.test.ts",
      `test levels ${PM}/src/adapters/in/trpc/notes/create-note.procedure.laws.test.ts`,
      `test levels ${PM}/src/adapters/out/console/projects/export-projects.exporter.test.ts`,
      `test levels ${PM}/src/adapters/out/in-memory/notes/create-note.store.test.ts`,
      `test levels ${PM}/src/application/notes/create-note/create-note.command.laws.test.ts`,
      `test levels ${PM}/src/application/notes/create-note/create-note.store.test-support.ts`,
      `test levels ${PM}/src/application/notes/create-note/create-note.test.ts`,
      `test levels ${PM}/src/domain/notes/note-text.laws.test.ts`,
      `test levels ${PM}/src/domain/notes/note-text.test.ts`,
    ]],
    ["a missing app template file", (f) => { delete f["apps/web/src/client/main.tsx"]; }, ["apps apps/web/src/client/main.tsx"]],
    ["a missing Lambda entry", (f) => { delete f["apps/lambdas/src/export-projects.ts"]; }, ["apps apps/lambdas/src/export-projects.ts"]],
    ["an app of no known kind", (f) => { f["apps/cli/src/run.ts"] = ""; f["apps/cli/package.json"] = "{}"; }, ["apps apps/cli"]],
  ])("a mutated copy is flagged: %s", (_name, mutate, expected) => {
    const files = workedExample();
    mutate(files);
    expect(findingsOf(files)).toEqual(expected);
  });

  test("an app's kind comes from the TNs' workspaces maps before its files", () => {
    const files = {
      ...workedExample(),
      "docs/tn/TN-1-design.md": "---\nnumber: TN-1\nworkspaces:\n  apps/web: mcp\n  apps/mcp: mcp\n---\n# design\n",
    };
    const root = tree(files);
    expect([...declaredAppKinds(root)]).toEqual([["apps/web", "mcp"], ["apps/mcp", "mcp"]]);
    expect(checkConventions(root).findings.map((f) => `${f.rule} ${f.path}`))
      .toEqual(["apps apps/web/src/composition-root.ts", "apps apps/web/src/main.ts"]);
  });

  test("tags are read from the block directly above each interface", () => {
    const source = readFileSync(join(PACKS, "ts-hexagonal", "reference", PM, "src/application/projects/export-projects/export-projects.contract.ts"), "utf8");
    expect(Object.fromEntries(interfaceTags(source))).toEqual({
      ExportProjects: { exposedVia: ["lambda"], implementedBy: [] },
      ProjectExporter: { exposedVia: [], implementedBy: ["console"] },
    });
  });

  test("the technologies' feature roles come from the packs", () => {
    const known = packTechnologies();
    expect(Object.fromEntries(known.featureRoles)).toMatchObject({ trpc: "procedure", mcp: "tool", lambda: "lambda" });
    expect(Object.fromEntries(known.storage)).toMatchObject({ "in-memory": true, drizzle: true, console: false });
  });

  test("the report is deterministic", () => {
    const files = workedExample();
    delete files[`${PM}/src/domain/notes/note.test.ts`];
    const root = tree(files);
    expect(JSON.stringify(checkConventions(root))).toBe(JSON.stringify(checkConventions(root)));
  });
});

describe("the command", () => {
  test("takes the example from the environment or --example, and judges by the conventions without one", () => {
    const example = tree(exampleFiles());
    const project = tree(exampleFiles("notebook"));
    expect(main([project], { [EXAMPLE_ENV]: example })).toEqual({ code: 0, out: expect.stringMatching(/0 unexpected structural deltas/) });
    expect(main(["--example", example, project], {}).code).toBe(0);
    expect(main(["--example", example], {}).code).toBe(2);
    expect(main(["--example"], {}).code).toBe(2);
    expect(main([project], {}).out).toMatch(/convention finding/);
    expect(main(["--conventions", project], { [EXAMPLE_ENV]: example }).out).toMatch(/convention finding/);
    expect(main([tree(workedExample())], {})).toEqual({ code: 0, out: expect.stringMatching(/^structure: 0 convention findings/) });
  });

  test("exits 1 on a delta and can print JSON", () => {
    const example = tree(exampleFiles());
    const project = tree({ ...exampleFiles(), "contexts/project-management/src/utils.ts": "" });
    const { code, out } = main(["--json", "--example", example, project], {});
    expect(code).toBe(1);
    expect(JSON.parse(out)).toMatchObject({ extraFiles: ["contexts/<context>/src/utils.ts"], deltas: 2 });
    const conventions = main(["--json", project], {});
    expect(conventions.code).toBe(1);
    expect(JSON.parse(conventions.out).findings).toContainEqual({
      rule: "layout", path: "contexts/project-management/src/utils.ts", message: expect.any(String),
    });
  });
});
