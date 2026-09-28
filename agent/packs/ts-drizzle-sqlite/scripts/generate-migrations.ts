// The ts-drizzle-sqlite contribution to the artifactGenerators socket
// (ADR 2026-055): derive the next versioned SQL migration and its snapshot
// metadata from the project's schema, into migrations/. Only the
// generate_artifacts gate calls this; no role may write migrations/.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { committedEnv, KIT_TIMEOUT_MS, runKit, SCHEMA_FILE } from "./check-migrations.ts";

export function generateMigrations(cwd: string, timeoutMs = KIT_TIMEOUT_MS): readonly string[] {
  if (!existsSync(join(cwd, SCHEMA_FILE))) throw new Error(`database schema is missing at ${SCHEMA_FILE}`);
  const output = runKit(cwd, "generate", committedEnv(), timeoutMs);
  // Drizzle Kit decorates its output with colour codes and emoji; keep the words.
  // eslint-disable-next-line no-control-regex
  const lines = output.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").split("\n").map((line) => line.trim()).filter(Boolean);
  return ["migrations generated from the schema", ...lines];
}
