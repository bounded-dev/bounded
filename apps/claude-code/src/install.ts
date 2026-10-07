// Installing the hook: bounded's PreToolUse entry merged into a project's
// .claude/settings.json object. Pure; the caller reads and writes the file.
import type { Result } from "bounded/domain";
import { isRecord } from "./json.ts";

type Settings = Readonly<Record<string, unknown>>;

/** Claude Code's timeout for the hook, in seconds. bounded answers well before it (composition-root.ts). */
export const HOOK_TIMEOUT_SECONDS = 30;

/**
 * The command as installed: if it cannot run at all (no bun, a crash before
 * main.ts answers), exit 2 blocks the call. The command sits on its own lines
 * inside a group, so a comment or a ';' in it cannot escape the wrapper.
 */
const failClosed = (command: string): string => `{\n${command}\n} || { echo "bounded hook failed" >&2; exit 2; }`;
/** The forms earlier versions installed: replaced, never left beside the current one. */
const olderForms = (command: string): readonly string[] => [command, `${command} || { echo "bounded hook failed" >&2; exit 2; }`];

const quote = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`;

/** The command that runs the hook: bun, then main.ts, then the role if any, each shell-quoted. */
export function hookCommand({ bun, main, role }: { bun: string; main: string; role?: string }): string {
  return [quote(bun), quote(main), ...(role === undefined ? [] : ["--role", quote(role)])].join(" ");
}

/** Whether a PreToolUse entry is ours: it runs `command` as a command hook for every tool. */
function isOurs(entry: unknown, command: string): boolean {
  if (!isRecord(entry) || !(entry.matcher === undefined || entry.matcher === "" || entry.matcher === "*")) return false;
  const hooks = entry.hooks;
  return Array.isArray(hooks) && hooks.some((hook) => isRecord(hook) && hook.type === "command" && hook.command === command);
}

/** The entries with every hook running an older form of `command` removed, and entries left empty dropped. */
function withoutOlder(entries: readonly unknown[], command: string): unknown[] {
  const older = olderForms(command);
  const isOlder = (hook: unknown): boolean => isRecord(hook) && hook.type === "command" && typeof hook.command === "string" && older.includes(hook.command);
  return entries.flatMap((entry) => {
    if (!isRecord(entry) || !Array.isArray(entry.hooks) || !entry.hooks.some(isOlder)) return [entry];
    const kept = entry.hooks.filter((hook) => !isOlder(hook));
    return kept.length === 0 ? [] : [{ ...entry, hooks: kept }];
  });
}

/** The settings with bounded's hook running `command` before every tool call. Idempotent; everything else is kept. */
export function withHook(settings: unknown, command: string): Result<{ settings: Settings; changed: boolean }> {
  if (command.trim() === "") return { ok: false, error: "The hook command is empty" };
  if (!isRecord(settings)) return { ok: false, error: ".claude/settings.json is not a JSON object" };
  if (settings.disableAllHooks === true) return { ok: false, error: ".claude/settings.json sets disableAllHooks, so bounded's hook would never run. Remove it, then install again" };
  const hooks = settings.hooks ?? {};
  if (!isRecord(hooks)) return { ok: false, error: ".claude/settings.json's 'hooks' is not an object" };
  const entries = hooks.PreToolUse ?? [];
  if (!Array.isArray(entries)) return { ok: false, error: ".claude/settings.json's 'hooks.PreToolUse' is not a list" };
  const installed = failClosed(command);
  const kept = withoutOlder(entries, command);
  const replaced = kept.length !== entries.length || kept.some((entry, at) => entry !== entries[at]);
  if (!replaced && kept.some((entry) => isOurs(entry, installed))) return { ok: true, value: { settings, changed: false } };
  const ours = { matcher: "", hooks: [{ type: "command", command: installed, timeout: HOOK_TIMEOUT_SECONDS }] };
  const merged = kept.some((entry) => isOurs(entry, installed)) ? kept : [...kept, ours];
  return { ok: true, value: { settings: { ...settings, hooks: { ...hooks, PreToolUse: merged } }, changed: true } };
}
