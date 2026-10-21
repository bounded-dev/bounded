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

test("an oversized managed update journal is refused before any recovery callback", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "bounded-update-journal-bound-"));
  const projectRoot = realpathSync(scratch);
  try {
    mkdirSync(join(projectRoot, ".bounded"));
    const absent = { content: null, mode: null };
    const journal = { schema: "bounded-update-journal/1", source: { kind: "standalone", version: "3.3.0" },
      targetVersion: "3.3.0", sourceFiles: {}, managed: { oldOwnedDirectories: [], newOwnedDirectories: [] },
      files: [...Array.from({ length: 20_011 }, (_unused, index) => ({ path: `node_modules/test/file-${index}.d.ts`, before: absent, after: absent })),
        { path: ".bounded/version.json", before: absent, after: absent }] };
    const markerPath = join(projectRoot, ".bounded", "update-journal.json");
    writeFileSync(markerPath, `${JSON.stringify(journal)}\n`);
    let callbackCount = 0;
    const verified = await recoverStandaloneUpdate(projectRoot, {
      async beforeRestore() { callbackCount += 1; return { ok: true, value: undefined }; },
      async restoredSource() { callbackCount += 1; return { ok: true, value: undefined }; },
      async committedTarget() { callbackCount += 1; return { ok: true, value: undefined }; },
    });
    expect(verified.ok).toBe(false);
    expect(verified.ok ? "" : verified.error).toContain("update journal exceeds file-count bound");
    expect(callbackCount).toBe(0);
    expect(readFileSync(markerPath, "utf8")).toBe(`${JSON.stringify(journal)}\n`);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("a byte bound rejects a journal before parsing or invoking recovery callbacks", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "bounded-update-byte-limit-"));
  const projectRoot = realpathSync(scratch);
  try {
    mkdirSync(join(projectRoot, ".bounded"));
    const markerPath = join(projectRoot, ".bounded", "update-journal.json");
    writeFileSync(markerPath, "invalid");
    let callbackCount = 0;
    const verifiers = {
      async beforeRestore() { callbackCount += 1; return { ok: true as const, value: undefined }; },
      async restoredSource() { callbackCount += 1; return { ok: true as const, value: undefined }; },
      async committedTarget() { callbackCount += 1; return { ok: true as const, value: undefined }; },
    };
    const verified: Awaited<ReturnType<typeof recoverStandaloneUpdate>> = await Reflect.apply(
      recoverStandaloneUpdate, undefined, [projectRoot, verifiers, { maxJournalBytes: 5 }]);
    expect(verified.ok).toBe(false);
    expect(verified.ok ? "" : verified.error).toContain("update journal exceeds byte bound");
    expect(callbackCount).toBe(0);
    expect(readFileSync(markerPath, "utf8")).toBe("invalid");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test.each([
  { name: "npm source", source: { kind: "npm", version: "3.3.0" } },
  { name: "npm rollback target", source: { kind: "standalone", version: "3.3.0" }, targetKind: "npm" },
])("a $name journal without a verified npm closure is refused before recovery", async ({ source, targetKind }) => {
  const scratch = mkdtempSync(join(tmpdir(), "bounded-update-npm-closure-"));
  const projectRoot = realpathSync(scratch);
  try {
    mkdirSync(join(projectRoot, ".bounded"));
    const markerPath = join(projectRoot, ".bounded", "update-journal.json");
    const absent = { content: null, mode: null };
    const journal = { schema: "bounded-update-journal/1", source, targetVersion: "3.3.0", sourceFiles: {},
      ...(targetKind === undefined ? {} : { targetKind }),
      files: [{ path: ".bounded/version.json", before: absent, after: absent }] };
    writeFileSync(markerPath, `${JSON.stringify(journal)}\n`);
    let callbacks = 0;
    const result = await recoverStandaloneUpdate(projectRoot, {
      async beforeRestore() { callbacks += 1; return { ok: true, value: undefined }; },
      async restoredSource() { callbacks += 1; return { ok: true, value: undefined }; },
      async committedTarget() { callbacks += 1; return { ok: true, value: undefined }; },
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain("npm closure");
    expect(callbacks).toBe(0);
    expect(readFileSync(markerPath, "utf8")).toBe(`${JSON.stringify(journal)}\n`);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
