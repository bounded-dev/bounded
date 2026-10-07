import { describe, expect, test } from "bun:test";
import { HOOK_TIMEOUT_SECONDS, withHook } from "./install.ts";

const COMMAND = "bun /opt/bounded/apps/claude-code/src/main.ts";
// If the command cannot run at all (bun missing, a crash before main), exit 2 blocks the call.
const WRAPPED = `${COMMAND} || { echo "bounded hook failed" >&2; exit 2; }`;
const ours = { matcher: "", hooks: [{ type: "command", command: WRAPPED, timeout: HOOK_TIMEOUT_SECONDS }] };

describe("withHook: bounded's PreToolUse hook merged into .claude/settings.json", () => {
  test("adds the hook to empty settings", () => {
    expect(withHook({}, COMMAND)).toEqual({ ok: true, value: { settings: { hooks: { PreToolUse: [ours] } }, changed: true } });
  });

  test("keeps every other setting and hook, appending ours last", () => {
    const theirs = { matcher: "Bash", hooks: [{ type: "command", command: "lint" }] };
    const settings = { model: "opus", hooks: { PreToolUse: [theirs], PostToolUse: [theirs] } };
    expect(withHook(settings, COMMAND)).toEqual({ ok: true, value: { settings: { model: "opus", hooks: { PreToolUse: [theirs, ours], PostToolUse: [theirs] } }, changed: true } });
    expect(settings.hooks.PreToolUse).toEqual([theirs]);
  });

  test("is idempotent: a hook already running the command is left as it is", () => {
    const once = withHook({}, COMMAND);
    if (!once.ok) throw new Error(once.error);
    expect(withHook(once.value.settings, COMMAND)).toEqual({ ok: true, value: { settings: once.value.settings, changed: false } });
    const custom = { hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: WRAPPED, timeout: 30 }] }] } };
    expect(withHook(custom, COMMAND)).toEqual({ ok: true, value: { settings: custom, changed: false } });
  });

  test("refuses settings it would have to guess at, naming the field", () => {
    expect(withHook([], COMMAND)).toEqual({ ok: false, error: ".claude/settings.json is not a JSON object" });
    expect(withHook({ hooks: [] }, COMMAND)).toEqual({ ok: false, error: ".claude/settings.json's 'hooks' is not an object" });
    expect(withHook({ hooks: { PreToolUse: {} } }, COMMAND)).toEqual({ ok: false, error: ".claude/settings.json's 'hooks.PreToolUse' is not a list" });
    expect(withHook({}, " ")).toEqual({ ok: false, error: "The hook command is empty" });
  });

  test("an entry counts as ours only when it runs the command for every tool, as a command hook", () => {
    const narrowed = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: WRAPPED }] }] } };
    expect(withHook(narrowed, COMMAND)).toEqual({ ok: true, value: { settings: { hooks: { PreToolUse: [...narrowed.hooks.PreToolUse, ours] } }, changed: true } });
    const notACommand = { hooks: { PreToolUse: [{ matcher: "", hooks: [{ type: "prompt", command: WRAPPED }] }] } };
    expect(withHook(notACommand, COMMAND)).toEqual({ ok: true, value: { settings: { hooks: { PreToolUse: [...notACommand.hooks.PreToolUse, ours] } }, changed: true } });
    const bare = { hooks: { PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: COMMAND }] }] } };
    expect(withHook(bare, COMMAND)).toEqual({ ok: true, value: { settings: { hooks: { PreToolUse: [...bare.hooks.PreToolUse, ours] } }, changed: true } });
    const noMatcher = { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: WRAPPED }] }] } };
    expect(withHook(noMatcher, COMMAND)).toEqual({ ok: true, value: { settings: noMatcher, changed: false } });
  });

  test("refuses to install where no hook would run", () => {
    expect(withHook({ disableAllHooks: true }, COMMAND)).toEqual({ ok: false, error: ".claude/settings.json sets disableAllHooks, so bounded's hook would never run. Remove it, then install again" });
  });
});
