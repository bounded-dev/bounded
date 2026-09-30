// Read-only project check, shipped into the project as scripts/check-db.ts
// and run by its `check:db` script (ADR 2026-058, ADR 2026-063). For every
// context with Drizzle persistence, Drizzle Kit generates into a throwaway
// copy of the context, which must produce no new migration, and then checks
// the committed history for consistency. Applying the history to a real
// Postgres is the store tests' job: their generated test support migrates a
// fresh container before the first store test (ADR 2026-064).
//
//   bun scripts/check-db.ts [projectRoot]
//
// Self-contained on purpose: the delivered project runs this copy without the
// harness, so it imports only Node built-ins. The harness's migration
// generator and the shipped `db:migrate` script import from here, so all
// three find contexts and call Drizzle Kit the same way.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the workspaces with persistence live (TN-26-012). */
export const CONTEXTS_DIR = "contexts";
/** The generated Drizzle config, at each context's root. */
export const CONFIG_FILE = "drizzle.config.ts";
/** The Drizzle adapter folder, relative to a context. */
export const DRIZZLE_DIR = "src/adapters/out/drizzle";
/** The folder Drizzle Kit reads the schema from. */
export const SCHEMA_DIR = `${DRIZZLE_DIR}/schema`;
/** The committed migration history: generated, never hand-edited (ADR 2026-058). */
export const MIGRATIONS_DIR = `${DRIZZLE_DIR}/migrations`;
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
  constructor(context: string) {
    super(
      `the schema change in ${context} is ambiguous: Drizzle Kit must ask whether a changed column or table is a ` +
        "rename or a drop-and-create, and there is no terminal to ask in. Nothing was generated. Make the change " +
        "unambiguous (add the new column or table in one generation and remove the old one in a later one), " +
        `or escalate to the user, who runs \`bun run db:generate\` in ${context} in a terminal, answers the ` +
        "prompt, and commits the reviewed migration.",
    );
    this.name = "AmbiguousSchemaChange";
  }
}

/** One context with Drizzle persistence. */
export interface DrizzleContext {
  /** Project-relative, e.g. `contexts/project-management`. */
  readonly dir: string;
  /** Absolute. */
  readonly path: string;
}

const isDir = (path: string): boolean => existsSync(path) && statSync(path).isDirectory();

/**
 * Every context that has Drizzle persistence, sorted by directory: those with
 * a Drizzle config or a Drizzle adapter folder. Throws when one has only half
 * of the pair, because generating or checking half a context would pass
 * silently over the other half.
 */
export function drizzleContexts(root: string): DrizzleContext[] {
  const base = join(root, CONTEXTS_DIR);
  if (!isDir(base)) return [];
  const out: DrizzleContext[] = [];
  for (const name of readdirSync(base).sort()) {
    const path = join(base, name);
    if (!isDir(path)) continue;
    const dir = `${CONTEXTS_DIR}/${name}`;
    const config = existsSync(join(path, CONFIG_FILE));
    const adapter = isDir(join(path, DRIZZLE_DIR));
    if (!config && !adapter) continue;
    if (!config) throw new Error(`${dir} has ${DRIZZLE_DIR}/ but no ${CONFIG_FILE}`);
    if (!isDir(join(path, SCHEMA_DIR))) throw new Error(`${dir} has ${CONFIG_FILE} but no ${SCHEMA_DIR}/`);
    out.push({ dir, path });
  }
  return out;
}

/**
 * The name every generated migration of a context carries, so file names are
 * deterministic: `0000_project_management.sql`, `0001_project_management.sql`.
 * Drizzle Kit would otherwise pick a random one (`0000_mute_wong.sql`).
 */
export function migrationName(context: DrizzleContext): string {
  return context.dir.slice(context.dir.lastIndexOf("/") + 1).replace(/[^a-z0-9]+/gi, "_").toLowerCase();
}

/** `generate`'s extra arguments for a context. */
export const generateArgs = (context: DrizzleContext): string[] => [`--name=${migrationName(context)}`];

/** The Drizzle Kit entry the context resolves: its own dependency folder
 *  first (Bun's isolated installs), then the project root's. */
export function kitBin(context: DrizzleContext, root: string): string {
  for (const base of [context.path, root]) {
    const bin = join(base, "node_modules", "drizzle-kit", "bin.cjs");
    if (existsSync(bin)) return bin;
  }
  throw new Error(`project dependencies are missing: drizzle-kit is not installed for ${context.dir}`);
}

/**
 * Run one Drizzle Kit command in `cwd` with the runtime running this script,
 * without a shell and with stdin closed. Returns stdout. Throws on a non-zero
 * exit, a timeout, anything on stderr (Drizzle Kit reports some failures
 * there with exit 0), and `AmbiguousSchemaChange` when it needed an
 * interactive answer.
 */
