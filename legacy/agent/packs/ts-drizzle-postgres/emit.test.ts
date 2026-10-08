// The Drizzle emitters against the worked example's contracts (inline copies
// in testdata/): exact paths and text, generated-glob coverage, refusals, and
// a real type-check of the emitted files against the example's out ports.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { generatedFileGlobsFor, pathGlobMatcher } from "../../src/pack-contrib.ts";
import { composePacks } from "../../src/socket-registry.ts";
import { INSTALLED_PACKS } from "../installed.ts";
import { emittedFileProblem, skeletonEmitters, workspaceTemplates, type EmittedFile } from "../ts/pack.ts";
import type { FeatureContractModel } from "../ts/scripts/feature-model.ts";
import {
  drizzleConfigSource, emitDrizzlePersistence, emitDrizzleStores, migrationsTable, POSTGRES_IMAGE, schemaModuleSource,
} from "./scripts/emit.ts";
import { readStoreFeatures, storeFeatureFromModel } from "./scripts/store-features.ts";
import {
  APPLICATION_CONTRACTS, CONTEXT_DIR, contextWorkspace, DOMAIN_CONTRACTS, EXAMPLE_SCHEMA, exampleFacts, RESULT_SOURCE, SOURCE_ROOT,
} from "./testdata/example-project.ts";

const here = dirname(fileURLToPath(import.meta.url));
const agentRoot = resolve(here, "..", "..");
const packsDir = join(agentRoot, "packs");
const temporary: string[] = [];
afterAll(() => { for (const dir of temporary) rmSync(dir, { recursive: true, force: true }); });

const DRIZZLE = `${SOURCE_ROOT}/adapters/out/drizzle`;
const PACKS = ["ts", "ts-hexagonal", "ts-drizzle-postgres"];
const all = (): EmittedFile[] => [...emitDrizzlePersistence(exampleFacts()), ...emitDrizzleStores(exampleFacts())];
const file = (path: string): EmittedFile => {
  const found = all().find((f) => f.path === path);
  if (found === undefined) throw new Error(`not emitted: ${path}`);
  return found;
};

