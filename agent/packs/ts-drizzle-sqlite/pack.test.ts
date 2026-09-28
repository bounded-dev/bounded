// ts-drizzle-sqlite (ADR 2026-055): the seed, the path policy over generated
// files, the Drizzle Kit wrapper, the migration generator, the read-only
// migration check, and the seeded runtime, against real Drizzle Kit in
// temporary projects (no network: node_modules is the harness's own).
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { projectIgnoreRules } from "../../src/pack-contrib.ts";
import { decide, type Role } from "../../src/path-policy.ts";
import { SURFACE_SCRIPT } from "../ts/scripts/deliver.ts";
import { packageFor, shippedFiles } from "../ts/scripts/project-package.ts";
import { AmbiguousSchemaChange, historyHashes, runDatabaseCheck, runKit } from "./scripts/check-migrations.ts";
import { generateMigrations } from "./scripts/generate-migrations.ts";
import { seedDatabase, seedFiles } from "./scripts/new-database.ts";

const here = dirname(fileURLToPath(import.meta.url));
const agentRoot = resolve(here, "..", "..");
const packsDir = join(agentRoot, "packs");
const temporary: string[] = [];
afterAll(() => { for (const dir of temporary) rmSync(dir, { recursive: true, force: true }); });

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}

/** A seeded project using the harness's installed Drizzle Kit and driver. */
function project(schema?: string): string {
  const dir = tempDir("drizzle-pack-");
  writeFileSync(join(dir, "package.json"), '{ "type": "module" }\n');
  symlinkSync(join(agentRoot, "node_modules"), join(dir, "node_modules"), "dir");
  cpSync(join(here, "reference", "drizzle.config.ts"), join(dir, "drizzle.config.ts"));
  seedDatabase(dir);
  if (schema !== undefined) writeFileSync(join(dir, "src/db/schema.ts"), schema);
  return dir;
}

const USERS = [
  'import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";',
  'export const users = sqliteTable("users", { id: integer("id").primaryKey(), name: text("name") });',
  "",
].join("\n");

const history = (dir: string): string[] => [...historyHashes(join(dir, "migrations")).keys()].sort();

describe("seedDatabase", () => {
  test("seeds the pack's reference sources and the two directory markers, nothing else", () => {
    const dir = tempDir("drizzle-seed-");
    seedDatabase(dir);
    for (const name of ["schema.ts", "client.ts", "migrate.ts"]) {
      expect(readFileSync(join(dir, "src/db", name), "utf8")).toBe(readFileSync(join(here, "reference/db", name), "utf8"));
    }
    expect(existsSync(join(dir, "migrations/.gitkeep"))).toBe(true);
    expect(existsSync(join(dir, "data/.gitkeep"))).toBe(true);
    // Config, ignore rules and the check are generated from pack data instead.
    expect(existsSync(join(dir, ".gitignore"))).toBe(false);
    expect(existsSync(join(dir, "drizzle.config.ts"))).toBe(false);
    expect(existsSync(join(dir, "src/db/drizzle.config.ts"))).toBe(false);
    expect(existsSync(join(dir, "src/db/migrations"))).toBe(false);
  });

  test("is idempotent, and refuses project work before writing anything", () => {
    const dir = tempDir("drizzle-seed-");
    seedDatabase(dir);
    expect(() => seedDatabase(dir)).not.toThrow();
    const other = tempDir("drizzle-seed-");
    mkdirSync(join(other, "src/db"), { recursive: true });
    writeFileSync(join(other, "src/db/migrate.ts"), "// the project's own\n");
    expect(() => seedDatabase(other)).toThrow(/src\/db\/migrate\.ts already contains project work/);
    expect(existsSync(join(other, "src/db/schema.ts"))).toBe(false);
  });

  test("prefers the project's installed harness copy of the reference files", () => {
    const dir = tempDir("drizzle-seed-");
    const installed = join(dir, ".bounded/harness/packs/ts-drizzle-sqlite/reference/db");
    mkdirSync(installed, { recursive: true });
    for (const name of ["schema.ts", "client.ts", "migrate.ts"]) writeFileSync(join(installed, name), `// installed ${name}\n`);
    expect(seedFiles(dir).get("src/db/client.ts")).toBe("// installed client.ts\n");
  });
});

