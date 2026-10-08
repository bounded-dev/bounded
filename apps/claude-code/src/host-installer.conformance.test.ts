import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostInstallerConformance, snapshotFiles } from "bounded/testing/host-installer-conformance";
import { hostInstaller } from "./host-installer.ts";
import { HOOK_TIMEOUT_SECONDS, hookCommand, PROJECT_HOOK_COMMAND } from "./install.ts";

/** A project with bounded-claude-code installed under its node_modules. */
function project(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bounded-claude-conformance-")));
  mkdirSync(join(root, "node_modules", "bounded-claude-code", "src"), { recursive: true });
  writeFileSync(join(root, "node_modules", "bounded-claude-code", "src", "main.ts"), "// stand-in\n");
  return root;
}

hostInstallerConformance("the Claude Code host installer", hostInstaller, async (kind) => {
  const root = project();
  // A directory where the settings file belongs: it cannot be read as a file.
  if (kind === "unreadable") mkdirSync(join(root, ".claude", "settings.json"), { recursive: true });
  return { root, snapshot: () => snapshotFiles(root) };
});

const mainOf = (root: string): string => join(root, "node_modules", "bounded-claude-code", "src", "main.ts");
const wrapped = (command: string): string => `{\n${command}\n} || { echo "bounded hook failed" >&2; exit 2; }`;
const settingsOf = (root: string): { hooks: Record<string, { hooks: { command: string }[] }[]> } => JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8"));

describe("the Claude Code host installer, in a project that moved or shares its settings", () => {
  test("settings copied from another project (a teammate's checkout, or a move) already fit: one project-relative hook per event, nothing to change", async () => {
    const a = project();
    const b = project();
    await hostInstaller.install(a);
    mkdirSync(join(b, ".claude"));
    writeFileSync(join(b, ".claude", "settings.json"), readFileSync(join(a, ".claude", "settings.json")));
    expect(await hostInstaller.install(b)).toEqual({ ok: true, value: { host: "claude-code", changedPaths: [], skippedBecause: null } });
    for (const event of ["PreToolUse", "PostToolUse", "PostToolUseFailure"]) {
      const entries = settingsOf(b).hooks[event] ?? [];
      expect(entries).toHaveLength(1);
      expect(entries[0]?.hooks[0]?.command).toBe(wrapped(PROJECT_HOOK_COMMAND));
    }
    expect(JSON.stringify(settingsOf(b))).not.toContain(a);
  });

  test("an older install's absolute-path hook is replaced by the project-relative one", async () => {
    const root = project();
    const older = { type: "command", command: wrapped(hookCommand({ bun: "bun", main: mainOf(root) })), timeout: HOOK_TIMEOUT_SECONDS };
    mkdirSync(join(root, ".claude"));
    writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "", hooks: [older] }] } }));
    expect(await hostInstaller.install(root)).toEqual({ ok: true, value: { host: "claude-code", changedPaths: [".claude/settings.json"], skippedBecause: null } });
    expect((settingsOf(root).hooks.PreToolUse ?? []).map((entry) => entry.hooks.map((hook) => hook.command))).toEqual([[wrapped(PROJECT_HOOK_COMMAND)]]);
  });

  test("a stale hook from a checkout is replaced; other hooks, a role's hook and the rest of its entry stay", async () => {
    const root = project();
    const lint = { type: "command", command: "lint" };
    const stale = { type: "command", command: wrapped(hookCommand({ bun: "/usr/local/bin/bun", main: "/old/checkout/apps/claude-code/src/main.ts" })), timeout: HOOK_TIMEOUT_SECONDS };
    const role = { type: "command", command: wrapped(hookCommand({ bun: "bun", main: "/old/checkout/apps/claude-code/src/main.ts", role: "reviewer" })) };
    mkdirSync(join(root, ".claude"));
    writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "", hooks: [lint, stale] }, { matcher: "", hooks: [role] }] } }));
    await hostInstaller.install(root);
    const pre = settingsOf(root).hooks.PreToolUse ?? [];
    expect(pre.map((entry) => entry.hooks.map((hook) => hook.command))).toEqual([["lint"], [role.command], [wrapped(PROJECT_HOOK_COMMAND)]]);
  });

  test("settings that exist but cannot be read are refused and left alone, not replaced", async () => {
    if (process.getuid?.() === 0) return; // root reads every file
    const root = project();
    mkdirSync(join(root, ".claude"));
    const path = join(root, ".claude", "settings.json");
    writeFileSync(path, JSON.stringify({ model: "opus" }));
    chmodSync(path, 0o000);
    const installed = await hostInstaller.install(root);
    chmodSync(path, 0o600);
    expect(!installed.ok && installed.error.includes("cannot be read")).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(JSON.stringify({ model: "opus" }));
  });
});
