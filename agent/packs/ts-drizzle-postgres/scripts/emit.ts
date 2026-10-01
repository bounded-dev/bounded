// The Drizzle Postgres emitters (ADR 2026-060, TN-26-012 §5 and §7). Pure
// functions from the project's facts to file text: no disk, clock or
// environment, so the same design always emits the same bytes.
//
// A context gets Drizzle files exactly when one of its features declares a
// store out port. Then, under C = contexts/<context>/src:
//
//   contexts/<context>/drizzle.config.ts                     generated
//   C/adapters/out/drizzle/drizzle-database.ts               generated
//   C/adapters/out/drizzle/schema/<context>.schema.ts        generated
//   C/adapters/out/drizzle/drizzle-test-database.test-support.ts  generated
//   C/adapters/out/drizzle/schema/<area>.ts                  skeleton, per area with a store
//   C/adapters/out/drizzle/<area>/<feature>.store.ts         skeleton, per store
//
// ts-hexagonal, not this pack, emits C/adapters/out/drizzle/index.ts
// (TN-26-012, "Changes from the plan" 3). Migrations come from the
// generate_artifacts gate, never from an emitter.
import type { EmittedFile, ProjectFacts, WorkspaceFacts } from "../../ts/pack.ts";
import { adapterClassPrefix, camelCase, snakeCase } from "../../ts/scripts/naming.ts";
import { readStoreFeatures, type StoreFeature } from "./store-features.ts";

/** The adapter technology id this pack contributes. */
export const DRIZZLE = "drizzle";
/** The class prefix of every Drizzle adapter: `Drizzle`. */
export const DRIZZLE_PREFIX = adapterClassPrefix(DRIZZLE);
/** The workspace template kind whose workspaces are bounded contexts. */
export const CONTEXT_KIND = "context";
/** The Postgres image the local database and the store tests run. Pinned
 *  exactly, and the same in docker-compose.yml (pack.test.ts checks it). */
export const POSTGRES_IMAGE = "postgres:17.6";
/** Set by the red gate, to the reason, when no container runtime is available
 *  (ADR 2026-064). The generated test support skips every store test only
 *  when STORE_TESTS_PHASE_ENV is also RED_PHASE_TOKEN, and fails otherwise. */
export const STORE_TESTS_SKIP_ENV = "BOUNDED_STORE_TESTS_SKIP";
/** The red gate's token, set only in the test child's environment. */
export const STORE_TESTS_PHASE_ENV = "BOUNDED_STORE_TESTS_PHASE";
export const RED_PHASE_TOKEN = "red";
/** Drizzle's own schema, where every context keeps its migrations table. */
export const MIGRATIONS_SCHEMA = "drizzle";

/** Reads a workspace's store features; `readStoreFeatures` by default. */
export type StoreFeatureReader = (workspace: WorkspaceFacts) => readonly StoreFeature[];

/** The Postgres schema a context's tables live in: `project_management`. */
export const pgSchemaName = (context: string): string => snakeCase(context);
/** The variable the context's schema module exports: `projectManagement`. */
export const pgSchemaVariable = (context: string): string => camelCase(context);
/** One migrations table per context, so contexts sharing a database never
 *  read each other's history: `__drizzle_migrations_project_management`. */
export const migrationsTable = (context: string): string => `__drizzle_migrations_${snakeCase(context)}`;

const drizzleDir = (workspace: WorkspaceFacts): string => `${workspace.sourceRoot}/adapters/out/${DRIZZLE}`;

export function drizzleConfigSource(context: string): string {
  return `import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/adapters/out/drizzle/schema",
  out: "./src/adapters/out/drizzle/migrations",
  dbCredentials: { url: process.env.DATABASE_URL! },
  // One migrations table per context, so contexts sharing a database never read each other's history.
  migrations: { schema: "${MIGRATIONS_SCHEMA}", table: "${migrationsTable(context)}" },
});
`;
}

export function drizzleDatabaseSource(): string {
  return `import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

// The database every Drizzle store in this context receives. It is Drizzle's
// generic Postgres database, never a driver: each composition root picks the
// driver for its runtime (drizzle-orm/bun-sql, drizzle-orm/node-postgres).
export type ${DRIZZLE_PREFIX}Database = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;
`;
}

export function schemaModuleSource(context: string): string {
  return `import { pgSchema } from "drizzle-orm/pg-core";

// Every table in this context lives in its own Postgres schema.
export const ${pgSchemaVariable(context)} = pgSchema("${pgSchemaName(context)}");
`;
}

