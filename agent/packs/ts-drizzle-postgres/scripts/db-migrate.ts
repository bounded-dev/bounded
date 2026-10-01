// Shipped into the project as scripts/db-migrate.ts and run by the root
// `db:migrate` script: apply every context's pending committed migrations to
// DATABASE_URL, one context at a time in directory order, stopping at the
// first failure. Bun loads the root .env before this runs, and each Drizzle
// Kit process inherits it, so no context needs its own env file.
//
//   bun scripts/db-migrate.ts [projectRoot]
//
// Self-contained like check-db.ts, whose context discovery it shares.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_FILE, drizzleContexts, kitBin } from "./check-db.ts";

/** Apply migrations; returns the exit code. Output streams through, or with
 *  `"pipe"` is collected and printed through console.error on a failure. */
export function migrateAll(root: string, env: NodeJS.ProcessEnv = process.env, stdio: "inherit" | "pipe" = "inherit"): number {
  if ((env.DATABASE_URL ?? "").trim() === "") {
    console.error("db-migrate: DATABASE_URL is not set. Copy .env.example to .env (and run `bun run db:up`), then try again.");
    return 1;
  }
  const contexts = drizzleContexts(root);
  if (contexts.length === 0) {
    console.log("db-migrate: no context has Drizzle persistence");
    return 0;
  }
  for (const context of contexts) {
    console.log(`db-migrate: ${context.dir}`);
    const run = spawnSync(process.execPath, [kitBin(context, root), "migrate", `--config=${CONFIG_FILE}`], {
      cwd: context.path, env, stdio: ["ignore", stdio, stdio], encoding: "utf8",
    });
    if (run.status !== 0) {
      if (stdio === "pipe") console.error(`${run.stdout ?? ""}${run.stderr ?? ""}`.trim());
      console.error(`db-migrate: ${context.dir} failed (${run.status === null ? `signal ${run.signal}` : `exit ${run.status}`}); later contexts were not migrated`);
      return 1;
    }
  }
  return 0;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    process.exitCode = migrateAll(resolve(process.argv[2] ?? process.cwd()));
  } catch (error) {
    console.error(`db-migrate: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
