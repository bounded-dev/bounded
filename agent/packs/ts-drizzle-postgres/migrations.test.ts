// The migration generator, the read-only check and db:migrate, against the
// pinned Drizzle Kit in temporary projects (no network, no database: the
// dependencies are the harness's own, and neither generate nor check connects).
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test, vi } from "vitest";
import {
  AmbiguousSchemaChange, drizzleContexts, historyHashes, MIGRATIONS_DIR, runDatabaseCheck, runKit, SCHEMA_DIR,
} from "./scripts/check-db.ts";
import { migrateAll } from "./scripts/db-migrate.ts";
import { drizzleConfigSource, schemaModuleSource } from "./scripts/emit.ts";
import { generateMigrations } from "./scripts/generate-migrations.ts";
import { EXAMPLE_FIRST_MIGRATION, EXAMPLE_SCHEMA } from "./testdata/example-project.ts";

const here = dirname(fileURLToPath(import.meta.url));
const agentRoot = resolve(here, "..", "..");
const temporary: string[] = [];
afterAll(() => { for (const dir of temporary) rmSync(dir, { recursive: true, force: true }); });

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}

const PM = "contexts/project-management";

/** A project whose contexts have the generated config and schema module plus
 *  the given area schema files; dependencies are the harness's, at the root. */
function project(contexts: Record<string, Record<string, string>>, options: { modules?: "root" | "context" | "none" } = {}): string {
  const dir = tempDir("drizzle-pg-");
  writeFileSync(join(dir, "package.json"), '{ "private": true, "type": "module", "workspaces": ["contexts/*"] }\n');
  if ((options.modules ?? "root") === "root") symlinkSync(join(agentRoot, "node_modules"), join(dir, "node_modules"), "dir");
  for (const [name, schema] of Object.entries(contexts)) {
    const context = join(dir, "contexts", name);
    mkdirSync(join(context, SCHEMA_DIR), { recursive: true });
    writeFileSync(join(context, "package.json"), `{ "name": "@example/${name}", "private": true, "type": "module" }\n`);
    writeFileSync(join(context, "drizzle.config.ts"), drizzleConfigSource(name));
    writeFileSync(join(context, SCHEMA_DIR, `${name}.schema.ts`), schemaModuleSource(name));
    for (const [file, source] of Object.entries(schema)) writeFileSync(join(context, SCHEMA_DIR, file), source);
    if (options.modules === "context") symlinkSync(join(agentRoot, "node_modules"), join(context, "node_modules"), "dir");
  }
  return dir;
}

const EXAMPLE_AREAS = { "notes.ts": EXAMPLE_SCHEMA["notes.ts"]!, "projects.ts": EXAMPLE_SCHEMA["projects.ts"]! };
const history = (dir: string, context = PM): string[] => [...historyHashes(join(dir, context, MIGRATIONS_DIR)).keys()];
const renamed = EXAMPLE_SCHEMA["projects.ts"]!.replace('name: text("name")', 'title: text("title")');

describe("generateMigrations (the golden test against the worked example)", () => {
  test("the example's schema generates the example's first migration, apart from its random name", () => {
    const dir = project({ "project-management": EXAMPLE_AREAS });
    const lines = generateMigrations(dir);
    expect(lines[0]).toBe(`${PM}: migrations generated from the schema (3 file(s) written)`);
    const files = history(dir);
    expect(files).toHaveLength(3);
    expect(files).toEqual(expect.arrayContaining(["meta/_journal.json", "meta/0000_snapshot.json"]));
    const sql = files.find((f) => /^0000_[a-z]+(?:_[a-z]+)*\.sql$/.test(f));
    expect(sql).toBeDefined();
    expect(readFileSync(join(dir, PM, MIGRATIONS_DIR, sql!), "utf8")).toBe(EXAMPLE_FIRST_MIGRATION);
  }, 60_000);

  test("the check then passes without writing, and an unchanged schema generates nothing", () => {
    const dir = project({ "project-management": EXAMPLE_AREAS });
    expect(runDatabaseCheck(dir).summary).toBe(`database schema and committed migrations differ in ${PM}`);
    generateMigrations(dir);
    const before = historyHashes(join(dir, PM, MIGRATIONS_DIR));
    expect(runDatabaseCheck(dir)).toEqual({ verdict: "pass", summary: `database migrations match the schema in ${PM}` });
    expect(historyHashes(join(dir, PM, MIGRATIONS_DIR))).toEqual(before);
    expect(generateMigrations(dir)[0]).toBe(`${PM}: no schema change, nothing generated`);
    expect(historyHashes(join(dir, PM, MIGRATIONS_DIR))).toEqual(before);
  }, 90_000);

  test("a later change adds the next migration and keeps the committed ones", () => {
    const dir = project({ "project-management": EXAMPLE_AREAS });
    generateMigrations(dir);
    const before = historyHashes(join(dir, PM, MIGRATIONS_DIR));
    writeFileSync(join(dir, PM, SCHEMA_DIR, "tags.ts"), [
      'import { text, uuid } from "drizzle-orm/pg-core";',
      'import { projectManagement } from "./project-management.schema.ts";',
      'export const tags = projectManagement.table("tags", { id: uuid("id").primaryKey(), label: text("label").notNull() });',
      "",
    ].join("\n"));
    generateMigrations(dir);
    const after = historyHashes(join(dir, PM, MIGRATIONS_DIR));
    for (const [name, hash] of before) if (name !== "meta/_journal.json") expect(after.get(name), name).toBe(hash);
    const next = [...after.keys()].find((f) => f.startsWith("0001_") && f.endsWith(".sql"))!;
    expect(readFileSync(join(dir, PM, MIGRATIONS_DIR, next), "utf8")).toContain('CREATE TABLE "project_management"."tags"');
    expect(runDatabaseCheck(dir).verdict).toBe("pass");
  }, 90_000);

  test("finds Drizzle Kit in the context's own dependency folder (Bun's isolated installs)", () => {
    const dir = project({ "project-management": EXAMPLE_AREAS }, { modules: "context" });
    generateMigrations(dir);
    expect(history(dir)).toHaveLength(3);
    expect(runDatabaseCheck(dir).verdict).toBe("pass");
  }, 60_000);
});