describe("generated files are write-denied for every role", () => {
  const ctx = {
    cwd: "/p",
    contractGlobs: ["src/**/*.contract.ts"],
    writeProtection: { dirNames: ["node_modules"], fileNames: ["package.json", "tsconfig*.json"] },
  };
  const roles: Role[] = ["architect", "test-writer", "builder", "reviewer"];
  const generated = [
    "migrations/0001_add_users.sql",
    "migrations/meta/0001_snapshot.json",
    "migrations/meta/_journal.json",
    "/p/migrations/0000_init.sql",
    "drizzle.config.ts",
    "scripts/check-db.ts",
  ];
  for (const role of roles) {
    test(`${role} may not write or remove a migration, its snapshot, or the generated config`, () => {
      for (const path of generated) {
        for (const tool of ["write", "edit", "remove"]) {
          expect(decide(role, tool, { path }, ctx).allow, `${role} ${tool} ${path}`).toBe(false);
        }
      }
    });
  }

  test("the builder still owns the schema and repositories, and every role can read migrations", () => {
    expect(decide("builder", "write", { path: "src/db/schema.ts" }, ctx).allow).toBe(true);
    expect(decide("builder", "write", { path: "src/db/users-repository.ts" }, ctx).allow).toBe(true);
    for (const role of roles) expect(decide(role, "read", { path: "migrations/0000_init.sql" }, ctx).allow).toBe(true);
  });
});

