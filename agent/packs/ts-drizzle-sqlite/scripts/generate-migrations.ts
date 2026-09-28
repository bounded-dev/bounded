import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Generate the SQL and snapshot metadata from the project-owned schema. */
export function generateMigrations(cwd: string): readonly string[] {
  const bin = join(cwd, "node_modules/drizzle-kit/bin.cjs");
  if (!existsSync(bin)) throw new Error("project dependencies are missing; run npm ci");
  const output = execFileSync(process.execPath, [bin, "generate", "--config=src/db/drizzle.config.ts"], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000,
  });
  return ["database migration generation completed", ...output.trim().split("\n").filter(Boolean)];
}
