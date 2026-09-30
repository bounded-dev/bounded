// The ts-drizzle-postgres contribution to the artifactGenerators socket
// (ADR 2026-058): derive each context's next versioned SQL migration and
// Drizzle Kit's meta/ snapshot from its schema folder. Only the architect's
// generate_artifacts gate calls this; every role is write-denied the
// migrations folder.
//
// All or nothing across contexts. Every context generates into a throwaway
// copy first; only when all of them succeed are the new files copied into the
// project. A generation may add files and rewrite the journal, never change
// or remove a committed migration or snapshot, so an ambiguous rename or a
// broken schema in one context leaves every context's history untouched.
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  contextCopy, drizzleContexts, historyHashes, KIT_TIMEOUT_MS, kitBin, MIGRATIONS_DIR, runKit, withoutEmptyJournal,
} from "./check-db.ts";

const JOURNAL = "meta/_journal.json";

// Drizzle Kit decorates its output with colour codes and emoji; keep the words.
// eslint-disable-next-line no-control-regex
const plain = (output: string): string[] => output.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").split("\n")
  .map((line) => line.replace(/[^\x20-\x7e]/g, "").trim())
  .filter((line) => line !== "" && !line.startsWith("Reading config file"));

export function generateMigrations(root: string, timeoutMs = KIT_TIMEOUT_MS): readonly string[] {
  const contexts = drizzleContexts(root);
  if (contexts.length === 0) return ["no context has Drizzle persistence; nothing to generate"];
  const temp = mkdtempSync(join(tmpdir(), "bounded-db-generate-"));
  try {
    const planned: { context: string; files: { from: string; to: string }[]; output: string[] }[] = [];
    contexts.forEach((context, i) => {
      const bin = kitBin(context, root);
      const copy = contextCopy(context, root, join(temp, String(i)));
      const output = plain(runKit(bin, copy, "generate", process.env, context.dir, timeoutMs));
      const live = join(context.path, MIGRATIONS_DIR);
      const before = historyHashes(live);
      const after = historyHashes(join(copy, MIGRATIONS_DIR));
      const files: { from: string; to: string }[] = [];
      for (const [name, hash] of withoutEmptyJournal(join(copy, MIGRATIONS_DIR), after)) {
        const previous = before.get(name);
        if (previous === hash) continue;
        if (previous !== undefined && name !== JOURNAL) {
          throw new Error(`drizzle-kit generate in ${context.dir} would rewrite the committed ${MIGRATIONS_DIR}/${name}; ` +
            "a committed migration is never changed. Restore it from version control and generate again.");
        }
        files.push({ from: join(copy, MIGRATIONS_DIR, name), to: join(live, name) });
      }
      for (const name of before.keys()) {
        if (!after.has(name)) throw new Error(`drizzle-kit generate in ${context.dir} dropped the committed ${MIGRATIONS_DIR}/${name}`);
      }
      planned.push({ context: context.dir, files, output });
    });
    const lines: string[] = [];
    for (const { context, files, output } of planned) {
      for (const { from, to } of files) {
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(from, to);
      }
      lines.push(files.length === 0
        ? `${context}: no schema change, nothing generated`
        : `${context}: migrations generated from the schema (${files.length} file(s) written)`);
      lines.push(...output.map((line) => `${context}:   ${line}`));
    }
    return lines;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
