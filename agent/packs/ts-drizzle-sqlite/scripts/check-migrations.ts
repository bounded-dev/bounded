// Read-only project check, shipped into the project as scripts/check-db.ts and
// run by its `check:db` script (ADR 2026-055): Drizzle generates into an
// isolated copy of the committed migration history, which must come out
// unchanged, then the committed history is applied to a fresh database.
//
//   node --experimental-strip-types scripts/check-db.ts [projectRoot]
//
// Self-contained on purpose: the delivered project runs this copy without the
// harness, so it imports only Node built-ins. The harness's migration
// generator imports `runKit` from here, so the two share one way of calling
// Drizzle Kit.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The generated Drizzle config, at the project root. */
export const CONFIG_FILE = "drizzle.config.ts";
/** The committed migration history: outside src/, so no role writes it. */
export const MIGRATIONS_DIR = "migrations";
export const SCHEMA_FILE = "src/db/schema.ts";
/** The config reads this to generate somewhere other than MIGRATIONS_DIR. */
export const OUT_ENV = "BOUNDED_DRIZZLE_OUT";
export const KIT_TIMEOUT_MS = 60_000;

export interface DatabaseCheckResult {
  readonly verdict: "pass" | "block";
  readonly summary: string;
  readonly detail?: readonly string[];
}

// Drizzle Kit asks a person whether a changed column or table is a rename or
// a drop-and-create. Without a terminal it prints this and exits 0 having
// written nothing, which would otherwise read as "no schema change".
const PROMPT_WITHOUT_TTY = /Interactive prompts require a TTY/i;

/** A schema change Drizzle Kit cannot resolve without a person choosing. */
export class AmbiguousSchemaChange extends Error {
  constructor() {
    super(
      "the schema change is ambiguous: Drizzle Kit must ask whether a changed column or table is a rename " +
        "or a drop-and-create, and there is no terminal to ask in. Nothing was generated. Make the change " +
        "unambiguous (add the new column or table in one generation and remove the old one in a later one), " +
        "or escalate to the user, who runs `npm run db:generate` in a terminal, answers the prompt, and " +
        "commits the reviewed migration.",
    );
    this.name = "AmbiguousSchemaChange";
  }
}

/** `env` without the output override, so Drizzle Kit uses the committed history. */
export function committedEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  delete out[OUT_ENV];
  return out;
}

/**
 * Run one Drizzle Kit command from the project's installed copy, without a
 * shell and with stdin closed. Returns stdout. Throws on a non-zero exit, a
 * timeout, anything on stderr (Drizzle Kit reports some failures there with
 * exit 0), and `AmbiguousSchemaChange` when it needed an interactive answer.
 */
export function runKit(cwd: string, command: string, env: NodeJS.ProcessEnv, timeoutMs = KIT_TIMEOUT_MS): string {
  const bin = join(cwd, "node_modules", "drizzle-kit", "bin.cjs");
  if (!existsSync(bin)) throw new Error("project dependencies are missing: drizzle-kit is not installed");
  const run = spawnSync(process.execPath, [bin, command, `--config=${CONFIG_FILE}`], {
    cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs,
  });
  const stdout = run.stdout ?? "";
  const stderr = (run.stderr ?? "").trim();
  if (PROMPT_WITHOUT_TTY.test(stderr) || PROMPT_WITHOUT_TTY.test(stdout)) throw new AmbiguousSchemaChange();
  if (run.error !== undefined) {
    throw new Error(`drizzle-kit ${command} did not finish within ${timeoutMs / 1000}s (${run.error.message})`);
  }
  if (run.status !== 0 || stderr !== "") {
    throw new Error(`drizzle-kit ${command} failed (${run.status === null ? `signal ${run.signal}` : `exit ${run.status}`}): ${stderr || stdout.trim()}`);
  }
  return stdout;
}

