import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HostInstallReport } from "bounded/application";
import type { Result } from "bounded/domain";
import { withProjectHooks } from "./install.ts";

const SETTINGS = ".claude/settings.json";
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const missing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";
const quotePosix = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
const quotePowerShell = (value: string): string => `'${value.replaceAll("'", "''")}'`;

function commandFor(executable: string): string {
  return process.platform === "win32"
    ? `& ${quotePowerShell(executable)} hook claude-code --project $env:CLAUDE_PROJECT_DIR`
    : `${quotePosix(executable)} hook claude-code --project "$CLAUDE_PROJECT_DIR"`;
}

export interface PreparedStandaloneClaudeHooks {
  readonly settingsPath: string;
  readonly originalBytes: string | null;
  readonly nextBytes: string;
  readonly mode: number;
  install(): Promise<Result<HostInstallReport>>;
  restore(): Promise<void>;
}

async function replaceSettings(path: string, bytes: string, mode: number): Promise<void> {
  const staged = join(dirname(path), `.bounded-settings-${randomUUID()}.tmp`);
  try {
    await writeFile(staged, bytes, { flag: "wx", mode });
    await chmod(staged, mode);
    await rename(staged, path);
  } finally {
    await rm(staged, { force: true });
  }
}

/** Stage the complete settings document before changing the project. */
export async function prepareStandaloneClaudeHooks(projectRoot: string, executable: string): Promise<Result<PreparedStandaloneClaudeHooks>> {
  const settingsPath = join(projectRoot, SETTINGS);
  let originalBytes: string | null = null;
  let mode = 0o644;
  try {
    const directory = join(projectRoot, ".claude");
    try {
      const details = lstatSync(directory);
      if (!details.isDirectory() || details.isSymbolicLink()) return { ok: false, error: `${directory} is linked or not a directory` };
    } catch (error) { if (!missing(error)) return { ok: false, error: `${directory} cannot be inspected: ${message(error)}` }; }
    try {
      const details = lstatSync(settingsPath);
      if (!details.isFile() || details.isSymbolicLink()) return { ok: false, error: `${SETTINGS} is linked or not a regular file` };
      mode = (await stat(settingsPath)).mode & 0o777;
      originalBytes = await readFile(settingsPath, "utf8");
    } catch (error) { if (!missing(error)) return { ok: false, error: `${SETTINGS} cannot be read: ${message(error)}` }; }
    let current: unknown = {};
    if (originalBytes !== null) {
      try { current = JSON.parse(originalBytes); }
      catch { return { ok: false, error: `${SETTINGS} is not valid JSON; fix it before installing Bounded` }; }
    }
    const merged = withProjectHooks(current, commandFor(executable), process.platform === "win32" ? "powershell" : "posix");
    if (!merged.ok) return merged;
    const nextBytes = `${JSON.stringify(merged.value.settings, null, 2)}\n`;
    return { ok: true, value: {
      settingsPath, originalBytes, nextBytes, mode,
      async install() {
        if (originalBytes === nextBytes) return { ok: true, value: { host: "claude-code", changedPaths: [], skippedBecause: null } };
        try {
          await mkdir(dirname(settingsPath), { recursive: true });
          await replaceSettings(settingsPath, nextBytes, mode);
          return { ok: true, value: { host: "claude-code", changedPaths: [SETTINGS], skippedBecause: null } };
        } catch (error) { return { ok: false, error: `${SETTINGS} could not be replaced: ${message(error)}` }; }
      },
      async restore() {
        if (originalBytes === null) await rm(settingsPath, { force: true });
        else await replaceSettings(settingsPath, originalBytes, mode);
      },
    } };
  } catch (error) {
    return { ok: false, error: `${SETTINGS} cannot be prepared: ${message(error)}` };
  }
}
