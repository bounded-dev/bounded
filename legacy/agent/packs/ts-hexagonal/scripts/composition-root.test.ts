import { describe, expect, test } from "vitest";
import type { AdapterTechnology, ProjectFacts, WorkspaceFacts } from "../../ts/pack.ts";
import type { FeatureContractModel } from "../../ts/scripts/feature-model.ts";
import { EXAMPLE_CONTEXT, EXAMPLE_PACKS, exampleContracts, exampleFacts } from "../../example-suite/example-facts.ts";
import { type ComposeFunction, compositionRoot, compositionStorage } from "./composition-root.ts";
import { contextModels } from "./context-model.ts";

// The generated composition root's own rules (ADR LEG-2026-067), beside the app
// packs' goldens: which storage backs the stores, how the database is made
// once, the grouped shape, and what it refuses. The app packs supply only the
// functions; this file plays every app kind through one spec.

const WITH_POSTGRES = [...EXAMPLE_PACKS, "ts-drizzle-postgres"];

const app = (facts: ProjectFacts, kind: string): WorkspaceFacts => facts.workspaces.find((w) => w.kind === kind)!;
const features = (facts: ProjectFacts, ...names: string[]): FeatureContractModel[] =>
  contextModels(facts).flatMap((m) => m.features).filter((f) => names.includes(f.feature));

function root(facts: ProjectFacts, kind: string, functions: readonly ComposeFunction[]): string {
  return compositionRoot(facts, {
    app: app(facts, kind),
    path: `${app(facts, kind).sourceRoot}/composition-root.ts`,
    imports: functions.map((fn) => ({ from: "@example/project-management/adapters/x", values: [fn.factory] })),
    functions,
  }).content;
}

const composeApp = (facts: ProjectFacts, ...names: string[]): ComposeFunction =>
  ({ name: "composeApp", returns: "unknown", factory: "createX", features: features(facts, ...names) });

describe("the storage a composition root constructs", () => {
  test("without a connected technology: the in-memory database, once, shared by every store", () => {
    const facts = exampleFacts();
    expect(compositionStorage(facts).id).toBe("in-memory");
    const text = root(facts, "web", [composeApp(facts, "create-note", "list-notes")]);
    expect(text.match(/new InMemoryDatabase\(\)/g)).toHaveLength(1);
    expect(text).toContain("      create: new CreateNoteHandler(new InMemoryCreateNoteStore(db)),\n");
    expect(text).not.toContain("process.env");
  });

  test("with one: its driver for the app's runtime, connected once from its environment variable, never a fallback", () => {
    const facts = exampleFacts({ packs: WITH_POSTGRES });
    expect(compositionStorage(facts).id).toBe("drizzle");
    const bun = root(facts, "web", [composeApp(facts, "create-note")]);
    expect(bun).toContain('import { drizzle } from "drizzle-orm/bun-sql";');
    expect(bun).toContain("  const db = drizzle(connectionUrl());\n");
    expect(bun).toContain("      create: new CreateNoteHandler(new DrizzleCreateNoteStore(db)),\n");
    expect(bun).toContain([
      "function connectionUrl(): string {",
      "  const value = process.env.DATABASE_URL;",
      '  if (value === undefined || value === "") throw new Error("DATABASE_URL is not set");',
      "  return value;",
      "}",
    ].join("\n"));
    expect(bun).not.toContain("InMemory");
    // The helper's name is fixed, so a variable named like a local cannot clash (review repro: `DB`).
    const short = { ...facts, adapterTechnologies: facts.adapterTechnologies.map((t) =>
      (t.id === "drizzle" ? { ...t, connect: { ...t.connect!, env: "DB" } } : t)) };
    const db = root(short, "web", [composeApp(short, "create-note")]);
    expect(db).toContain("  const db = drizzle(connectionUrl());\n");
    expect(db).toContain("  const value = process.env.DB;\n");
    expect(db.match(/\bdb\b/g)).toHaveLength(2);
    const node = root(facts, "lambdas", [composeApp(facts, "create-note")]);
    expect(node).toContain('import { drizzle } from "drizzle-orm/node-postgres";');
  });

  test("a feature with no store builds no database", () => {
    const contracts = exampleContracts().map((c) => c.path.endsWith("list-notes.contract.ts")
      ? { ...c, source: c.source.replace(/\nexport interface ListNotesStore \{[^}]*\}\n/, "\n") }
      : c);
    const facts = exampleFacts({ contracts });
    const text = root(facts, "web", [composeApp(facts, "list-notes")]);
    expect(text).toContain("  return createX({\n    notes: {\n      list: new ListNotesHandler(),\n");
    expect(text).not.toContain("Database");
  });

  test("another out port takes the adapter its @implementedBy names, after the store, in declaration order", () => {
    const facts = exampleFacts();
    expect(root(facts, "lambdas", [composeApp(facts, "export-projects")])).toContain(
      "      export: new ExportProjectsHandler(new InMemoryExportProjectsStore(db), new ConsoleProjectExporter()),\n",
    );
  });
});

