// The host installer `bounded init` and `bounded update` load from this
// package (its ./host-installer export): bounded's hooks merged into the
// project's .claude/settings.json, running the project's own installed copy
// of bounded-claude-code under bun.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HostInstaller } from "bounded/application";
import { hookCommand, withHooks } from "./install.ts";

const SETTINGS = ".claude/settings.json";

async function readSettings(path: string): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { ok: true, value: {} };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (thrown) {
    return { ok: false, error: `${SETTINGS} is not valid JSON (${thrown instanceof Error ? thrown.message : String(thrown)}): fix it, then run this again` };
  }
}

export const hostInstaller: HostInstaller = {
  host: "claude-code",
  async install(projectRoot) {
    const main = join(projectRoot, "node_modules", "bounded-claude-code", "src", "main.ts");
    if (!existsSync(main)) return { ok: false, error: `${main} is missing: install bounded-claude-code in this project, so the hook runs the project's own copy` };
    const path = join(projectRoot, SETTINGS);
    const settings = await readSettings(path);
    if (!settings.ok) return settings;
    const merged = withHooks(settings.value, hookCommand({ bun: "bun", main }));
    if (!merged.ok) return merged;
    if (!merged.value.changed) return { ok: true, value: { host: "claude-code", changedPaths: [], skippedBecause: null } };
    await mkdir(join(projectRoot, ".claude"), { recursive: true });
    await writeFile(path, `${JSON.stringify(merged.value.settings, null, 2)}\n`);
    return { ok: true, value: { host: "claude-code", changedPaths: [SETTINGS], skippedBecause: null } };
  },
};