describe("ambiguity and failure fail closed", () => {
  test("an ambiguous rename is refused with nothing written, and the check blocks on it", () => {
    const dir = project({ "project-management": EXAMPLE_AREAS });
    generateMigrations(dir);
    const before = historyHashes(join(dir, PM, MIGRATIONS_DIR));
    writeFileSync(join(dir, PM, SCHEMA_DIR, "projects.ts"), renamed);
    expect(() => generateMigrations(dir)).toThrow(AmbiguousSchemaChange);
    expect(() => generateMigrations(dir)).toThrow(/ambiguous.*bunx drizzle-kit generate` in contexts\/project-management/s);
    expect(historyHashes(join(dir, PM, MIGRATIONS_DIR))).toEqual(before);
    const check = runDatabaseCheck(dir);
    expect(check.verdict).toBe("block");
    expect(check.summary).toBe("database schema and committed migrations differ, ambiguously");
  }, 90_000);

  test("across contexts it is all or nothing: one ambiguous context leaves every other one unwritten", () => {
    const dir = project({ billing: {}, "project-management": EXAMPLE_AREAS });
    generateMigrations(dir);
    const pm = historyHashes(join(dir, PM, MIGRATIONS_DIR));
    writeFileSync(join(dir, "contexts/billing", SCHEMA_DIR, "invoices.ts"), [
      'import { uuid } from "drizzle-orm/pg-core";',
      'import { billing } from "./billing.schema.ts";',
      'export const invoices = billing.table("invoices", { id: uuid("id").primaryKey() });',
      "",
    ].join("\n"));
    writeFileSync(join(dir, PM, SCHEMA_DIR, "projects.ts"), renamed);
    const billing = historyHashes(join(dir, "contexts/billing", MIGRATIONS_DIR));
    expect(() => generateMigrations(dir)).toThrow(AmbiguousSchemaChange);
    expect(historyHashes(join(dir, "contexts/billing", MIGRATIONS_DIR))).toEqual(billing);
    expect(historyHashes(join(dir, PM, MIGRATIONS_DIR))).toEqual(pm);
  }, 90_000);

  test("each context keeps its own history and migrations table", () => {
    const dir = project({ billing: {}, "project-management": EXAMPLE_AREAS });
    generateMigrations(dir);
    const sql = (context: string) => readdirSync(join(dir, context, MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql"))
      .map((f) => readFileSync(join(dir, context, MIGRATIONS_DIR, f), "utf8")).join("\n");
    expect(sql("contexts/billing")).toBe('CREATE SCHEMA "billing";\n');
    expect(sql(PM)).toBe(EXAMPLE_FIRST_MIGRATION);
    expect(readFileSync(join(dir, "contexts/billing/drizzle.config.ts"), "utf8")).toContain('table: "__drizzle_migrations_billing"');
  }, 90_000);

  test("a corrupt snapshot blocks the check and the generator", () => {
    const dir = project({ "project-management": EXAMPLE_AREAS });
    generateMigrations(dir);
    writeFileSync(join(dir, PM, MIGRATIONS_DIR, "meta/0000_snapshot.json"), "{ not json");
    const check = runDatabaseCheck(dir);
    expect(check.verdict).toBe("block");
    expect(check.summary).toBe("database migration check failed");
    expect(() => generateMigrations(dir)).toThrow(/drizzle-kit generate in contexts\/project-management failed/);
  }, 60_000);

  test("half a layout, a missing Drizzle Kit, and no persistence at all", () => {
    const half = project({ "project-management": EXAMPLE_AREAS });
    rmSync(join(half, PM, "drizzle.config.ts"));
    expect(() => drizzleContexts(half)).toThrow(`${PM} has src/adapters/out/drizzle/ but no drizzle.config.ts`);
    expect(runDatabaseCheck(half)).toMatchObject({ verdict: "block", summary: "database layout is incomplete" });
    expect(() => generateMigrations(half)).toThrow(/but no drizzle\.config\.ts/);

    const noSchema = project({ "project-management": {} });
    rmSync(join(noSchema, PM, "src"), { recursive: true });
    expect(() => generateMigrations(noSchema)).toThrow(`${PM} has drizzle.config.ts but no src/adapters/out/drizzle/schema/`);

    const bare = project({ "project-management": EXAMPLE_AREAS }, { modules: "none" });
    expect(() => generateMigrations(bare)).toThrow(`project dependencies are missing: drizzle-kit is not installed for ${PM}`);
    expect(runDatabaseCheck(bare).verdict).toBe("block");

    const none = tempDir("drizzle-pg-none-");
    expect(runDatabaseCheck(none)).toEqual({ verdict: "pass", summary: "no context has Drizzle persistence" });
    expect(generateMigrations(none)).toEqual(["no context has Drizzle persistence; nothing to generate"]);
  }, 60_000);
});

describe("runKit", () => {
  /** A Drizzle Kit stand-in script. */
  function fakeKit(body: string): string {
    const bin = join(tempDir("drizzle-fake-"), "bin.cjs");
    writeFileSync(bin, body);
    chmodSync(bin, 0o755);
    return bin;
  }
  const cwd = tmpdir();

  test("an interactive prompt without a terminal, which exits 0, is an ambiguous change", () => {
    const bin = fakeKit('console.error("Error: Interactive prompts require a TTY terminal (process.stdin.isTTY or process.stdout.isTTY is false).");');
    expect(() => runKit(bin, cwd, "generate", process.env, "contexts/x")).toThrow(AmbiguousSchemaChange);
  });

  test("anything on stderr is a failure even with exit 0; a non-zero exit is a failure", () => {
    expect(() => runKit(fakeKit('console.error("Error: broken");'), cwd, "generate", process.env, "contexts/x"))
      .toThrow("drizzle-kit generate in contexts/x failed (exit 0): Error: broken");
    expect(() => runKit(fakeKit("process.exit(3);"), cwd, "check", process.env, "contexts/x")).toThrow(/exit 3/);
  });

  test("a hang is cut off at the timeout, with stdin closed", () => {
    const bin = fakeKit('process.stdin.resume(); process.stdin.on("end", () => setTimeout(() => {}, 60000));');
    const started = Date.now();
    expect(() => runKit(bin, cwd, "generate", process.env, "contexts/x", 500)).toThrow(/did not finish within 0.5s/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test("returns stdout, passing the command and the context's config", () => {
    expect(runKit(fakeKit('console.log("done " + process.argv.slice(2).join(" "));'), cwd, "generate", process.env, "contexts/x"))
      .toBe("done generate --config=drizzle.config.ts\n");
  });
});

describe("db:migrate", () => {
  /** Contexts whose Drizzle Kit is a stand-in that records where it ran. */
  function migratable(exits: Record<string, number>): { dir: string; log: string } {
    const dir = tempDir("drizzle-migrate-");
    const log = join(dir, "log.txt");
    for (const [name, code] of Object.entries(exits)) {
      const context = join(dir, "contexts", name);
      mkdirSync(join(context, SCHEMA_DIR), { recursive: true });
      writeFileSync(join(context, "drizzle.config.ts"), drizzleConfigSource(name));
      const bin = join(context, "node_modules/drizzle-kit/bin.cjs");
      mkdirSync(dirname(bin), { recursive: true });
      writeFileSync(bin, `require("node:fs").appendFileSync(${JSON.stringify(log)}, "${name} " + process.argv.slice(2).join(" ") + " " + process.env.DATABASE_URL + "\\n"); process.exit(${code});`);
    }
    return { dir, log };
  }

  test("migrates every context in directory order with the inherited DATABASE_URL", () => {
    const { dir, log } = migratable({ "project-management": 0, billing: 0 });
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(migrateAll(dir, { ...process.env, DATABASE_URL: "postgres://db/app" })).toBe(0);
    expect(readFileSync(log, "utf8")).toBe(
      "billing migrate --config=drizzle.config.ts postgres://db/app\nproject-management migrate --config=drizzle.config.ts postgres://db/app\n",
    );
    vi.restoreAllMocks();
  });

  test("stops at the first failing context, and refuses without DATABASE_URL", () => {
    const { dir, log } = migratable({ a: 2, b: 0 });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(migrateAll(dir, { ...process.env, DATABASE_URL: "postgres://db/app" })).toBe(1);
    expect(readFileSync(log, "utf8")).toBe("a migrate --config=drizzle.config.ts postgres://db/app\n");
    expect(errors.mock.calls.flat().join("\n")).toContain("contexts/a failed (exit 2); later contexts were not migrated");
    const env = { ...process.env };
    delete env.DATABASE_URL;
    expect(migrateAll(dir, env)).toBe(1);
    expect(errors.mock.calls.flat().join("\n")).toContain("DATABASE_URL is not set");
    expect(existsSync(log)).toBe(true);
    vi.restoreAllMocks();
  });
});
