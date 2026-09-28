// Read-only project check: Drizzle generates into an isolated copy of the
// committed migration history, then applies that history to a fresh database.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { DeliverCheckResult } from "../../ts/pack.ts";
import { isMainModule } from "../../../src/is-main-module.ts";

function contents(root: string, base = ""): Map<string, string> {
  const result = new Map<string, string>();
  if (!existsSync(root)) return result;
  for (const entry of readdirSync(join(root, base), { withFileTypes: true })) {
    const path = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      for (const [name, hash] of contents(root, path)) result.set(name, hash);
    } else if (entry.isFile() && path !== ".gitkeep") {
      result.set(path, createHash("sha256").update(readFileSync(join(root, path))).digest("hex"));
    }
  }
  return result;
}

function runKit(cwd: string, command: string, env: NodeJS.ProcessEnv): void {
  const bin = join(cwd, "node_modules/drizzle-kit/bin.cjs");
  if (!existsSync(bin)) throw new Error("project dependencies are missing; run npm ci");
  execFileSync(process.execPath, [bin, command, "--config=src/db/drizzle.config.ts"], {
    cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000,
  });
}

export function runDatabaseCheck(cwd: string): DeliverCheckResult {
  const migrationDir = join(cwd, "src/db/migrations");
  const schema = join(cwd, "src/db/schema.ts");
  if (!existsSync(schema)) return { verdict: "block", summary: "database schema is missing at src/db/schema.ts" };
  const temp = mkdtempSync(join(tmpdir(), "bounded-db-check-"));
  try {
    const copy = join(temp, "migrations");
    if (existsSync(migrationDir)) cpSync(migrationDir, copy, { recursive: true });
    const before = contents(copy);
    runKit(cwd, "generate", { ...process.env, BOUNDED_DRIZZLE_OUT: copy });
    const after = contents(copy);
    const changed = [...after].some(([name, hash]) => before.get(name) !== hash) ||
      [...before].some(([name]) => !after.has(name));
    if (changed) return {
      verdict: "block",
      summary: "database schema and committed migrations differ",
      detail: ["Run npm run db:generate, review the SQL, and commit the SQL and migration metadata."],
    };
    if (before.size > 0) {
      runKit(cwd, "check", process.env);
      runKit(cwd, "migrate", { ...process.env, DATABASE_URL: `file:${join(temp, "fresh.sqlite")}` });
    }
    return { verdict: "pass", summary: "database migrations match the schema and apply to a fresh SQLite database" };
  } catch (error) {
    const detail = error instanceof Error && "stderr" in error
      ? String((error as Error & { stderr?: Buffer | string }).stderr ?? error.message)
      : error instanceof Error ? error.message : String(error);
    return { verdict: "block", summary: "database migration check failed", detail: [detail.trim().slice(0, 4000)] };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (isMainModule(import.meta.url)) {
  const result = runDatabaseCheck(resolve(process.argv[2] ?? process.cwd()));
  console.log(result.summary);
  for (const line of result.detail ?? []) console.error(line);
  process.exitCode = result.verdict === "pass" ? 0 : 1;
}
