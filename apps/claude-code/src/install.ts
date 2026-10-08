// Installing the hook: bounded's PreToolUse, PostToolUse and PostToolUseFailure entries merged into a project's
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

/**
 * The command a project's hook runs: bun on the project's own installed
 * copy, found through CLAUDE_PROJECT_DIR, which Claude Code sets for every
 * hook to the project's root. The variable sits inside double quotes, so the
 * shell expands it and a root with spaces stays one word; the rest is fixed
 * text. The same settings therefore work in every checkout, wherever it is.
 */
export const PROJECT_HOOK_COMMAND = 'bun "$CLAUDE_PROJECT_DIR/node_modules/bounded-claude-code/src/main.ts"';

/** The hook events bounded is installed for: before every call to judge it, after it to undo what it changed. */
type HookEvent = "PreToolUse" | "PostToolUse" | "PostToolUseFailure";

/** Whether a hook entry is ours: it runs `command` as a command hook for every tool. */
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

/** The events bounded is installed for: before every call, after it, and after it failed (a command exiting non-zero). */
const EVENTS: readonly HookEvent[] = ["PreToolUse", "PostToolUse", "PostToolUseFailure"];

/** The settings with bounded's hook running `command` before every tool call, after it and after its failure. Idempotent; everything else is kept. */
export function withHooks(settings: unknown, command: string): Result<{ settings: Settings; changed: boolean }> {
  let out: { settings: Settings; changed: boolean } = { settings: settings as Settings, changed: false };
  for (const event of EVENTS) {
    const next = withHook(out.settings, command, event);
    if (!next.ok) return next;
    out = { settings: next.value.settings, changed: out.changed || next.value.changed };
  }
  return { ok: true, value: out };
}

/**
 * Whether a settings hook is bounded's own Claude Code hook without a role,
 * wherever it pointed: a command hook running bounded-claude-code's main.ts
 * (an installed copy, or a checkout's apps/claude-code), in any form an
 * install wrote. Its path does not count, so a moved or re-cloned project's
 * stale entry is recognised.
 */
export function isBoundedHook(hook: unknown): boolean {
  if (!isRecord(hook) || hook.type !== "command" || typeof hook.command !== "string") return false;
  return /(bounded-claude-code|apps\/claude-code)\/src\/main\.ts\b/.test(hook.command) && !/\s--role\s/.test(hook.command);
}

/**
 * The settings with bounded's hooks running `command` before every tool call,
 * after it and after its failure, and every other bounded hook without a
 * role (one pointing at another path, as after the project moved) removed.
 * Idempotent; everything else is kept.
 */
export function withProjectHooks(settings: unknown, command: string): Result<{ settings: Settings; changed: boolean }> {
  if (!isRecord(settings) || !isRecord(settings.hooks)) return withHooks(settings, command);
  const installed = failClosed(command);
  const isStale = (hook: unknown): boolean => isBoundedHook(hook) && isRecord(hook) && hook.command !== installed;
  let stripped = false;
  const hooks: Record<string, unknown> = { ...settings.hooks };
  for (const event of EVENTS) {
    const entries = hooks[event];
    if (!Array.isArray(entries)) continue;
    hooks[event] = entries.flatMap((entry) => {
      if (!isRecord(entry) || !Array.isArray(entry.hooks) || !entry.hooks.some(isStale)) return [entry];
      stripped = true;
      const kept = entry.hooks.filter((hook) => !isStale(hook));
      return kept.length === 0 ? [] : [{ ...entry, hooks: kept }];
    });
  }
  const merged = withHooks(stripped ? { ...settings, hooks } : settings, command);
  if (!merged.ok) return merged;
  return { ok: true, value: { settings: merged.value.settings, changed: stripped || merged.value.changed } };
}

/** The settings with bounded's hook running `command` on every tool call's `event`, PreToolUse by default. Idempotent; everything else is kept. */
export function withHook(settings: unknown, command: string, event: HookEvent = "PreToolUse"): Result<{ settings: Settings; changed: boolean }> {
  if (command.trim() === "") return { ok: false, error: "The hook command is empty" };
  if (!isRecord(settings)) return { ok: false, error: ".claude/settings.json is not a JSON object" };
  if (settings.disableAllHooks === true) return { ok: false, error: ".claude/settings.json sets disableAllHooks, so bounded's hook would never run. Remove it, then install again" };
  const hooks = settings.hooks ?? {};
  if (!isRecord(hooks)) return { ok: false, error: ".claude/settings.json's 'hooks' is not an object" };
  const entries = hooks[event] ?? [];
  if (!Array.isArray(entries)) return { ok: false, error: `.claude/settings.json's 'hooks.${event}' is not a list` };
  const installed = failClosed(command);
  const kept = withoutOlder(entries, command);
  const replaced = kept.length !== entries.length || kept.some((entry, at) => entry !== entries[at]);
  if (!replaced && kept.some((entry) => isOurs(entry, installed))) return { ok: true, value: { settings, changed: false } };
  const ours = { matcher: "", hooks: [{ type: "command", command: installed, timeout: HOOK_TIMEOUT_SECONDS }] };
  const merged = kept.some((entry) => isOurs(entry, installed)) ? kept : [...kept, ours];
  return { ok: true, value: { settings: { ...settings, hooks: { ...hooks, [event]: merged } }, changed: true } };
}
