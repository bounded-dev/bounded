// Installing the hook: bounded's PreToolUse entry merged into a project's
// .claude/settings.json object. Pure; the caller reads and writes the file.
import type { Result } from "bounded/domain";
import { isRecord } from "./json.ts";

type Settings = Readonly<Record<string, unknown>>;

/** Claude Code's timeout for the hook, in seconds. bounded answers well before it (composition-root.ts). */
export const HOOK_TIMEOUT_SECONDS = 30;

/** The command as installed: if it cannot run at all (no bun, a crash before main.ts answers), exit 2 blocks the call. */
const failClosed = (command: string): string => `${command} || { echo "bounded hook failed" >&2; exit 2; }`;

/** Whether a PreToolUse entry is ours: it runs `command` as a command hook for every tool. */
function isOurs(entry: unknown, command: string): boolean {
  if (!isRecord(entry) || !(entry.matcher === undefined || entry.matcher === "" || entry.matcher === "*")) return false;
  const hooks = entry.hooks;
  return Array.isArray(hooks) && hooks.some((hook) => isRecord(hook) && hook.type === "command" && hook.command === command);
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
  if (entries.some((entry) => isOurs(entry, installed))) return { ok: true, value: { settings, changed: false } };
  const ours = { matcher: "", hooks: [{ type: "command", command: installed, timeout: HOOK_TIMEOUT_SECONDS }] };
  return { ok: true, value: { settings: { ...settings, hooks: { ...hooks, PreToolUse: [...entries, ours] } }, changed: true } };
}