/** Relative path → content hash of every file under `root`, except `.gitkeep`. */
export function historyHashes(root: string, base = ""): Map<string, string> {
  const result = new Map<string, string>();
  if (!existsSync(join(root, base))) return result;
  for (const entry of readdirSync(join(root, base), { withFileTypes: true })) {
    const path = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      for (const [name, hash] of historyHashes(root, path)) result.set(name, hash);
    } else if (entry.isFile() && entry.name !== ".gitkeep") {
      result.set(path, createHash("sha256").update(readFileSync(join(root, path))).digest("hex"));
    }
  }
  return result;
}

function sameHistory(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  return a.size === b.size && [...a].every(([name, hash]) => b.get(name) === hash);
}

const JOURNAL = "meta/_journal.json";

/** Drizzle Kit writes a journal with no entries when a schema has no tables
 *  yet. That is the same history as none at all, so a new project's check is
 *  not red over a file no migration needs. */
function withoutEmptyJournal(root: string, hashes: Map<string, string>): Map<string, string> {
  if (!hashes.has(JOURNAL)) return hashes;
  try {
    const journal = JSON.parse(readFileSync(join(root, JOURNAL), "utf8")) as { entries?: unknown };
    if (Array.isArray(journal.entries) && journal.entries.length === 0 && hashes.size === 1) return new Map();
  } catch {
    // An unreadable journal is history like any other file.
  }
  return hashes;
}

export function runDatabaseCheck(cwd: string, timeoutMs = KIT_TIMEOUT_MS): DatabaseCheckResult {
  const history = join(cwd, MIGRATIONS_DIR);
  if (!existsSync(join(cwd, SCHEMA_FILE))) return { verdict: "block", summary: `database schema is missing at ${SCHEMA_FILE}` };
  if (!existsSync(join(cwd, CONFIG_FILE))) return { verdict: "block", summary: `database config is missing at ${CONFIG_FILE}` };
  const committed = historyHashes(history);
  const temp = mkdtempSync(join(tmpdir(), "bounded-db-check-"));
  try {
    const copy = join(temp, "migrations");
    if (existsSync(history)) cpSync(history, copy, { recursive: true });
    // Relative to the project: Drizzle Kit prefixes the output folder with
    // `./` when it reads snapshots back, which breaks an absolute path.
    runKit(cwd, "generate", { ...process.env, [OUT_ENV]: relative(cwd, copy) }, timeoutMs);
    // The check is read-only: a config that ignored the override would have
    // written the project's history, so prove it did not.
    if (!sameHistory(committed, historyHashes(history))) {
      return { verdict: "block", summary: `the check changed ${MIGRATIONS_DIR}/; the database config did not honour ${OUT_ENV}` };
    }
    if (!sameHistory(withoutEmptyJournal(history, committed), withoutEmptyJournal(copy, historyHashes(copy)))) {
      return {
        verdict: "block",
        summary: "database schema and committed migrations differ",
        detail: [`Regenerate ${MIGRATIONS_DIR}/ from the schema (the architect's generate_artifacts gate, or \`npm run db:generate\` outside the harness), review the SQL, and commit it with its metadata.`],
      };
    }
    if (withoutEmptyJournal(history, committed).size > 0) {
      runKit(cwd, "check", committedEnv(), timeoutMs);
      runKit(cwd, "migrate", { ...committedEnv(), DATABASE_URL: pathToFileURL(join(temp, "fresh.sqlite")).href }, timeoutMs);
    }
    return { verdict: "pass", summary: "database migrations match the schema and apply to a fresh SQLite database" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const summary = error instanceof AmbiguousSchemaChange
      ? "database schema and committed migrations differ, ambiguously"
      : "database migration check failed";
    return { verdict: "block", summary, detail: [message.trim().slice(0, 4000)] };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
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
  const result = runDatabaseCheck(resolve(process.argv[2] ?? process.cwd()));
  console.log(`check-db: ${result.verdict === "pass" ? "OK" : "BLOCK"} — ${result.summary}`);
  for (const line of result.detail ?? []) console.error(`  ${line}`);
  process.exitCode = result.verdict === "pass" ? 0 : 1;
}
