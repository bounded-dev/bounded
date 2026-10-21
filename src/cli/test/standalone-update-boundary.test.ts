import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { dispatchStandalone } from "../../standalone-dispatch.ts";
import { runStandaloneAddInternal } from "../../standalone-runtime.ts";

const VERSION = "3.3.0";

test("a pending project update blocks hook dispatch before any version handoff", async () => {
  const root = mkdtempSync(join(tmpdir(), "bounded-update-boundary-"));
  const originalExitCode = process.exitCode;
  const originalWrite = process.stderr.write;
  let diagnostic = "";
  try {
    mkdirSync(join(root, ".bounded"));
    writeFileSync(join(root, ".bounded", "version.json"), `${JSON.stringify({ schema: "bounded-project-version/1", version: VERSION })}\n`);
    writeFileSync(join(root, ".bounded", "update-journal.json"), "{\"schema\":\"bounded-update-journal/1\"}\n");
    process.stderr.write = ((chunk: string | Uint8Array) => { diagnostic += String(chunk); return true; }) as typeof process.stderr.write;
    const dispatched = await dispatchStandalone(["hook", "claude-code", "--project", root], VERSION);
    expect(dispatched.answered).toBe(true);
    expect(process.exitCode).toBe(2);
    expect(diagnostic).toMatch(/update|journal|recover/i);
  } finally {
    process.exitCode = originalExitCode;
    process.stderr.write = originalWrite;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a pending project update blocks a managed add before it can reach the store", async () => {
  const root = mkdtempSync(join(tmpdir(), "bounded-update-add-boundary-"));
  const originalCwd = process.cwd();
  const originalExitCode = process.exitCode;
  try {
    mkdirSync(join(root, ".bounded"));
    writeFileSync(join(root, ".bounded", "update-journal.json"), "{\"schema\":\"bounded-update-journal/1\"}\n");
    process.chdir(root);
    const dispatched = await dispatchStandalone(["add", "example@1.0.0"], VERSION);
    expect(dispatched.answered).toBe(true);
    expect(process.exitCode).toBe(2);
  } finally {
    process.chdir(originalCwd);
    process.exitCode = originalExitCode;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a pending project update blocks check but permits update to enter recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "bounded-update-check-boundary-"));
  const originalCwd = process.cwd();
  const originalExitCode = process.exitCode;
  const originalWrite = process.stderr.write;
  let diagnostic = "";
  try {
    mkdirSync(join(root, ".bounded"));
    writeFileSync(join(root, ".bounded", "version.json"), `${JSON.stringify({ schema: "bounded-project-version/1", version: VERSION })}\n`);
    writeFileSync(join(root, ".bounded", "update-journal.json"), "{\"schema\":\"bounded-update-journal/1\"}\n");
    process.chdir(root);
    process.stderr.write = ((chunk: string | Uint8Array) => { diagnostic += String(chunk); return true; }) as typeof process.stderr.write;
    const checked = await dispatchStandalone(["check"], VERSION);
    expect(checked.answered).toBe(true);
    expect(process.exitCode).toBe(2);
    expect(diagnostic).toMatch(/update|journal|recover/i);
    process.exitCode = undefined;
    expect((await dispatchStandalone(["update"], VERSION)).answered).toBe(false);
  } finally {
    process.chdir(originalCwd);
    process.exitCode = originalExitCode;
    process.stderr.write = originalWrite;
    rmSync(root, { recursive: true, force: true });
  }
});

test("internal managed add refuses an update marker before calling its publisher", async () => {
  const root = mkdtempSync(join(tmpdir(), "bounded-update-internal-add-"));
  try {
    mkdirSync(join(root, ".bounded"));
    writeFileSync(join(root, ".bounded", "update-journal.json"), "{\"schema\":\"bounded-update-journal/1\"}\n");
    let publications = 0;
    const added = await runStandaloneAddInternal(["add", "example@1.0.0"], {
      projectRoot: root, boundedVersion: VERSION,
      get: async () => { throw new Error("network must not run"); },
      publish: async () => { publications++; return { ok: true, value: { lockPath: "unused", receiptPath: "unused", catalogueImports: [] } }; },
    });
    expect(added.ok).toBe(false);
    if (!added.ok) expect(added.error).toMatch(/update|journal|recover/i);
    expect(publications).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