export function areaSchemaSource(context: string, area: string): string {
  return `// Tables of the ${area} area, each created in this context's Postgres schema:
//
//   import { text, uuid } from "drizzle-orm/pg-core";
//   import { ${pgSchemaVariable(context)} } from "./${context}.schema.ts";
//
//   export const ${camelCase(area)} = ${pgSchemaVariable(context)}.table("${snakeCase(area)}", {
//     id: uuid("id").primaryKey(),
//   });
//
// The generate_artifacts gate derives each migration from this folder.
export {};
`;
}

export function storeSkeletonSource(feature: StoreFeature, packageName: string): string {
  const className = `${DRIZZLE_PREFIX}${feature.port}`;
  const application = [feature.port, ...feature.applicationTypes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const imports = [
    `import type { ${application.join(", ")} } from "${packageName}/application";`,
    ...(feature.domainTypes.length > 0 ? [`import type { ${feature.domainTypes.join(", ")} } from "${packageName}/domain";`] : []),
    `import { NotImplementedError } from "../../../../domain/shared/errors.ts";`,
    `import type { ${DRIZZLE_PREFIX}Database } from "../${DRIZZLE}-database.ts";`,
  ];
  const methods = feature.methods.map((method) => {
    const parameters = method.parameters.map((p) => `${p.name}: ${p.type}`).join(", ");
    return `  async ${method.name}(${parameters}): ${method.returns} {\n` +
      `    throw new NotImplementedError("${className}.${method.name}");\n  }`;
  });
  return `${imports.join("\n")}

export class ${className} implements ${feature.port} {
  constructor(private readonly db: ${DRIZZLE_PREFIX}Database) {}

${methods.join("\n\n")}
}
`;
}

// Kept out of the template's line starts: the project initializer scans the
// harness it copies for import lines, and a runtime builtin like `bun:test`
// is no package the harness depends on.
const BUN_TEST_IMPORT = 'import { beforeAll, beforeEach, describe, test } from "bun:test";';

export function testDatabaseSource(context: string): string {
  const schema = pgSchemaName(context);
  return `// Generated by ts-drizzle-postgres (ADR 2026-064); no role edits it.
//
// Store tests run against a real Postgres that Testcontainers starts on first
// use, once per test run, with this context's migrations applied. Every test
// starts from empty tables. Nothing here loads a container library until a
// store test runs, so the other test levels never need a container runtime.
//
// Without a container runtime, the harness's red gate sets
// ${STORE_TESTS_SKIP_ENV} to the reason and ${STORE_TESTS_PHASE_ENV}=${RED_PHASE_TOKEN}, and
// every store test is skipped with that reason logged. The skip variable
// alone, without the red token, fails every store block instead: a leftover
// can never turn a green run into a pass. The green gate removes both and
// refuses the run when no runtime answers.
//
// Usage, in adapters/out/drizzle/<area>/<feature>.store.test.ts:
//
//   describeDrizzleStore("${DRIZZLE_PREFIX}CreateThingStore", (db) => {
//     test("...", async () => { const store = new ${DRIZZLE_PREFIX}CreateThingStore(db()); ... });
//   });
${BUN_TEST_IMPORT}
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import type { ${DRIZZLE_PREFIX}Database } from "./${DRIZZLE}-database.ts";

const POSTGRES_IMAGE = "${POSTGRES_IMAGE}";
const SCHEMA = "${schema}";
const MIGRATIONS_SCHEMA = "${MIGRATIONS_SCHEMA}";
const MIGRATIONS_TABLE = "${migrationsTable(context)}";
const START_TIMEOUT_MS = 180_000;
const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url));

interface Running {
  readonly db: ${DRIZZLE_PREFIX}Database;
  readonly pool: Pool;
}

let running: Promise<Running> | undefined;

async function start(): Promise<Running> {
  const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  const pg = await import("pg");
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const pool = new pg.Pool({ connectionString: container.getConnectionUri(), allowExitOnIdle: true });
  const db = drizzle({ client: pool });
  await migrate(db, { migrationsFolder, migrationsSchema: MIGRATIONS_SCHEMA, migrationsTable: MIGRATIONS_TABLE });
  return { db, pool };
}

const quoted = (name: string): string => \`"\${name.replaceAll('"', '""')}"\`;

async function emptyTables(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ tablename: string }>(
    "select tablename from pg_tables where schemaname = $1 order by tablename",
    [SCHEMA],
  );
  if (rows.length === 0) return;
  const tables = rows.map((row) => \`\${quoted(SCHEMA)}.\${quoted(row.tablename)}\`).join(", ");
  await pool.query(\`truncate table \${tables} restart identity cascade\`);
}

/**
 * A block of store tests against this context's migrated Postgres. \`db()\`
 * returns the shared database; call it inside a test, never while the block
 * is being declared.
 */
export function describeDrizzleStore(name: string, body: (db: () => ${DRIZZLE_PREFIX}Database) => void): void {
  const skip = (process.env["${STORE_TESTS_SKIP_ENV}"] ?? "").trim();
  const phase = (process.env["${STORE_TESTS_PHASE_ENV}"] ?? "").trim();
  if (skip !== "" && phase === "${RED_PHASE_TOKEN}") {
    console.warn(\`store tests skipped: \${name}: \${skip}\`);
    describe.skip(name, () => body(() => {
      throw new Error(\`\${name} is skipped: \${skip}\`);
    }));
    return;
  }
  if (skip !== "") {
    // A skip without the red gate's token is a leftover: fail, never skip.
    describe(name, () => {
      test("store tests refuse a skip the red gate did not set", () => {
        throw new Error(
          \`${STORE_TESTS_SKIP_ENV} is set without ${STORE_TESTS_PHASE_ENV}=${RED_PHASE_TOKEN}; only the red gate may skip \` +
            "store tests (ADR 2026-064). Unset it and run the tests with a container runtime.",
        );
      });
    });
    return;
  }
  describe(name, () => {
    let current: Running | undefined;
    beforeAll(async () => {
      running ??= start();
      current = await running;
    }, START_TIMEOUT_MS);
    beforeEach(async () => {
      if (current === undefined) throw new Error("the test database did not start");
      await emptyTables(current.pool);
    });
    body(() => {
      if (current === undefined) throw new Error("the test database did not start");
      return current.db;
    });
  });
}
`;
}

/** The context workspaces that have at least one store, with their stores. */
function contextsWithStores(facts: ProjectFacts, read: StoreFeatureReader): { workspace: WorkspaceFacts; stores: readonly StoreFeature[] }[] {
  return facts.workspaces
    .filter((workspace) => workspace.kind === CONTEXT_KIND)
    .map((workspace) => ({ workspace, stores: read(workspace) }))
    .filter(({ stores }) => stores.length > 0);
}

const byPath = (a: EmittedFile, b: EmittedFile): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** Generated files: config, database type, schema module, test support. */
export function emitDrizzlePersistence(facts: ProjectFacts, read: StoreFeatureReader = readStoreFeatures): EmittedFile[] {
  const out: EmittedFile[] = [];
  for (const { workspace } of contextsWithStores(facts, read)) {
    const dir = drizzleDir(workspace);
    out.push(
      { path: `${workspace.dir}/drizzle.config.ts`, content: drizzleConfigSource(workspace.name), mode: "generated" },
      { path: `${dir}/${DRIZZLE}-database.ts`, content: drizzleDatabaseSource(), mode: "generated" },
      { path: `${dir}/schema/${workspace.name}.schema.ts`, content: schemaModuleSource(workspace.name), mode: "generated" },
      { path: `${dir}/drizzle-test-database.test-support.ts`, content: testDatabaseSource(workspace.name), mode: "generated" },
    );
  }
  return out.sort(byPath);
}

/** Skeletons: one store class per store port, one schema file per area. */
export function emitDrizzleStores(facts: ProjectFacts, read: StoreFeatureReader = readStoreFeatures): EmittedFile[] {
  const out: EmittedFile[] = [];
  for (const { workspace, stores } of contextsWithStores(facts, read)) {
    const dir = drizzleDir(workspace);
    for (const area of [...new Set(stores.map((s) => s.area))]) {
      out.push({ path: `${dir}/schema/${area}.ts`, content: areaSchemaSource(workspace.name, area), mode: "skeleton" });
    }
    for (const store of stores) {
      out.push({
        path: `${dir}/${store.area}/${store.feature}.store.ts`,
        content: storeSkeletonSource(store, workspace.packageName),
        mode: "skeleton",
      });
    }
  }
  return out.sort(byPath);
}
