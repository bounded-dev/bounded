import { describe, expect, test } from "bun:test";
import { Verdict } from "bounded/domain";
import type { PathResolver, ToolUse } from "./event.ts";
import { type Decide, respond, runHook } from "./hook.ts";

const deny = (reason: string, redirect: string): string =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `${reason}\n${redirect}` } });

const paths: PathResolver = { resolve: (raw) => ({ ok: true, value: { path: raw.replace(/^\/p\/?/, "") || ".", exists: true } }) };
const stdin = (tool_name: string, tool_input: Record<string, unknown>): string => JSON.stringify({ hook_event_name: "PreToolUse", tool_name, tool_input, cwd: "/p", session_id: "s" });
const hook = (decide: Decide, role: string | null = null) => ({ projectDir: "/p", role, decide, paths });

describe("respond: a verdict in Claude Code's words", () => {
  test("allow is empty output, so Claude Code's own permissions still apply", () => {
    expect(respond(Verdict.allow)).toBe("");
  });

  test("refuse is a PreToolUse deny carrying the reason, then the redirect", () => {
    expect(respond(Verdict.refuse("No edits under generated/", "Change the generator instead"))).toBe(
      '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"No edits under generated/\\nChange the generator instead"}}',
    );
  });
});

describe("runHook: stdin to stdout, fail closed", () => {
  test("decide sees the translated event; its allow is empty output", () => {
    const seen: ToolUse[] = [];
    const out = runHook(stdin("Edit", { file_path: "/p/src/a.ts" }), hook((event) => (seen.push(event), Verdict.allow), "builder"));
    expect(out).toBe("");
    expect(seen).toEqual([{ kind: "tool-use", role: "builder", tool: "edit", effects: [{ kind: "write", path: "src/a.ts", change: "modify" }] }] as never);
  });

  test("decide's refusal is a deny", () => {
    const out = runHook(stdin("Bash", { command: "rm -rf /" }), hook(() => Verdict.refuse("No", "Ask")));
    expect(out).toBe(deny("No", "Ask"));
  });

  test("input that cannot be translated is denied without asking decide", () => {
    let asked = false;
    const decide: Decide = () => ((asked = true), Verdict.allow);
    expect(runHook("", hook(decide))).toBe(deny("The hook was given no input", "Register bounded's hook for PreToolUse only, as the install helper does"));
    expect(runHook("{oops", hook(decide))).toStartWith('{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"The hook\'s input is not JSON: ');
    expect(runHook(stdin("Read", {}), hook(decide))).toBe(deny("Claude Code's Read call has no file_path to check", "Retry the call with its file_path given as text"));
    expect(asked).toBe(false);
  });

  test("a payload without a usable cwd is resolved from the project directory", () => {
    const seen: ToolUse[] = [];
    const relative: PathResolver = { resolve: (raw, cwd) => ({ ok: true, value: { path: `${cwd}|${raw}`.replace(/^\/p\|/, ""), exists: true } }) };
    const payload = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "a.ts" } });
    runHook(payload, { ...hook((event) => (seen.push(event), Verdict.allow)), paths: relative });
    expect(seen[0]?.effects).toEqual([{ kind: "read", path: "a.ts" }] as never);
  });

  test("a decide that throws, or returns no verdict, is a deny, never an allow", () => {
    const boom: Decide = () => {
      throw new Error("boom");
    };
    expect(runHook(stdin("Read", { file_path: "/p/a" }), hook(boom))).toBe(deny("bounded's Claude Code hook failed: boom", "Report this to the maintainers of bounded; the call stays refused until it is fixed"));
    const notAVerdict = (() => true) as unknown as Decide;
    expect(runHook(stdin("Read", { file_path: "/p/a" }), hook(notAVerdict))).toBe(
      deny(
        "bounded's Claude Code hook failed: A verdict is { kind: 'allow' } or { kind: 'refuse', reason, redirect } with a non-empty reason and redirect",
        "Report this to the maintainers of bounded; the call stays refused until it is fixed",
      ),
    );
  });
});
