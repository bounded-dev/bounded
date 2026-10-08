// The host installer `bounded init` and `bounded update` run for Claude Code:
// bounded carries it as bounded/hosts/claude-code/host-installer. It merges
// bounded's hooks into the project's .claude/settings.json, running the hook bounded carries under
// node, in the project's own installed copy, through $CLAUDE_PROJECT_DIR. A
// bounded hook pointing elsewhere (an older install's bun command, absolute
// path or bounded-claude-code package, or a checkout of this repository) is replaced.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HostInstaller } from "bounded/application";
import { BUNDLED_HOOK, isBoundedHook, PROJECT_HOOK_COMMAND, withProjectHooks } from "./install.ts";
import { isRecord } from "./json.ts";

const SETTINGS = ".claude/settings.json";

const message = (thrown: unknown): string => (thrown instanceof Error ? thrown.message : String(thrown));
const isMissing = (thrown: unknown): boolean => thrown instanceof Error && "code" in thrown && thrown.code === "ENOENT";

/** The settings as stored: {} only when the file does not exist; any other read error, or text that is not JSON, is a refusal. */
async function readSettings(path: string): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (thrown) {
    if (isMissing(thrown)) return { ok: true, value: {} };
    return { ok: false, error: `${SETTINGS} cannot be read (${message(thrown)}): fix it, then run this again; it was left as it is` };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (thrown) {
    return { ok: false, error: `${SETTINGS} is not valid JSON (${message(thrown)}): fix it, then run this again; it was left as it is` };
  }
}

export const hostInstaller: HostInstaller = {
  host: "claude-code",
  async install(projectRoot) {
    const hook = join(projectRoot, BUNDLED_HOOK);
    if (!existsSync(hook)) return { ok: false, error: `${hook} is missing: install bounded in this project (npx bounded init), so the hook runs the project's own copy` };
    const path = join(projectRoot, SETTINGS);
    const settings = await readSettings(path);
    if (!settings.ok) return settings;
    const merged = withProjectHooks(settings.value, PROJECT_HOOK_COMMAND);
    if (!merged.ok) return merged;
    if (!merged.value.changed) return { ok: true, value: { host: "claude-code", changedPaths: [], skippedBecause: null } };
    await mkdir(join(projectRoot, ".claude"), { recursive: true });
    await writeFile(path, `${JSON.stringify(merged.value.settings, null, 2)}\n`);
    return { ok: true, value: { host: "claude-code", changedPaths: [SETTINGS], skippedBecause: null } };
  },
  /**
   * Whether .claude/settings.json holds a bounded hook, in any form an install wrote. Settings that exist
   * but cannot be read or parsed count as installed, so a refresh runs install, which refuses and says why,
   * rather than skipping Claude Code in silence.
   */
  async isInstalled(projectRoot) {
    const settings = await readSettings(join(projectRoot, SETTINGS));
    if (!settings.ok) return true;
    if (!isRecord(settings.value) || !isRecord(settings.value.hooks)) return false;
    return Object.values(settings.value.hooks).some((entries) => Array.isArray(entries) && entries.some((entry) => isRecord(entry) && Array.isArray(entry.hooks) && entry.hooks.some(isBoundedHook)));
  },
};
