import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostInstaller } from "./host-installer.ts";
import { PROJECT_HOOK_COMMAND, withHooks } from "./install.ts";

/** A project with bounded installed under its node_modules (its bundled Claude Code hook present), and optionally a settings file. */
function project(settings?: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bounded-claude-install-")));
  const installed = join(root, "node_modules", "bounded", "dist", "hosts", "claude-code");
  mkdirSync(installed, { recursive: true });
  writeFileSync(join(installed, "hook.js"), "// stand-in\n");
  if (settings !== undefined) {
    mkdirSync(join(root, ".claude"));
    writeFileSync(join(root, ".claude", "settings.json"), settings);
  }
  return root;
}

const settingsOf = (root: string): unknown => JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8"));

describe("the Claude Code host installer", () => {
  test("names its host", () => {
    expect(hostInstaller.host).toBe("claude-code");
  });

  test("in a fresh project, creates .claude/settings.json with the hooks running bounded's bundled hook under node, through $CLAUDE_PROJECT_DIR", async () => {
    const root = project();
    expect(await hostInstaller.install(root)).toEqual({ ok: true, value: { host: "claude-code", changedPaths: [".claude/settings.json"], skippedBecause: null } });
    // Claude Code sets CLAUDE_PROJECT_DIR for hooks, so the settings work in every checkout of the project, wherever it is.
    expect(PROJECT_HOOK_COMMAND).toBe('node "$CLAUDE_PROJECT_DIR/node_modules/bounded/dist/hosts/claude-code/hook.js"');
    const expected = withHooks({}, PROJECT_HOOK_COMMAND);
    expect(expected.ok && settingsOf(root)).toEqual(expected.ok ? expected.value.settings : null);
    expect(JSON.stringify(settingsOf(root))).not.toContain(root);
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

  test("refuses a project without its own installed copy of bounded, saying to install it", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "bounded-claude-install-")));
    const done = await hostInstaller.install(root);
    expect(!done.ok && done.error.includes("npx bounded init")).toBe(true);
  });

  test("says whether bounded is installed for Claude Code: a bounded hook in .claude/settings.json, in any form an install wrote", async () => {
    const root = project();
    expect(await hostInstaller.isInstalled?.(root)).toBe(false);
    await hostInstaller.install(root);
    expect(await hostInstaller.isInstalled?.(root)).toBe(true);
    const earlier = project(JSON.stringify({ hooks: { PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: 'bun "$CLAUDE_PROJECT_DIR/node_modules/bounded-claude-code/src/main.ts"' }] }] } }));
    expect(await hostInstaller.isInstalled?.(earlier)).toBe(true);
    const unrelated = project(JSON.stringify({ hooks: { PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: "lint" }] }] } }));
    expect(await hostInstaller.isInstalled?.(unrelated)).toBe(false);
  });

  test("an install made before SubagentStop gains it on the next install, as bounded update runs it", async () => {
    const wrapped = `{\n${PROJECT_HOOK_COMMAND}\n} || { echo "bounded hook failed" >&2; exit 2; }`;
    const entry = (command: string) => [{ matcher: "", hooks: [{ type: "command", command, timeout: 30 }] }];
    const root = project(JSON.stringify({ hooks: { PreToolUse: entry(wrapped), PostToolUse: entry(wrapped), PostToolUseFailure: entry(wrapped) } }));
    expect(await hostInstaller.install(root)).toEqual({ ok: true, value: { host: "claude-code", changedPaths: [".claude/settings.json"], skippedBecause: null } });
    const settings = settingsOf(root) as { hooks: Record<string, unknown> };
    expect(settings.hooks.SubagentStop).toEqual(entry(PROJECT_HOOK_COMMAND));
    expect(settings.hooks.PreToolUse).toEqual(entry(wrapped));
    expect(await hostInstaller.install(root)).toEqual({ ok: true, value: { host: "claude-code", changedPaths: [], skippedBecause: null } });
  });
});
