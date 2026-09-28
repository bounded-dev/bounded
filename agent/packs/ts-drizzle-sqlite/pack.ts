// The ts-drizzle-sqlite pack (ADR 2026-055): SQLite persistence with versioned
// migrations. Its data half (pins, generated config, the shipped migration
// check, ignore rules, the project seed) is contrib.json. Its one code
// contribution is the migration generator the generate_artifacts gate runs.
// The migration check reaches delivery through the project's own `check`
// (projectCheckScripts), so it is not also a delivery check.
import { contribute, definePack } from "../../src/socket-registry.ts";
import { artifactGenerators, TS_PACK } from "../ts/pack.ts";
import { generateMigrations } from "./scripts/generate-migrations.ts";

export const TS_DRIZZLE_SQLITE_PACK = "ts-drizzle-sqlite";
export const tsDrizzleSqlitePack = definePack({
  name: TS_DRIZZLE_SQLITE_PACK,
  dependsOnPacks: [TS_PACK],
  contributes: [contribute(artifactGenerators, [{
    name: "database-migration",
    run: (cwd) => generateMigrations(cwd),
  }])],
});
