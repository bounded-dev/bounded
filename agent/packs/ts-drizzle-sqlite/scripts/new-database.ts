// Seed only the persistence plumbing. Tables, queries and repositories belong
// to the project and its tickets. The Drizzle config, the migration check and
// the database ignore rules are not seeded here: they are generated project
// config and pack data (contrib.json), drift-checked like every other config
// file (ADR 2026-054, ADR 2026-055).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "../../../src/is-main-module.ts";

/** The pack's reference sources: the project's own harness copy when
 *  initialization installed one (a built harness runs this script compiled,
 *  away from the pack's files), else this source tree's. */
function referenceDir(target: string): string {
  const installed = join(target, ".bounded", "harness", "packs", "ts-drizzle-sqlite", "reference");
  return existsSync(installed) ? installed : join(dirname(fileURLToPath(import.meta.url)), "..", "reference");
}

/** Project path → the seeded content. The db/ sources are the pack's
 *  reference copies; the two empty markers keep their directories in Git. */
export function seedFiles(target: string): ReadonlyMap<string, string> {
  const reference = referenceDir(target);
  const read = (name: string): string => readFileSync(join(reference, "db", name), "utf8");
  return new Map([
    ["src/db/schema.ts", read("schema.ts")],
    ["src/db/client.ts", read("client.ts")],
    ["src/db/migrate.ts", read("migrate.ts")],
    // The migration history lives outside src/: no role's write zone
    // reaches it, so only the generate_artifacts gate writes it (ADR 2026-055).
    ["migrations/.gitkeep", ""],
    ["data/.gitkeep", ""],
  ]);
}

export function seedDatabase(target: string): void {
  const files = seedFiles(target);
  for (const [path, content] of files) {
    const file = join(target, path);
    if (existsSync(file) && readFileSync(file, "utf8") !== content) throw new Error(`${path} already contains project work`);
  }
  for (const [path, content] of files) {
    const file = join(target, path);
    if (existsSync(file)) continue;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

if (isMainModule(import.meta.url)) seedDatabase(resolve(process.argv[2] ?? process.cwd()));
