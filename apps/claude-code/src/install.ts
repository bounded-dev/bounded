// Installing the hook: bounded's PreToolUse entry merged into a project's
// .claude/settings.json object. Pure; the caller reads and writes the file.
import type { Result } from "bounded/domain";

type Settings = Readonly<Record<string, unknown>>;
const isRecord = (value: unknown): value is Settings => typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a PreToolUse entry already runs `command`, whatever its matcher or options. */
function runs(entry: unknown, command: string): boolean {
  const hooks = isRecord(entry) ? entry.hooks : undefined;
  return Array.isArray(hooks) && hooks.some((hook) => isRecord(hook) && hook.command === command);
}

/** The settings with bounded's hook running `command` before every tool call. Idempotent; everything else is kept. */
export function withHook(settings: unknown, command: string): Result<{ settings: Settings; changed: boolean }> {
  if (command.trim() === "") return { ok: false, error: "The hook command is empty" };
  if (!isRecord(settings)) return { ok: false, error: ".claude/settings.json is not a JSON object" };
  const hooks = settings.hooks ?? {};
  if (!isRecord(hooks)) return { ok: false, error: ".claude/settings.json's 'hooks' is not an object" };
  const entries = hooks.PreToolUse ?? [];
  if (!Array.isArray(entries)) return { ok: false, error: ".claude/settings.json's 'hooks.PreToolUse' is not a list" };
  if (entries.some((entry) => runs(entry, command))) return { ok: true, value: { settings, changed: false } };
  const ours = { matcher: "", hooks: [{ type: "command", command }] };
  return { ok: true, value: { settings: { ...settings, hooks: { ...hooks, PreToolUse: [...entries, ours] } }, changed: true } };
}
