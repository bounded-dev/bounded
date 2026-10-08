import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostInstaller } from "./host-installer.ts";
import { hookCommand, withHooks } from "./install.ts";

/** A project with bounded-claude-code installed under its node_modules (its main.ts present), and optionally a settings file. */
function project(settings?: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bounded-claude-install-")));
  const installed = join(root, "node_modules", "bounded-claude-code", "src");
  mkdirSync(installed, { recursive: true });
  writeFileSync(join(installed, "main.ts"), "// stand-in\n");
  if (settings !== undefined) {
    mkdirSync(join(root, ".claude"));
    writeFileSync(join(root, ".claude", "settings.json"), settings);
  }
  return root;
}

const settingsOf = (root: string): unknown => JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8"));
/** The command the hook runs: bun, then the project's own installed main.ts. */
const commandFor = (root: string): string => hookCommand({ bun: "bun", main: join(root, "node_modules", "bounded-claude-code", "src", "main.ts") });

describe("the Claude Code host installer", () => {
  test("names its host", () => {
    expect(hostInstaller.host).toBe("claude-code");
  });

  test("in a fresh project, creates .claude/settings.json with the hooks running the project's own installed copy", async () => {
    const root = project();
    expect(await hostInstaller.install(root)).toEqual({ ok: true, value: { host: "claude-code", changedPaths: [".claude/settings.json"], skippedBecause: null } });
    const expected = withHooks({}, commandFor(root));
    expect(expected.ok && settingsOf(root)).toEqual(expected.ok ? expected.value.settings : null);
    expect(JSON.stringify(settingsOf(root))).toContain(join(root, "node_modules", "bounded-claude-code", "src", "main.ts"));
  });

  test("merges into existing settings, keeping every other setting and hook", async () => {
    const theirs = { matcher: "Bash", hooks: [{ type: "command", command: "lint" }] };
    const root = project(JSON.stringify({ model: "opus", hooks: { PreToolUse: [theirs], Stop: [theirs] } }));
    await hostInstaller.install(root);
    const merged = settingsOf(root) as { model: string; hooks: Record<string, unknown[]> };
    expect(merged.model).toBe("opus");
    expect(merged.hooks.Stop).toEqual([theirs]);
    expect(merged.hooks.PreToolUse?.[0]).toEqual(theirs);
    expect(merged.hooks.PreToolUse).toHaveLength(2);
    expect(merged.hooks.PostToolUse).toHaveLength(1);
    expect(merged.hooks.PostToolUseFailure).toHaveLength(1);
  });

  test("is idempotent: a second install changes nothing, and leaves the file's bytes alone", async () => {
    const root = project();
    await hostInstaller.install(root);
    const before = readFileSync(join(root, ".claude", "settings.json"), "utf8");
    expect(await hostInstaller.install(root)).toEqual({ ok: true, value: { host: "claude-code", changedPaths: [], skippedBecause: null } });
    expect(readFileSync(join(root, ".claude", "settings.json"), "utf8")).toBe(before);
  });

  test("refuses settings that are not JSON, leaving them as they were", async () => {
    const root = project("{ not json");
    const done = await hostInstaller.install(root);
    expect(!done.ok && done.error.includes(".claude/settings.json")).toBe(true);
    expect(readFileSync(join(root, ".claude", "settings.json"), "utf8")).toBe("{ not json");
  });

  test("refuses a project without its own installed copy of bounded-claude-code, saying to install it", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "bounded-claude-install-")));
    const done = await hostInstaller.install(root);
    expect(!done.ok && done.error.includes("bounded-claude-code")).toBe(true);
  });
});