describe("pack data", () => {
  test("the manifest folds check:db into check, runs it like check:surface, and uses the root config", () => {
    const pkg = packageFor(["ts", "ts-drizzle-sqlite"], packsDir);
    expect(pkg.scripts!["check"]).toMatch(/npm run check:surface && npm run check:db$/);
    expect(pkg.scripts!["check:db"]).toBe(SURFACE_SCRIPT.replace("scripts/surface-check.ts", "scripts/check-db.ts"));
    expect(pkg.scripts!["db:generate"]).toBe("drizzle-kit generate --config=drizzle.config.ts");
    expect(pkg.scripts!["db:migrate"]).toBe("drizzle-kit migrate --config=drizzle.config.ts");
    expect(shippedFiles(["ts", "ts-drizzle-sqlite"], packsDir).map((f) => f.path)).toEqual(["scripts/surface-check.ts", "scripts/check-db.ts"]);
  });

  test("identical pins merge with ts-service's, so either composition is valid", () => {
    const alone = packageFor(["ts", "ts-drizzle-sqlite"], packsDir);
    const both = packageFor(["ts", "ts-drizzle-sqlite", "ts-service"], packsDir);
    expect(alone.devDependencies!["@types/node"]).toBe(both.devDependencies!["@types/node"]);
    const harness = JSON.parse(readFileSync(join(agentRoot, "package.json"), "utf8")) as { devDependencies: Record<string, string> };
    for (const name of ["drizzle-kit", "drizzle-orm", "@libsql/client"]) {
      expect({ ...alone.dependencies, ...alone.devDependencies }[name], name).toBe(harness.devDependencies[name]);
    }
  });

  test("the ignore rules are root-anchored and accepted by the core", () => {
    expect(projectIgnoreRules(["ts", "ts-drizzle-sqlite"], packsDir)).toEqual(expect.arrayContaining(["/data/*.sqlite", "/data/*.db-*"]));
  });

  test("the shipped check imports nothing but Node built-ins", () => {
    const source = readFileSync(join(here, "scripts/check-migrations.ts"), "utf8");
    const specifiers = [...source.matchAll(/^import[^"']*["']([^"']+)["']/gm)].map((m) => m[1]!);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.every((s) => s.startsWith("node:"))).toBe(true);
  });
});

describe("runKit", () => {
  /** A project whose drizzle-kit is a script standing in for it. */
  function fakeKit(body: string): string {
    const dir = tempDir("drizzle-fake-");
    const bin = join(dir, "node_modules/drizzle-kit/bin.cjs");
    mkdirSync(dirname(bin), { recursive: true });
    writeFileSync(bin, body);
    chmodSync(bin, 0o755);
    return dir;
  }

  test("an interactive prompt without a terminal, which exits 0, is an ambiguous change", () => {
    const dir = fakeKit('console.error("Error: Interactive prompts require a TTY terminal (process.stdin.isTTY or process.stdout.isTTY is false).");');
    expect(() => runKit(dir, "generate", process.env)).toThrow(AmbiguousSchemaChange);
    expect(() => runKit(dir, "generate", process.env)).toThrow(/rename or a drop-and-create.*npm run db:generate/);
  });

  test("anything on stderr is a failure even with exit 0; a non-zero exit is a failure", () => {
    expect(() => runKit(fakeKit('console.error("Error: broken");'), "generate", process.env)).toThrow(/drizzle-kit generate failed \(exit 0\): Error: broken/);
    expect(() => runKit(fakeKit("process.exit(3);"), "check", process.env)).toThrow(/exit 3/);
  });

  test("a hang is cut off at the timeout, with stdin closed", () => {
    const dir = fakeKit('process.stdin.resume(); process.stdin.on("end", () => setTimeout(() => {}, 60000));');
    const started = Date.now();
    expect(() => runKit(dir, "generate", process.env, 500)).toThrow(/did not finish within 0.5s/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test("returns stdout, and names missing dependencies", () => {
    expect(runKit(fakeKit('console.log("done " + process.argv.slice(2).join(" "));'), "generate", process.env))
      .toBe("done generate --config=drizzle.config.ts\n");
    expect(() => runKit(tempDir("drizzle-empty-"), "generate", process.env)).toThrow(/drizzle-kit is not installed/);
  });
});

describe("generateMigrations and runDatabaseCheck with the pinned Drizzle Kit", () => {
  test("generation writes the SQL and snapshot into migrations/; the check then passes without writing", () => {
    const dir = project(USERS);
    expect(runDatabaseCheck(dir).summary).toBe("database schema and committed migrations differ");
    const lines = generateMigrations(dir);
    expect(lines[0]).toBe("migrations generated from the schema");
    const files = history(dir);
    expect(files).toHaveLength(3);
    expect(files.filter((f) => /^\d{4}_[a-z_]+\.sql$/.test(f))).toHaveLength(1);
    expect(files).toEqual(expect.arrayContaining(["meta/_journal.json", "meta/0000_snapshot.json"]));
    const before = historyHashes(join(dir, "migrations"));
    expect(runDatabaseCheck(dir)).toEqual({ verdict: "pass", summary: "database migrations match the schema and apply to a fresh SQLite database" });
    expect(historyHashes(join(dir, "migrations"))).toEqual(before);
    expect(existsSync(join(dir, "data/app.sqlite"))).toBe(false);
    // No schema change: nothing new.
    generateMigrations(dir);
    expect(history(dir)).toEqual(files);
  }, 60_000);

  test("an ambiguous rename is refused with nothing written, and the check blocks on it", () => {
    const dir = project(USERS);
    generateMigrations(dir);
    const files = history(dir);
    writeFileSync(join(dir, "src/db/schema.ts"), USERS.replace('name: text("name")', 'fullName: text("full_name")'));
    expect(() => generateMigrations(dir)).toThrow(AmbiguousSchemaChange);
    expect(history(dir)).toEqual(files);
    const check = runDatabaseCheck(dir);
    expect(check.verdict).toBe("block");
    expect(check.summary).toMatch(/ambiguously/);
  }, 60_000);

  test("the check blocks a history that does not apply, and a missing schema", () => {
    const dir = project(USERS);
    generateMigrations(dir);
    const sql = readdirSync(join(dir, "migrations")).find((f) => f.endsWith(".sql"))!;
    writeFileSync(join(dir, "migrations", sql), "CREATE TABLE `users` (`id` integer PRIMARY KEY NOT NULL,;\n");
    const broken = runDatabaseCheck(dir);
    expect(broken.verdict).toBe("block");
    rmSync(join(dir, "src/db/schema.ts"));
    expect(runDatabaseCheck(dir).summary).toBe("database schema is missing at src/db/schema.ts");
    expect(() => generateMigrations(dir)).toThrow(/schema is missing/);
  }, 60_000);
});

describe("the seeded runtime is independent of the working directory", () => {
  test("migrateDb applies the project's migrations to its default database, wherever the process started", async () => {
    const dir = project(USERS);
    generateMigrations(dir);
    const saved = process.env["DATABASE_URL"];
    delete process.env["DATABASE_URL"];
    try {
      expect(process.cwd()).not.toBe(dir);
      const migrate = await import(pathToFileURL(join(dir, "src/db/migrate.ts")).href) as { migrateDb(): Promise<void>; migrationsFolder: string };
      expect(migrate.migrationsFolder).toBe(join(dir, "migrations"));
      await migrate.migrateDb();
      const client = await import(pathToFileURL(join(dir, "src/db/client.ts")).href) as { client: { execute(sql: string): Promise<{ rows: unknown[] }>; close(): void }; defaultDatabaseUrl: string };
      expect(client.defaultDatabaseUrl).toBe(pathToFileURL(join(dir, "data/app.sqlite")).href);
      expect((await client.client.execute("SELECT name FROM sqlite_master WHERE name = 'users'")).rows).toHaveLength(1);
      client.client.close();
      expect(existsSync(join(dir, "data/app.sqlite"))).toBe(true);
    } finally {
      if (saved === undefined) delete process.env["DATABASE_URL"]; else process.env["DATABASE_URL"] = saved;
    }
  }, 60_000);

  test("a file:/// URL with an encoded space creates the directory the driver opens", async () => {
    const dir = project(USERS);
    const target = join(dir, "state dir", "nested", "db.sqlite");
    const saved = process.env["DATABASE_URL"];
    process.env["DATABASE_URL"] = pathToFileURL(target).href;
    try {
      expect(process.env["DATABASE_URL"]).toContain("%20");
      const client = await import(pathToFileURL(join(dir, "src/db/client.ts")).href) as {
        client: { execute(sql: string): Promise<unknown>; close(): void };
        databaseFile(url: string): string | undefined;
      };
      await client.client.execute("CREATE TABLE t (x)");
      client.client.close();
      expect(existsSync(target)).toBe(true);
      expect(existsSync(join(dir, "state%20dir"))).toBe(false);
      expect(client.databaseFile("file:///abs/a%20b/x.db")).toBe("/abs/a b/x.db");
      expect(client.databaseFile("file://localhost/abs/x.db")).toBe("/abs/x.db");
      expect(client.databaseFile("file:/abs/x.db?mode=ro")).toBe("/abs/x.db");
      expect(client.databaseFile("file:rel/x.db")).toBe(resolve("rel/x.db"));
      expect(client.databaseFile("file::memory:")).toBeUndefined();
      expect(client.databaseFile("libsql://example.turso.io")).toBeUndefined();
      expect(() => client.databaseFile("file://remote/x.db")).toThrow(/names a host/);
    } finally {
      if (saved === undefined) delete process.env["DATABASE_URL"]; else process.env["DATABASE_URL"] = saved;
    }
  }, 60_000);
});

describe("an initialized project (ADR 2026-054)", () => {
  test("generates its Drizzle config, check and ignore rules from pack data, with no drift", async () => {
    const { applyInit, planInit } = await import("../../src/project-init.ts");
    const { configDrift, generatedConfig } = await import("../ts/scripts/project-config.ts");
    const dir = join(tempDir("drizzle-init-"), "app");
    const plan = await planInit(dir, "claude-code", ["ts-drizzle-sqlite"]);
    expect(plan.packs).toEqual(["ts", "ts-drizzle-sqlite"]);
    await applyInit(dir, "claude-code", ["ts-drizzle-sqlite"], plan.digest);
    const harness = join(dir, ".bounded", "harness");
    expect(configDrift(dir, harness)).toEqual([]);
    expect([...generatedConfig(dir, harness).files.keys()].sort())
      .toEqual(["drizzle.config.ts", "package.json", "scripts/check-db.ts", "scripts/surface-check.ts", "tsconfig.json"]);
    expect(readFileSync(join(dir, "drizzle.config.ts"), "utf8")).toBe(readFileSync(join(here, "reference/drizzle.config.ts"), "utf8"));
    expect(readFileSync(join(dir, "scripts/check-db.ts"), "utf8")).toBe(readFileSync(join(here, "scripts/check-migrations.ts"), "utf8"));
    expect(readFileSync(join(dir, "src/db/client.ts"), "utf8")).toBe(readFileSync(join(here, "reference/db/client.ts"), "utf8"));
    expect(existsSync(join(dir, "migrations/.gitkeep"))).toBe(true);
    const ignore = readFileSync(join(dir, ".gitignore"), "utf8").split("\n");
    expect(ignore).toEqual(expect.arrayContaining(["/data/*.sqlite", "/data/*.sqlite-*", "/data/*.db", "/data/*.db-*", "/node_modules/"]));
    expect(ignore.filter((line) => line.startsWith("/data/"))).toHaveLength(4);
    // A hand edit to the executable config is drift, which every toolchain gate refuses.
    writeFileSync(join(dir, "drizzle.config.ts"), "export default {};\n");
    expect(configDrift(dir, harness).map((d) => d.path)).toEqual(["drizzle.config.ts"]);
  }, 180_000);
});

describe("a schema with no tables yet", () => {
  test("passes the check, before and after a generation that writes only an empty journal", () => {
    const dir = project();
    expect(runDatabaseCheck(dir).verdict).toBe("pass");
    generateMigrations(dir);
    expect(history(dir)).toEqual(["meta/_journal.json"]);
    expect(runDatabaseCheck(dir).verdict).toBe("pass");
  }, 60_000);
});
