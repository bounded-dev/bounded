// Seed only the persistence plumbing. Tables, queries and repositories belong
// to the project and its tickets.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isMainModule } from "../../../src/is-main-module.ts";

const FILES: Readonly<Record<string, string>> = {
  "src/db/schema.ts": [
    "// Define the project's tables here. Commit generated SQL migrations with each schema change.",
    "export {};", "",
  ].join("\n"),
  "src/db/drizzle.config.ts": [
    "import { defineConfig } from \"drizzle-kit\";",
    "",
    "export default defineConfig({",
    "  schema: \"./src/db/schema.ts\",",
    "  out: process.env.BOUNDED_DRIZZLE_OUT ?? \"./src/db/migrations\",",
    "  dialect: \"sqlite\",",
    "  dbCredentials: { url: process.env.DATABASE_URL ?? \"file:./data/app.sqlite\" },",
    "});", "",
  ].join("\n"),
  "src/db/client.ts": [
    "import { createClient } from \"@libsql/client\";",
    "import { drizzle } from \"drizzle-orm/libsql\";",
    "import { mkdirSync } from \"node:fs\";",
    "import { dirname } from \"node:path\";",
    "",
    "const url = process.env.DATABASE_URL ?? \"file:./data/app.sqlite\";",
    "if (url.startsWith(\"file:\")) mkdirSync(dirname(url.slice(5)), { recursive: true });",
    "export const client = createClient({ url });",
    "export const db = drizzle(client);",
    "",
  ].join("\n"),
  "src/db/migrate.ts": [
    "import { migrate } from \"drizzle-orm/libsql/migrator\";",
    "import { db } from \"./client.js\";",
    "",
    "// Call before serving requests or importing a new dataset. Drizzle records",
    "// applied migrations and runs only the pending ones on subsequent calls.",
    "export async function migrateDb(): Promise<void> {",
    "  await migrate(db, { migrationsFolder: \"./src/db/migrations\" });",
    "}",
    "",
  ].join("\n"),
  "src/db/migrations/.gitkeep": "",
  "data/.gitkeep": "",
};

export function seedDatabase(target: string): void {
  for (const [path, content] of Object.entries(FILES)) {
    const file = join(target, path);
    if (existsSync(file)) {
      if (readFileSync(file, "utf8") !== content) throw new Error(`${path} already contains project work`);
      continue;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  const ignorePath = join(target, ".gitignore");
  const before = existsSync(ignorePath) ? readFileSync(ignorePath, "utf8") : "";
  const rules = ["/data/*.sqlite", "/data/*.sqlite-*", "/data/*.db", "/data/*.db-*"];
  const lines = new Set(before.split("\n"));
  const added = rules.filter((rule) => !lines.has(rule));
  if (added.length) writeFileSync(ignorePath, before.trimEnd() + (before ? "\n" : "") + added.join("\n") + "\n");
}

if (isMainModule(import.meta.url)) seedDatabase(resolve(process.argv[2] ?? process.cwd()));