describe("what the example's design emits", () => {
  test("exactly these files, in these modes", () => {
    expect(all().map((f) => `${f.mode} ${f.path}`).sort()).toEqual([
      `generated ${CONTEXT_DIR}/drizzle.config.ts`,
      `generated ${DRIZZLE}/drizzle-database.ts`,
      `generated ${DRIZZLE}/drizzle-test-database.test-support.ts`,
      `generated ${DRIZZLE}/schema/project-management.schema.ts`,
      `skeleton ${DRIZZLE}/notes/create-note.store.ts`,
      `skeleton ${DRIZZLE}/notes/list-notes.store.ts`,
      `skeleton ${DRIZZLE}/projects/create-project.store.ts`,
      `skeleton ${DRIZZLE}/projects/export-projects.store.ts`,
      `skeleton ${DRIZZLE}/projects/list-projects.store.ts`,
      `skeleton ${DRIZZLE}/schema/notes.ts`,
      `skeleton ${DRIZZLE}/schema/projects.ts`,
    ]);
  });

  test("the pgSchema module is the example's, byte for byte", () => {
    expect(file(`${DRIZZLE}/schema/project-management.schema.ts`).content).toBe(EXAMPLE_SCHEMA["project-management.schema.ts"]);
    expect(schemaModuleSource("order-lines")).toContain('export const orderLines = pgSchema("order_lines");');
  });

  test("the config is the example's plus one per-context migrations table", () => {
    const example = [
      'import { defineConfig } from "drizzle-kit";',
      "",
      "export default defineConfig({",
      '  dialect: "postgresql",',
      '  schema: "./src/adapters/out/drizzle/schema",',
      '  out: "./src/adapters/out/drizzle/migrations",',
      "  dbCredentials: { url: process.env.DATABASE_URL! },",
      "});",
      "",
    ];
    const emitted = drizzleConfigSource("project-management").split("\n");
    expect(emitted.filter((line) => !line.includes("migrations: {") && !line.trim().startsWith("//"))).toEqual(example);
    expect(emitted).toContain('  migrations: { schema: "drizzle", table: "__drizzle_migrations_project_management" },');
    expect(migrationsTable("order-lines")).toBe("__drizzle_migrations_order_lines");
  });

  test("the database type is Drizzle's generic Postgres database and names no driver", () => {
    const source = file(`${DRIZZLE}/drizzle-database.ts`).content;
    expect(source).toContain("export type DrizzleDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;");
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(imports).toEqual(["drizzle-orm/pg-core"]);
  });

  test("a store skeleton has the TN-26-012 shape: Drizzle<Port>, (db: DrizzleDatabase), throwing members", () => {
    expect(file(`${DRIZZLE}/notes/create-note.store.ts`).content).toBe([
      'import type { CreateNoteStore } from "@example/project-management/application";',
      'import type { Note, ProjectId } from "@example/project-management/domain";',
      'import { NotImplementedError } from "../../../../domain/shared/errors.ts";',
      'import type { DrizzleDatabase } from "../drizzle-database.ts";',
      "",
      "export class DrizzleCreateNoteStore implements CreateNoteStore {",
      "  constructor(private readonly db: DrizzleDatabase) {}",
      "",
      "  async projectExists(id: ProjectId): Promise<boolean> {",
      '    throw new NotImplementedError("DrizzleCreateNoteStore.projectExists");',
      "  }",
      "",
      "  async save(note: Note): Promise<void> {",
      '    throw new NotImplementedError("DrizzleCreateNoteStore.save");',
      "  }",
      "}",
      "",
    ].join("\n"));
    expect(file(`${DRIZZLE}/projects/export-projects.store.ts`).content).toContain(
      "  async findAll(): Promise<Project[]> {\n    throw new NotImplementedError(\"DrizzleExportProjectsStore.findAll\");",
    );
    // ProjectExporter is not a store: no Drizzle adapter for it.
    expect(all().some((f) => f.content.includes("ProjectExporter"))).toBe(false);
  });

  test("an area schema skeleton defines nothing yet and shows the context's schema", () => {
    const source = file(`${DRIZZLE}/schema/notes.ts`).content;
    expect(source).toContain('//   export const notes = projectManagement.table("notes", {');
    expect(source.trimEnd().endsWith("export {};")).toBe(true);
  });

  test("the test support pins the compose file's image and skips on the red gate's variable", () => {
    const source = file(`${DRIZZLE}/drizzle-test-database.test-support.ts`).content;
    expect(source).toContain(`const POSTGRES_IMAGE = "${POSTGRES_IMAGE}";`);
    expect(source).toContain('const SCHEMA = "project_management";');
    expect(source).toContain('const MIGRATIONS_TABLE = "__drizzle_migrations_project_management";');
    expect(source).toContain('process.env["BOUNDED_STORE_TESTS_SKIP"]');
    // No container library is loaded until a store test runs.
    const staticImports = [...source.matchAll(/^import (?!type)[^"]*"([^"]+)"/gm)].map((m) => m[1]);
    expect(staticImports).toEqual(["bun:test", "node:url"]);
  });

  test("every file is safe and newline-terminated; generated files and only they match the pack's globs", () => {
    const generated = pathGlobMatcher(generatedFileGlobsFor(PACKS, packsDir));
    for (const f of all()) {
      expect(emittedFileProblem(f, "drizzle"), f.path).toBeUndefined();
      expect(generated(f.path), f.path).toBe(f.mode === "generated");
    }
    expect(generated(`${DRIZZLE}/migrations/0000_mute_wong.sql`)).toBe(true);
    expect(generated(`${DRIZZLE}/migrations/meta/_journal.json`)).toBe(true);
    expect(generated(`${DRIZZLE}/notes/note.mapper.ts`)).toBe(false);
    expect(generated(`${DRIZZLE}/notes/create-note.store.test.ts`)).toBe(false);
  });

  test("is deterministic and the same at every phase", () => {
    const design = all();
    for (const phase of ["design", "red", "deliver"] as const) {
      expect([...emitDrizzlePersistence(exampleFacts(phase)), ...emitDrizzleStores(exampleFacts(phase))]).toEqual(design);
    }
  });

  test("a context with no store, and a workspace that is not a context, emit nothing", () => {
    const noStore = contextWorkspace("billing", {
      "application/invoices/send-invoice/send-invoice.contract.ts":
        "export interface SendInvoice {\n  execute(): Promise<void>;\n}\n",
    });
    const app = { ...contextWorkspace("web"), kind: "web", dir: "apps/web", sourceRoot: "apps/web/src", contracts: [] };
    const facts = exampleFacts("design", [contextWorkspace(), noStore, app]);
    expect([...emitDrizzlePersistence(facts), ...emitDrizzleStores(facts)]).toEqual(all());
  });

  test("the composed emitters are the pack's two, and nothing else emits drizzle files", () => {
    // ts-hexagonal's emitters compose underneath; of the drizzle folder they
    // write only the barrel, adapters/out/drizzle/index.ts (TN-26-012 §6).
    const hexagonal = new Set(composePacks(INSTALLED_PACKS, ["ts", "ts-hexagonal"]).read(skeletonEmitters).map((e) => e.name));
    const emitters = composePacks(INSTALLED_PACKS, PACKS).read(skeletonEmitters);
    const own = emitters.filter((e) => !hexagonal.has(e.name));
    expect(own.map((e) => e.name)).toEqual(["drizzle-persistence", "drizzle-stores"]);
    expect(own.flatMap((e) => e.emit(exampleFacts()))).toEqual(all());
  });
});

// Issue #52: the project's own check needs only a container engine. Each app
// of a persisting project gets generated support that starts one migrated
// Postgres for its smoke tests and points DATABASE_URL at it, so neither a
// `.env` file nor a database someone started by hand is ever needed.
describe("each app's smoke tests get their own database (issue #52)", () => {
  const WEB_PACKS = ["ts", "ts-hexagonal", "ts-trpc", "ts-web", "ts-drizzle-postgres"];
  const web = { ...contextWorkspace("web"), kind: "web", dir: "apps/web", sourceRoot: "apps/web/src", packageName: "@example/web", contracts: [] };
  const appFacts = () => ({ ...exampleFacts("design", [contextWorkspace(), web]), packs: WEB_PACKS, workspaceTemplates: workspaceTemplates(WEB_PACKS, packsDir) });
  const SUPPORT = "apps/web/src/server/app-test-database.test-support.ts";

  test("each persisting app gets generated database support for its smoke tests", () => {
    const emitted = emitDrizzlePersistence(appFacts());
    const support = emitted.find((f) => f.path === SUPPORT);
    expect(support?.mode).toBe("generated");
    const source = support!.content;
    expect(source).toContain('import("@testcontainers/postgresql")');
    expect(source).toContain(POSTGRES_IMAGE);
    expect(source).toContain(migrationsTable("project-management"));
    expect(source).toContain("project-management/src/adapters/out/drizzle/migrations");
    expect(source).toMatch(/process\.env\[?["']?DATABASE_URL["']?\]?\s*=/);
    expect(source).toContain("180_000");
    expect(source).toMatch(/export function useAppDatabase\(\)/);
    // The red gate's token skips it as the store support skips.
    expect(source).toContain('process.env["BOUNDED_STORE_TESTS_SKIP"]');
    // The context's own files are unchanged; an app with no persisting
    // context gets nothing.
    expect(emitted.filter((f) => f.path !== SUPPORT)).toEqual(emitDrizzlePersistence(exampleFacts()));
    const noStore = contextWorkspace("billing", {
      "application/invoices/send-invoice/send-invoice.contract.ts": "export interface SendInvoice {\n  execute(): Promise<void>;\n}\n",
    });
    expect(emitDrizzlePersistence({ ...appFacts(), workspaces: [noStore, web] })).toEqual([]);
  });

  test("the generated support is covered by the pack's generatedFileGlobs", () => {
    const generated = pathGlobMatcher(generatedFileGlobsFor(WEB_PACKS, packsDir));
    expect(generated(SUPPORT)).toBe(true);
    for (const f of emitDrizzlePersistence(appFacts())) {
      expect(emittedFileProblem(f, "drizzle-persistence"), f.path).toBeUndefined();
      expect(generated(f.path), f.path).toBe(true);
    }
  });
});

describe("reading store ports refuses what a skeleton cannot print", () => {
  const read = (contract: string) => readStoreFeatures(contextWorkspace("pm", {
    "application/notes/create-note/create-note.contract.ts": contract,
  }));
  const DOMAIN = 'import type { Note, ProjectId } from "@example/pm/domain";\n';

  test("reads methods, parameters and the types to import", () => {
    expect(read(`${DOMAIN}export interface CreateNoteStore {\n  save(note: Note,\n    at: ProjectId): Promise<Note[]>;\n}\n`)).toEqual([{
      context: "pm", area: "notes", feature: "create-note",
      contractPath: "contexts/pm/src/application/notes/create-note/create-note.contract.ts",
      port: "CreateNoteStore",
      methods: [{ name: "save", parameters: [{ name: "note", type: "Note" }, { name: "at", type: "ProjectId" }], returns: "Promise<Note[]>" }],
      domainTypes: ["Note", "ProjectId"],
      applicationTypes: [],
    }]);
  });

  test.each([
    ["a store port with the wrong name", "export interface NotesStore {\n  save(): Promise<void>;\n}\n", /named exactly 'CreateNoteStore'/],
    ["a property", "export interface CreateNoteStore {\n  readonly size: number;\n}\n", /may declare only methods/],
    ["an overload", `${DOMAIN}export interface CreateNoteStore {\n  save(n: Note): Promise<void>;\n  save(): Promise<void>;\n}\n`, /overloaded/],
    ["a synchronous method", `${DOMAIN}export interface CreateNoteStore {\n  save(n: Note): void;\n}\n`, /must return a Promise/],
    ["an unknown type", "export interface CreateNoteStore {\n  save(n: Note): Promise<void>;\n}\n", /'Note', which is neither imported/],
    ["an optional parameter", `${DOMAIN}export interface CreateNoteStore {\n  save(n?: Note): Promise<void>;\n}\n`, /named, typed, required/],
    ["an untyped parameter", "export interface CreateNoteStore {\n  save(n): Promise<void>;\n}\n", /named, typed, required/],
    ["an empty port", "export interface CreateNoteStore {}\n", /declares no methods/],
  ])("%s", (_, contract, message) => {
    expect(() => read(contract)).toThrow(message);
  });

  test("a local type from the contract is imported from the application barrel", () => {
    const [feature] = read(`${DOMAIN}export interface Page {\n  readonly size: number;\n}\nexport interface CreateNoteStore {\n  list(page: Page): Promise<Note[]>;\n}\n`);
    expect(feature!.applicationTypes).toEqual(["Page"]);
  });

  test("ts-hexagonal's parsed model gives the same store model", () => {
    const concept = (name: string) => ({ kind: "concept" as const, text: name, name });
    const model = {
      context: "project-management", area: "notes", feature: "create-note", kind: "command",
      contractPath: `${SOURCE_ROOT}/application/notes/create-note/create-note.contract.ts`,
      domainImport: "@example/project-management/domain", domainTypes: ["Note", "NoteText", "ProjectId"],
      inPort: { name: "CreateNote", returns: { text: "Promise<Result<Note>>", result: true, shape: "value", concept: "Note" } },
      exposedVia: ["trpc"],
      outPorts: [{
        name: "CreateNoteStore", role: "store", isStore: true, implementedBy: [],
        methods: [
          { name: "projectExists", parameters: [{ name: "id", type: concept("ProjectId") }],
            returns: { kind: "promise", text: "Promise<boolean>", value: { kind: "primitive", text: "boolean", name: "boolean" } } },
          { name: "save", parameters: [{ name: "note", type: concept("Note") }],
            returns: { kind: "promise", text: "Promise<void>", value: { kind: "void", text: "void" } } },
        ],
      }],
    } satisfies FeatureContractModel;
    const fromFile = readStoreFeatures(contextWorkspace()).find((f) => f.feature === "create-note");
    expect(storeFeatureFromModel(model)).toEqual(fromFile);
    expect(storeFeatureFromModel({ ...model, outPorts: [] })).toBeUndefined();
  });
});

describe("the emitted files type-check against the example's out ports", () => {
  test("stores, database type and test support compile; any driver's database is a DrizzleDatabase", () => {
    const dir = mkdtempSync(join(tmpdir(), "drizzle-emit-"));
    temporary.push(dir);
    const write = (path: string, content: string): void => {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    };
    symlinkSync(join(agentRoot, "node_modules"), join(dir, "node_modules"), "dir");
    write("package.json", '{ "type": "module" }\n');
    for (const [path, source] of Object.entries({ ...APPLICATION_CONTRACTS, ...DOMAIN_CONTRACTS })) write(`${SOURCE_ROOT}/${path}`, source);
    write(`${SOURCE_ROOT}/domain/shared/result.ts`, RESULT_SOURCE);
    write(`${SOURCE_ROOT}/domain/shared/errors.ts`, [
      "export class NotImplementedError extends Error {",
      "  constructor(member: string) {",
      "    super(`Not implemented: ${member}`);",
      '    this.name = "NotImplementedError";',
      "  }",
      "}",
      "",
    ].join("\n"));
    // Type-only stand-ins for the generated barrels: the stores import only types.
    const typeExports = (contracts: Record<string, string>, prefix: string) => Object.entries(contracts)
      .map(([path, source]) => `export type { ${[...source.matchAll(/^export interface (\w+)/gm)].map((m) => m[1]).join(", ")} } from "./${path.slice(prefix.length)}";`)
      .join("\n") + "\n";
    write(`${SOURCE_ROOT}/domain/index.ts`, 'export type { Result } from "./shared/result.ts";\n' + typeExports(DOMAIN_CONTRACTS, "domain/"));
    write(`${SOURCE_ROOT}/application/index.ts`, typeExports(APPLICATION_CONTRACTS, "application/"));
    for (const f of all()) write(f.path, f.content);
    // A composition root, as an app would write one, for two drivers.
    write(`${SOURCE_ROOT}/wiring.ts`, [
      'import { drizzle as nodePostgres } from "drizzle-orm/node-postgres";',
      'import { drizzle as bunSql } from "drizzle-orm/bun-sql";',
      'import { Pool } from "pg";',
      'import type { CreateNoteStore } from "@example/project-management/application";',
      'import { DrizzleCreateNoteStore } from "./adapters/out/drizzle/notes/create-note.store.ts";',
      'import { DrizzleListProjectsStore } from "./adapters/out/drizzle/projects/list-projects.store.ts";',
      "",
      "export const lambdaStore: CreateNoteStore = new DrizzleCreateNoteStore(nodePostgres({ client: new Pool() }));",
      'export const webStore = new DrizzleListProjectsStore(bunSql("postgres://localhost/app"));',
      "",
    ].join("\n"));
    // bun:test's shape, for the test support (the harness has no Bun types).
    write("bun-test.d.ts", [
      'declare module "bun:test" {',
      "  type Hook = () => void | Promise<void>;",
      "  interface Describe { (name: string, body: () => void): void; skip(name: string, body: () => void): void }",
      "  export const describe: Describe;",
      "  export function beforeAll(hook: Hook, timeout?: number): void;",
      "  export function beforeEach(hook: Hook, timeout?: number): void;",
      "  export function test(name: string, body: () => void | Promise<void>): void;",
      "}",
      "",
    ].join("\n"));
    write("tsconfig.json", JSON.stringify({
      compilerOptions: {
        lib: ["ESNext"], target: "ESNext", module: "Preserve", moduleDetection: "force", moduleResolution: "bundler",
        allowImportingTsExtensions: true, verbatimModuleSyntax: true, noEmit: true, strict: true, skipLibCheck: true,
        noFallthroughCasesInSwitch: true, noUncheckedIndexedAccess: true, noImplicitOverride: true, types: ["node"],
        paths: { "@example/project-management/*": [`./${SOURCE_ROOT}/*/index.ts`] },
      },
      include: ["contexts/*/src", "bun-test.d.ts"],
    }));
    const tsc = () => spawnSync(process.execPath, [join(agentRoot, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"], {
      cwd: dir, encoding: "utf8",
    });
    const clean = tsc();
    expect(clean.stdout + clean.stderr).toBe("");
    expect(clean.status).toBe(0);
    // The check has teeth: a store that drifts from its port does not compile.
    const store = `${DRIZZLE}/notes/create-note.store.ts`;
    write(store, file(store).content.replace("save(note: Note)", "save(note: string)"));
    const broken = tsc();
    expect(broken.status).not.toBe(0);
    expect(broken.stdout).toMatch(/create-note\.store\.ts.*Property 'save' in type 'DrizzleCreateNoteStore' is not assignable/s);
  }, 120_000);
});
