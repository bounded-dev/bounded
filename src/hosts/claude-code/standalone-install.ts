import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HostInstallReport } from "bounded/application";
import type { Result } from "bounded/domain";
import { isBoundedHook, PROJECT_HOOK_COMMAND, withHooks, withProjectHooks } from "./install.ts";

const SETTINGS = ".claude/settings.json";
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const missing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";
const quotePosix = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
const quotePowerShell = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function commandFor(executable: string): string {
  return process.platform === "win32"
    ? `& ${quotePowerShell(executable)} hook claude-code --project $env:CLAUDE_PROJECT_DIR`
    : `${quotePosix(executable)} hook claude-code --project "$CLAUDE_PROJECT_DIR"`;
}

function withoutPriorGeneratedHooks(settings: unknown, priorCommand: string, shell: "posix" | "powershell"): Result<unknown> {
  if (!record(settings) || !record(settings.hooks)) return { ok: false, error: `${SETTINGS} has no complete previous Bounded hook set` };
  const generated = withHooks({}, priorCommand, shell);
  if (!generated.ok || !record(generated.value.settings.hooks)) return { ok: false, error: `${SETTINGS} cannot generate the previous Bounded hook set` };
  const hooks: Record<string, unknown> = { ...settings.hooks };
  for (const event of ["PreToolUse", "PostToolUse", "PostToolUseFailure", "SubagentStop"]) {
    const oldEntries = generated.value.settings.hooks[event];
    const oldEntry = Array.isArray(oldEntries) ? oldEntries[0] : undefined;
    const currentEntries = settings.hooks[event];
    if (oldEntry === undefined || !Array.isArray(currentEntries))
      return { ok: false, error: `${SETTINGS} has an incomplete previous Bounded ${event} hook set` };
    const recognized = currentEntries.filter((entry) => JSON.stringify(entry) === JSON.stringify(oldEntry));
    const boundedCandidates = currentEntries.filter((entry) => record(entry) && Array.isArray(entry.hooks)
      && entry.hooks.some((hook) => isBoundedHook(hook)
        || (record(hook) && typeof hook.command === "string" && hook.command.includes("hook claude-code"))));
    if (recognized.length !== 1 || boundedCandidates.length !== 1 || boundedCandidates[0] !== recognized[0])
      return { ok: false, error: `${SETTINGS} has an edited, duplicate, or mixed previous Bounded ${event} hook; repair it before updating` };
    hooks[event] = currentEntries.filter((entry) => entry !== recognized[0]);
  }
  return { ok: true, value: { ...settings, hooks } };
}

/** Verify that recorded host bytes are the exact generated transition between two releases. */
export function verifyStandaloneClaudeHookTransition(beforeBytes: string, afterBytes: string, executable: string,
  options: { readonly recognizedPriorExecutable?: string; readonly recognizedPriorNodeHooks?: true }): Result<void> {
  if (options.recognizedPriorExecutable !== undefined && options.recognizedPriorNodeHooks === true)
    return { ok: false, error: `${SETTINGS} has ambiguous previous Bounded hooks` };
  let previous: unknown;
  try { previous = JSON.parse(beforeBytes); }
  catch { return { ok: false, error: `${SETTINGS} has an invalid previous Bounded hook backup` }; }
  const oldCommand = options.recognizedPriorNodeHooks === true ? PROJECT_HOOK_COMMAND
    : options.recognizedPriorExecutable === undefined ? undefined : commandFor(options.recognizedPriorExecutable);
  if (oldCommand === undefined) return { ok: false, error: `${SETTINGS} has no exact previous Bounded hook identity` };
  const stripped = withoutPriorGeneratedHooks(previous, oldCommand,
    options.recognizedPriorNodeHooks === true ? "posix" : process.platform === "win32" ? "powershell" : "posix");
  if (!stripped.ok) return stripped;
  const generated = withHooks(stripped.value, commandFor(executable), process.platform === "win32" ? "powershell" : "posix");
  if (!generated.ok) return generated;
  const expected = `${JSON.stringify(generated.value.settings, null, 2)}\n`;
  if (afterBytes !== expected)
    return { ok: false, error: `${SETTINGS} does not match the exact generated Bounded target hooks` };
  return { ok: true, value: undefined };
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
export async function prepareStandaloneClaudeHooks(projectRoot: string, executable: string, options: {
  readonly recognizedPriorExecutable?: string;
  readonly recognizedPriorNodeHooks?: true;
} = {}): Promise<Result<PreparedStandaloneClaudeHooks>> {
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
    if (options.recognizedPriorExecutable !== undefined && options.recognizedPriorNodeHooks === true)
      return { ok: false, error: `${SETTINGS} cannot classify both previous standalone and Node hooks` };
    const recognized = options.recognizedPriorExecutable !== undefined
      ? withoutPriorGeneratedHooks(current, commandFor(options.recognizedPriorExecutable), process.platform === "win32" ? "powershell" : "posix")
      : options.recognizedPriorNodeHooks === true
        ? withoutPriorGeneratedHooks(current, PROJECT_HOOK_COMMAND, "posix")
        : { ok: true as const, value: current };
    if (!recognized.ok) return recognized;
    const merged = options.recognizedPriorExecutable === undefined && options.recognizedPriorNodeHooks !== true
      ? withProjectHooks(recognized.value, commandFor(executable), process.platform === "win32" ? "powershell" : "posix")
      : withHooks(recognized.value, commandFor(executable), process.platform === "win32" ? "powershell" : "posix");
    if (!merged.ok) return merged;
    const nextBytes = `${JSON.stringify(merged.value.settings, null, 2)}\n`;
    let installedByThisAttempt = false;
    const requireCurrent = async (expected: string | null, expectedMode: number): Promise<void> => {
      const directory = join(projectRoot, ".claude");
      try {
        const info = lstatSync(directory);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("host directory changed");
      } catch (error) {
        if (!missing(error) || expected !== null) throw error;
      }
      try {
        const info = lstatSync(settingsPath);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error("settings path changed");
        if (expected === null || (await readFile(settingsPath, "utf8")) !== expected
          || (info.mode & 0o777) !== expectedMode) throw new Error("settings changed after preparation");
      } catch (error) {
        if (!missing(error) || expected !== null) throw error;
      }
    };
    return { ok: true, value: {
      settingsPath, originalBytes, nextBytes, mode,
      async install() {
        try {
          await requireCurrent(originalBytes, mode);
          if (originalBytes === nextBytes) return { ok: true, value: { host: "claude-code", changedPaths: [], skippedBecause: null } };
          await mkdir(dirname(settingsPath), { recursive: true });
          await replaceSettings(settingsPath, nextBytes, mode);
          installedByThisAttempt = true;
          return { ok: true, value: { host: "claude-code", changedPaths: [SETTINGS], skippedBecause: null } };
        } catch (error) { return { ok: false, error: `${SETTINGS} could not be replaced: ${message(error)}` }; }
      },
      async restore() {
        if (!installedByThisAttempt) return;
        await requireCurrent(nextBytes, mode);
        if (originalBytes === null) await rm(settingsPath, { force: true });
        else await replaceSettings(settingsPath, originalBytes, mode);
        installedByThisAttempt = false;
      },
    } };
  } catch (error) {
    return { ok: false, error: `${SETTINGS} cannot be prepared: ${message(error)}` };
  }
}