describe("refusals", () => {
  const drizzle = (facts: ProjectFacts): AdapterTechnology => facts.adapterTechnologies.find((t) => t.id === "drizzle")!;

  test("an app runtime the connected technology has no driver for", () => {
    const facts = exampleFacts({ packs: WITH_POSTGRES });
    const bunOnly = { ...drizzle(facts), connect: { ...drizzle(facts).connect!, runtimes: { bun: drizzle(facts).connect!.runtimes["bun"]! } } };
    const edited = { ...facts, adapterTechnologies: facts.adapterTechnologies.map((t) => (t.id === "drizzle" ? bunOnly : t)) };
    expect(() => root(edited, "lambdas", [composeApp(edited, "create-note")]))
      .toThrow("apps/lambdas (lambdas) runs on 'node', for which the storage technology 'drizzle' declares no connect driver");
  });

  test("a connect function named like the composition root's own locals", () => {
    const facts = exampleFacts({ packs: WITH_POSTGRES });
    const named = (fn: string) => ({ ...drizzle(facts), connect: { ...drizzle(facts).connect!, runtimes: { bun: { function: fn, from: "drizzle-orm/bun-sql" } } } });
    for (const fn of ["db", "connectionUrl"]) {
      const edited = { ...facts, adapterTechnologies: facts.adapterTechnologies.map((t) => (t.id === "drizzle" ? named(fn) : t)) };
      expect(() => root(edited, "web", [composeApp(edited, "create-note")])).toThrow(`names its connect function '${fn}'`);
    }
  });

  test("two connected storage technologies", () => {
    const facts = exampleFacts({ packs: WITH_POSTGRES });
    const twin = { ...drizzle(facts), id: "other-db" };
    const edited = { ...facts, adapterTechnologies: [...facts.adapterTechnologies, twin] };
    expect(() => compositionStorage(edited)).toThrow(/2 composed storage technologies could back the stores \(drizzle, other-db\)/);
  });

  test("an @implementedBy technology that is not composed", () => {
    const facts = exampleFacts();
    const edited = { ...facts, adapterTechnologies: facts.adapterTechnologies.filter((t) => t.id !== "console") };
    expect(() => root(edited, "lambdas", [composeApp(facts, "export-projects")]))
      .toThrow(/export-projects\.contract\.ts: ProjectExporter has no composed @implementedBy technology/);
  });
});

describe("layout", () => {
  test("one function per entry, each with its own database; a name two contexts share is aliased", () => {
    const facts = exampleFacts();
    const billing: WorkspaceFacts = {
      ...facts.workspaces.find((w) => w.dir === EXAMPLE_CONTEXT)!,
      dir: "contexts/billing", name: "billing", packageName: "@example/billing", sourceRoot: "contexts/billing/src",
      contracts: exampleContracts()
        .filter((c) => c.path.includes("/domain/projects/") || c.path.includes("/application/projects/list-projects/"))
        .map((c) => ({ path: c.path.replace(EXAMPLE_CONTEXT, "contexts/billing"), source: c.source.replaceAll("@example/project-management/", "@example/billing/") })),
    };
    const both = { ...facts, workspaces: [billing, ...facts.workspaces] };
    const list = contextModels(both).flatMap((m) => m.features).filter((f) => f.feature === "list-projects");
    expect(list.map((f) => f.context)).toEqual(["billing", "project-management"]);
    const text = root(both, "lambdas", list.map((f, i) => ({ name: `compose${i}`, returns: "unknown", factory: "createX", features: [f] })));
    // The first context to import a name keeps it; the next is prefixed with its own context.
    expect(text).toContain('import { ListProjectsHandler } from "@example/billing/application";');
    expect(text).toContain('import { ListProjectsHandler as ProjectManagementListProjectsHandler } from "@example/project-management/application";');
    expect(text).toContain("  InMemoryDatabase as ProjectManagementInMemoryDatabase,\n");
    expect(text).toContain("export function compose0(): unknown {\n  const db = new InMemoryDatabase();\n");
    expect(text).toContain("export function compose1(): unknown {\n  const db = new ProjectManagementInMemoryDatabase();\n");
    expect(text).toContain("      list: new ProjectManagementListProjectsHandler(new ProjectManagementInMemoryListProjectsStore(db)),\n");
  });

  test("a constructor call wider than the line breaks one adapter per line", () => {
    const long = (s: string) => s.replaceAll("ProjectExporter", "ProjectExporterToAVeryFarAwayArchiveService");
    const contracts = exampleContracts().map((c) => (c.path.endsWith("export-projects.contract.ts") ? { ...c, source: long(c.source) } : c));
    const edited = exampleFacts({ contracts });
    expect(root(edited, "lambdas", [composeApp(edited, "export-projects")])).toContain([
      "      export: new ExportProjectsHandler(",
      "        new InMemoryExportProjectsStore(db),",
      "        new ConsoleProjectExporterToAVeryFarAwayArchiveService(),",
      "      ),",
    ].join("\n"));
  });

  test("is marked generated, starts with the do-not-edit header, and is pure", () => {
    const facts = exampleFacts();
    const spec = { app: app(facts, "web"), path: "apps/web/src/server/composition-root.ts", imports: [], functions: [composeApp(facts, "create-note")] };
    const file = compositionRoot(facts, spec);
    expect(file.mode).toBe("generated");
    expect(file.content.split("\n")[0]).toBe("// Generated from the design (ADR LEG-2026-067); do not edit: the design gate regenerates it.");
    expect(compositionRoot(facts, spec)).toEqual(file);
  });
});
