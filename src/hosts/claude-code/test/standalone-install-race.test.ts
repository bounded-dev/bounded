import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareStandaloneClaudeHooks } from "../standalone-install.ts";

test("Claude standalone installer preserves a user settings file created after preparation", async () => {
  const root = mkdtempSync(join(tmpdir(), "bounded-claude-install-race-"));
  try {
    mkdirSync(join(root, ".claude"));
    const prepared = await prepareStandaloneClaudeHooks(root, "/verified/bounded");
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const settingsPath = join(root, ".claude", "settings.json");
    const userBytes = '{"hooks":{},"userFlag":true}\n';
    writeFileSync(settingsPath, userBytes);
    const installed = await prepared.value.install();
    expect(installed.ok).toBe(false);
    expect(readFileSync(settingsPath, "utf8")).toBe(userBytes);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Claude standalone rollback refuses to overwrite a user edit after installation", async () => {
  const root = mkdtempSync(join(tmpdir(), "bounded-claude-rollback-race-"));
  try {
    mkdirSync(join(root, ".claude"));
    const prepared = await prepareStandaloneClaudeHooks(root, "/verified/bounded");
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect((await prepared.value.install()).ok).toBe(true);
    const settingsPath = join(root, ".claude", "settings.json");
    const userBytes = `${readFileSync(settingsPath, "utf8")}\n`;
    writeFileSync(settingsPath, userBytes);
    await expect(prepared.value.restore()).rejects.toThrow(/changed|user edit|preserve/i);
    expect(readFileSync(settingsPath, "utf8")).toBe(userBytes);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
