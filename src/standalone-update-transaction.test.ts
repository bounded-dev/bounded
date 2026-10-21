import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { recoverStandaloneUpdate } from "./standalone-update-transaction.ts";

test("a rollback-record edit during target verification retains the update journal", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "bounded-update-rollback-record-"));
  const projectRoot = realpathSync(scratch);
  try {
    mkdirSync(join(projectRoot, ".bounded"));
    mkdirSync(join(projectRoot, ".claude"));
    const settingsPath = join(projectRoot, ".claude", "settings.json");
    const pinPath = join(projectRoot, ".bounded", "version.json");
    const rollbackPath = join(projectRoot, ".bounded", "update-rollback.json");
    const markerPath = join(projectRoot, ".bounded", "update-journal.json");
    writeFileSync(settingsPath, "{\"hooks\":{}}\n");
    writeFileSync(pinPath, '{"schema":"bounded-project-version/1","version":"3.3.0"}\n');
    writeFileSync(rollbackPath, "existing generation\n");
    const state = (path: string) => ({ content: readFileSync(path).toString("base64"), mode: lstatSync(path).mode & 0o777 });
    const journal = { schema: "bounded-update-journal/1", source: { kind: "standalone", version: "3.3.0" },
      targetVersion: "3.3.0", sourceFiles: {}, files: [
        { path: ".claude/settings.json", before: state(settingsPath), after: state(settingsPath) },
        { path: ".bounded/version.json", before: state(pinPath), after: state(pinPath) },
      ], rollbackRecordBefore: state(rollbackPath) };
    writeFileSync(markerPath, `${JSON.stringify(journal)}\n`);
    const changedRollback = "user edited rollback record during verification\n";
    const verified = await recoverStandaloneUpdate(projectRoot, {
      async beforeRestore() { return { ok: true, value: undefined }; },
      async restoredSource() { return { ok: true, value: undefined }; },
      async committedTarget() {
        writeFileSync(rollbackPath, changedRollback);
        return { ok: true, value: undefined };
      },
    });
    expect(verified.ok).toBe(false);
    expect(readFileSync(rollbackPath, "utf8")).toBe(changedRollback);
    expect(readFileSync(markerPath, "utf8")).toBe(`${JSON.stringify(journal)}\n`);
    expect(readFileSync(settingsPath, "utf8")).toBe("{\"hooks\":{}}\n");
    expect(readFileSync(pinPath, "utf8")).toBe('{"schema":"bounded-project-version/1","version":"3.3.0"}\n');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
