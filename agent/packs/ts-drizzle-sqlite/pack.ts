import { contribute, definePack } from "../../src/socket-registry.ts";
import { artifactGenerators, deliverChecks, TS_PACK } from "../ts/pack.ts";
import { runDatabaseCheck } from "./scripts/check-migrations.ts";
import { generateMigrations } from "./scripts/generate-migrations.ts";

export const TS_DRIZZLE_SQLITE_PACK = "ts-drizzle-sqlite";
export const tsDrizzleSqlitePack = definePack({
  name: TS_DRIZZLE_SQLITE_PACK,
  dependsOnPacks: [TS_PACK],
  contributes: [contribute(artifactGenerators, [{
    name: "database-migration",
    run: generateMigrations,
  }]), contribute(deliverChecks, [{
    name: "database-migrations",
    description: "Committed SQLite migrations match the project schema and apply to an empty database",
    run: runDatabaseCheck,
    checkScript: () => ({
      name: "check:db",
      command: "node .bounded/harness/packs/ts-drizzle-sqlite/scripts/check-migrations.ts",
    }),
  }])],
});