export function runKit(
  bin: string, cwd: string, command: string, env: NodeJS.ProcessEnv, context: string, timeoutMs = KIT_TIMEOUT_MS,
  extra: readonly string[] = [],
): string {
  const run = spawnSync(process.execPath, [bin, command, `--config=${CONFIG_FILE}`, ...extra], {
    cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs,
  });
  const stdout = run.stdout ?? "";
  const stderr = (run.stderr ?? "").trim();
  if (PROMPT_WITHOUT_TTY.test(stderr) || PROMPT_WITHOUT_TTY.test(stdout)) throw new AmbiguousSchemaChange(context);
  if (run.error !== undefined) {
    throw new Error(`drizzle-kit ${command} in ${context} did not finish within ${timeoutMs / 1000}s (${run.error.message})`);
  }
  if (run.status !== 0 || stderr !== "") {
    const how = run.status === null ? `signal ${run.signal}` : `exit ${run.status}`;
    throw new Error(`drizzle-kit ${command} in ${context} failed (${how}): ${stderr || stdout.trim()}`);
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
  return new Map([...result].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function sameHistory(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  return a.size === b.size && [...a].every(([name, hash]) => b.get(name) === hash);
}

const JOURNAL = "meta/_journal.json";

/** Drizzle Kit writes a journal with no entries when a schema has no tables
 *  yet. That is the same history as none at all. */
export function withoutEmptyJournal(root: string, hashes: Map<string, string>): Map<string, string> {
  if (!hashes.has(JOURNAL) || hashes.size !== 1) return hashes;
  try {
    const journal = JSON.parse(readFileSync(join(root, JOURNAL), "utf8")) as { entries?: unknown };
    if (Array.isArray(journal.entries) && journal.entries.length === 0) return new Map();
  } catch {
    // An unreadable journal is history like any other file.
  }
  return hashes;
}

/** A throwaway copy of a context that Drizzle Kit can run in: its config,
 *  manifest and source tree, with its dependency folder linked, never
 *  copied. The caller removes `temp`. */
export function contextCopy(context: DrizzleContext, root: string, temp: string): string {
  const copy = join(temp, "context");
  cpSync(join(context.path, CONFIG_FILE), join(copy, CONFIG_FILE));
  if (existsSync(join(context.path, "package.json"))) cpSync(join(context.path, "package.json"), join(copy, "package.json"));
  cpSync(join(context.path, "src"), join(copy, "src"), {
    recursive: true,
    filter: (source) => !source.split(/[\\/]/).includes("node_modules"),
  });
  const modules = [join(context.path, "node_modules"), join(root, "node_modules")].find(isDir);
  if (modules !== undefined) symlinkSync(realpathSync(modules), join(copy, "node_modules"), "dir");
  return copy;
}

function checkContext(context: DrizzleContext, root: string, timeoutMs: number): DatabaseCheckResult | undefined {
  const bin = kitBin(context, root);
  const history = join(context.path, MIGRATIONS_DIR);
  const committed = historyHashes(history);
  const temp = mkdtempSync(join(tmpdir(), "bounded-db-check-"));
  try {
    const copy = contextCopy(context, root, temp);
    runKit(bin, copy, "generate", process.env, context.dir, timeoutMs, generateArgs(context));
    // Read-only: prove nothing wrote the project's own history.
    if (!sameHistory(committed, historyHashes(history))) {
      return { verdict: "block", summary: `the check changed ${context.dir}/${MIGRATIONS_DIR}/` };
    }
    const regenerated = join(copy, MIGRATIONS_DIR);
    if (!sameHistory(withoutEmptyJournal(history, committed), withoutEmptyJournal(regenerated, historyHashes(regenerated)))) {
      return {
        verdict: "block",
        summary: `database schema and committed migrations differ in ${context.dir}`,
        detail: [`Regenerate ${context.dir}/${MIGRATIONS_DIR}/ from the schema (the architect's generate_artifacts gate, ` +
          `or \`bun run db:generate\` in ${context.dir} outside the harness), review the SQL, and commit it with its meta/ folder.`],
      };
    }
    if (withoutEmptyJournal(history, committed).size > 0) runKit(bin, copy, "check", process.env, context.dir, timeoutMs);
    return undefined;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export function runDatabaseCheck(root: string, timeoutMs = KIT_TIMEOUT_MS): DatabaseCheckResult {
  let contexts: DrizzleContext[];
  try {
    contexts = drizzleContexts(root);
  } catch (error) {
    return { verdict: "block", summary: "database layout is incomplete", detail: [error instanceof Error ? error.message : String(error)] };
  }
  if (contexts.length === 0) return { verdict: "pass", summary: "no context has Drizzle persistence" };
  try {
    for (const context of contexts) {
      const problem = checkContext(context, root, timeoutMs);
      if (problem !== undefined) return problem;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const summary = error instanceof AmbiguousSchemaChange
      ? "database schema and committed migrations differ, ambiguously"
      : "database migration check failed";
    return { verdict: "block", summary, detail: [message.trim().slice(0, 4000)] };
  }
  return {
    verdict: "pass",
    summary: `database migrations match the schema in ${contexts.map((c) => c.dir).join(", ")}`,
  };
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
