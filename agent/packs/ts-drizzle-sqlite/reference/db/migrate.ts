import { migrate } from "drizzle-orm/libsql/migrator";
import { fileURLToPath } from "node:url";
import { db } from "./client.js";

/** The committed migration history, found from this module (src/db/ or
 *  dist/db/), never from the working directory. */
export const migrationsFolder = fileURLToPath(new URL("../../migrations", import.meta.url));

// Call before serving requests or importing a new dataset. Drizzle records
// applied migrations and runs only the pending ones on subsequent calls.
export async function migrateDb(): Promise<void> {
  await migrate(db, { migrationsFolder });
}
