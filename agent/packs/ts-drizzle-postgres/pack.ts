// The ts-drizzle-postgres pack (ADR 2026-063): Postgres persistence through
// Drizzle. A stub; WI-6 fills it. It contributes nothing yet.
// Its data half is contrib.json beside this file.
import { definePack } from "../../src/socket-registry.ts";
import { TS_PACK } from "../ts/pack.ts";
import { TS_HEXAGONAL_PACK } from "../ts-hexagonal/pack.ts";

export const TS_DRIZZLE_POSTGRES_PACK = "ts-drizzle-postgres";

export const tsDrizzlePostgresPack = definePack({
  name: TS_DRIZZLE_POSTGRES_PACK,
  dependsOnPacks: [TS_PACK, TS_HEXAGONAL_PACK],
  contributes: [],
});
