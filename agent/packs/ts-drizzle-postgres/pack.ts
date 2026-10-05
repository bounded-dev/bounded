// The ts-drizzle-postgres pack (ADR 2026-063): Postgres persistence through
// Drizzle, one Postgres schema per context. Its data half (the `drizzle`
// adapter technology and its pins, generated-file globs, root config, shipped
// scripts) is contrib.json beside this file. Its code half:
//
//   skeletonEmitters     drizzle-persistence (generated per-context files) and
//                        drizzle-stores (store and area-schema skeletons)
//   artifactGenerators   database-migration: each context's next migration
//
//   phaseTestPolicies    store-tests-need-a-container-runtime: ADR 2026-064's
//                        rule (scripts/container-runtime.ts), which the red
//                        and green gates apply to the test process
//   testObligations      drizzle-app-database: each persisting app's smoke
//                        test starts its own database (ADR 2026-072)
import { contribute, definePack } from "../../src/socket-registry.ts";
import { artifactGenerators, phaseTestPolicies, skeletonEmitters, testObligations, TS_PACK } from "../ts/pack.ts";
import { appDatabaseObligation } from "./scripts/app-database-obligation.ts";
import { TS_HEXAGONAL_PACK } from "../ts-hexagonal/pack.ts";
import { storeTestPolicy } from "./scripts/container-runtime.ts";
import { emitDrizzlePersistence, emitDrizzleStores } from "./scripts/emit.ts";
import { generateMigrations } from "./scripts/generate-migrations.ts";

export const TS_DRIZZLE_POSTGRES_PACK = "ts-drizzle-postgres";

export const tsDrizzlePostgresPack = definePack({
  name: TS_DRIZZLE_POSTGRES_PACK,
  dependsOnPacks: [TS_PACK, TS_HEXAGONAL_PACK],
  contributes: [
    contribute(skeletonEmitters, [
      {
        name: "drizzle-persistence",
        description: "Per context with a store: drizzle.config.ts, the DrizzleDatabase type, the pgSchema module and the Testcontainers store-test support; beside each app's composition root, its smoke tests' own database support.",
        emit: (facts) => emitDrizzlePersistence(facts),
      },
      {
        name: "drizzle-stores",
        description: "Per store out port a Drizzle<Port> skeleton taking (db: DrizzleDatabase), and per area with a store a schema/<area>.ts skeleton.",
        emit: (facts) => emitDrizzleStores(facts),
      },
    ]),
    contribute(phaseTestPolicies, [storeTestPolicy]),
    contribute(testObligations, [appDatabaseObligation]),
    contribute(artifactGenerators, [{
      name: "database-migration",
      run: (cwd) => generateMigrations(cwd),
    }]),
  ],
});
