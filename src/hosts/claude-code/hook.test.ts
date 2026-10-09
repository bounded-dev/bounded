import { describe, expect, test } from "bun:test";
import { type ShellCommandReadingJSON, type ToolResult, Verdict } from "bounded/domain";
import type { ReadShellCommand } from "bounded-shell-command-reader/shell-command-reading";
import type { PathResolver, ToolUse } from "./event.ts";
import { type AdapterRefusal, type AfterTool, type Decide, respond, runHook } from "./hook.ts";

/** A value's wire form: its JSON, parsed. */
const wireOf = (value: unknown): unknown => JSON.parse(JSON.stringify(value) ?? "null");

const deny = (reason: string, redirect: string): string =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `${reason}\n${redirect}` } });

const paths: PathResolver = { resolve: (raw) => ({ ok: true, value: { path: raw.replace(/^\/p\/?/, "") || ".", exists: true } }) };
/** The reading the stand-in reader gives every command: one running tool-a from the project root. */
const READ: ShellCommandReadingJSON = { outcome: "read", programs: [{ name: { kind: "literal", text: "tool-a" }, arguments: [], workingDirectory: "." }], fileEffects: [], unresolved: [] };
const readShellCommand: ReadShellCommand = { prepare: async () => {}, read: async () => READ };
const stdin = (tool_name: string, tool_input: Record<string, unknown>): string => JSON.stringify({ hook_event_name: "PreToolUse", tool_name, tool_input, cwd: "/p", session_id: "s" });
const hook = (decide: Decide, role: string | null = null) => ({ projectRoot: "/p", role, decide, paths, readShellCommand, deadlineMs: 1000 });
const recording =
  (seen: ToolUse[]): Decide =>
  (event) => {
    seen.push(event);
    return Verdict.allow;
  };
const FAILED = "Report this to the maintainers of bounded; the call stays refused until it is fixed";

describe("runHook: the call's id, refusals the adapter makes, and PostToolUse", () => {
  const after = (tool_name: string, tool_input: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ hook_event_name: "PostToolUse", tool_name, tool_input, tool_response: {}, tool_use_id: "toolu_1", cwd: "/p", ...extra });

  test("a PreToolUse call carries Claude Code's tool_use_id to the core as the call id", async () => {
    const seen: ToolUse[] = [];
    await runHook(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "make" }, tool_use_id: "toolu_1", cwd: "/p" }), hook(recording(seen)));
    expect(seen[0]?.callId?.value).toBe("toolu_1");
  });

  test("a refusal the adapter makes itself is recorded, and the answer is still that refusal", async () => {
    const recorded: AdapterRefusal[] = [];
    const out = await runHook(stdin("Read", {}), { ...hook(recording([]), "builder"), record: async (refusal) => void recorded.push(refusal) });
    expect(out).toBe(deny("Claude Code's Read call has no file_path to check", "Retry the call with its file_path given as text"));
    expect(recorded).toEqual([{ hostToolName: "Read", reason: "Claude Code's Read call has no file_path to check", redirect: "Retry the call with its file_path given as text", role: "builder", input: {} }]);
  });

  test("a recording that fails or hangs never changes or delays the answer", async () => {
    const out = await runHook(stdin("Read", {}), { ...hook(recording([])), record: () => new Promise(() => {}) });
    expect(out).toBe(deny("Claude Code's Read call has no file_path to check", "Retry the call with its file_path given as text"));
    const failing = await runHook(stdin("Read", {}), { ...hook(recording([])), record: async () => { throw new Error("no log"); } });
    expect(failing).toBe(out);
  });

  test("a PostToolUse call asks afterTool about the finished call; what was undone is told to Claude", async () => {
    const results: ToolResult[] = [];
    const afterTool: AfterTool = async (result) => {
      results.push(result);
      return { message: "This command changed protected files, and they were restored: generated/a.ts was modified." };
    };
    const out = await runHook(after("Bash", { command: "./regenerate.sh" }), { ...hook(recording([])), afterTool });
    expect(JSON.parse(out)).toEqual({ decision: "block", reason: "This command changed protected files, and they were restored: generated/a.ts was modified." });
    expect(wireOf(results[0])).toEqual({ kind: "tool-result", role: null, tool: "shell", effects: [{ kind: "execute", command: "./regenerate.sh", cwd: ".", reading: READ }], ok: true, callId: "toolu_1" });
  });

  test("a PostToolUse for a Bash call reaches afterTool with its execute effect's reading", async () => {
    const results: ToolResult[] = [];
    const asked: unknown[] = [];
    const reading: ReadShellCommand = {
      prepare: async () => {},
      read: async (input) => {
        asked.push(input);
        return READ;
      },
    };
    const afterTool: AfterTool = async (result) => {
      results.push(result);
      return { message: null };
    };
    expect(await runHook(after("Bash", { command: "./regenerate.sh" }), { ...hook(recording([])), readShellCommand: reading, afterTool })).toBe("");
    expect(asked).toEqual([{ projectRoot: "/p", command: "./regenerate.sh", cwd: "." }]);
    const [effect] = results[0]?.effects ?? [];
    expect(effect?.kind === "execute" && effect.reading.toJSON()).toEqual(READ);
  });

  test("a PostToolUse whose re-read of a Bash command never settles is told, at the hook's deadline", async () => {
    const hanging: ReadShellCommand = { prepare: async () => {}, read: () => new Promise(() => {}) };
    let checked = false;
    const afterTool: AfterTool = async () => {
      checked = true;
      return { message: null };
    };
    const out = await runHook(after("Bash", { command: "ls" }), { ...hook(recording([])), readShellCommand: hanging, afterTool, deadlineMs: 50 });
    expect(JSON.parse(out).decision).toBe("block");
    expect(JSON.parse(out).reason).toContain("no answer within 50 ms");
    expect(checked).toBe(false);
  });

  test("a PostToolUse with nothing undone, or no afterTool, answers nothing", async () => {
    expect(await runHook(after("Bash", { command: "ls" }), { ...hook(recording([])), afterTool: async () => ({ message: null }) })).toBe("");
    expect(await runHook(after("Bash", { command: "ls" }), hook(recording([])))).toBe("");
  });

  test("a PostToolUseFailure call (a command that failed, such as exit 1) is checked as a failed call, and what was undone is added to Claude's context", async () => {
    const results: ToolResult[] = [];
    const afterTool: AfterTool = async (result) => {
      results.push(result);
      return { message: "This command changed protected files, and they were restored: generated/a.ts was modified." };
    };
    const failed = JSON.stringify({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "./regenerate.sh; exit 1" }, tool_use_id: "toolu_1", error: "Exit code 1", cwd: "/p" });
    const out = await runHook(failed, { ...hook(recording([])), afterTool });
    expect(JSON.parse(out)).toEqual({
      hookSpecificOutput: { hookEventName: "PostToolUseFailure", additionalContext: "This command changed protected files, and they were restored: generated/a.ts was modified." },
    });
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.callId?.value).toBe("toolu_1");
    expect(await runHook(failed, { ...hook(recording([])), afterTool: async () => ({ message: null }) })).toBe("");
  });

  // Hand-written from the documented fields and the captured shapes (Claude Code 2.1.294); 1b replaces them with captured fixtures.
  const agentAfter = async (stdinText: string): Promise<ToolResult | undefined> => {
    const results: ToolResult[] = [];
    await runHook(stdinText, { ...hook(recording([])), afterTool: async (result) => {
      results.push(result);
      return { message: null };
    } });
    return results[0];
  };

  test("a completed Agent response reaches afterTool with its run finished", async () => {
    const result = await agentAfter(after("Agent", { subagent_type: "plan-reviewer", prompt: "review" }, { tool_response: { status: "completed", harnessNoteCount: 0, content: [{ type: "text", text: "Reviewed." }] } }));
    expect(wireOf(result)).toEqual({ kind: "tool-result", role: null, tool: "subagent", effects: [{ kind: "delegate", agent: "plan-reviewer" }], ok: true, callId: "toolu_1", delegatedAgentRuns: [{ finished: true }] });
  });

  test("a launched Agent response reaches afterTool with its run not finished", async () => {
    const result = await agentAfter(after("Agent", { subagent_type: "plan-reviewer", prompt: "review" }, { tool_response: { status: "async_launched", isAsync: true, agentId: "a1" } }));
    expect(result?.ok).toBe(true);
    expect(result?.delegatedAgentRuns).toEqual([{ finished: false }]);
    // A run stopped at its turn limit says completed, with a harness note: not finished either.
    const limited = await agentAfter(after("Agent", { subagent_type: "plan-reviewer", prompt: "review" }, { tool_response: { status: "completed", harnessNoteCount: 1, content: [] } }));
    expect(limited?.delegatedAgentRuns).toEqual([{ finished: false }]);
  });

  test("a PostToolUseFailure for Agent reaches afterTool with its run not finished", async () => {
    const failed = JSON.stringify({ hook_event_name: "PostToolUseFailure", tool_name: "Agent", tool_input: { subagent_type: "plan-reviewer", prompt: "review" }, tool_use_id: "toolu_1", error: "interrupted", cwd: "/p" });
    const result = await agentAfter(failed);
    expect(result?.ok).toBe(false);
    expect(result?.delegatedAgentRuns).toEqual([{ finished: false }]);
  });

  test("a check after the call that fails is recorded as well as told", async () => {
    const recorded: AdapterRefusal[] = [];
    const out = await runHook(after("Bash", { command: "ls" }), { ...hook(recording([]), "builder"), afterTool: async () => { throw new Error("boom"); }, record: async (refusal) => void recorded.push(refusal) });
    const reason = "bounded could not check protected files after this call: boom. Check them against version control.";
    expect(JSON.parse(out)).toEqual({ decision: "block", reason });
    expect(recorded).toEqual([{ hostToolName: "Bash", reason, redirect: "Check the protected files against version control", role: "builder", input: { command: "ls" } }]);
  });

  test("a PostToolUse whose check fails tells Claude so, never silently", async () => {
    const out = await runHook(after("Bash", { command: "ls" }), { ...hook(recording([])), afterTool: async () => { throw new Error("boom"); } });
    expect(JSON.parse(out)).toEqual({ decision: "block", reason: "bounded could not check protected files after this call: boom. Check them against version control." });
  });
});

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
  test("decide sees the translated event; its allow is empty output", async () => {
    const seen: ToolUse[] = [];
    const out = await runHook(stdin("Edit", { file_path: "/p/src/a.ts" }), hook(recording(seen), "builder"));
    expect(out).toBe("");
    expect(wireOf(seen)).toEqual([{ kind: "tool-use", role: "builder", tool: "edit", effects: [{ kind: "write", path: "src/a.ts", change: "modify" }] }]);
  });

  test("decide's refusal is a deny", async () => {
    const out = await runHook(stdin("Bash", { command: "rm -rf /" }), hook(() => Verdict.refuse("No", "Ask")));
    expect(out).toBe(deny("No", "Ask"));
  });

  test("input that cannot be translated is denied without asking decide", async () => {
    let asked = false;
    const decide: Decide = () => {
      asked = true;
      return Verdict.allow;
    };
    expect(await runHook("", hook(decide))).toBe(deny("The hook was given no input", "Register bounded's hook for PreToolUse, PostToolUse and PostToolUseFailure, as the install helper does"));
    expect(await runHook("{oops", hook(decide))).toStartWith('{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"The hook\'s input is not JSON: ');
    expect(await runHook(stdin("Read", {}), hook(decide))).toBe(deny("Claude Code's Read call has no file_path to check", "Retry the call with its file_path given as text"));
    expect(asked).toBe(false);
  });

  test("a payload without a usable cwd is resolved from the project directory", async () => {
    const seen: ToolUse[] = [];
    const relative: PathResolver = { resolve: (raw, cwd) => ({ ok: true, value: { path: `${cwd}|${raw}`.replace(/^\/p\|/, ""), exists: true } }) };
    const payload = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "a.ts" } });
    await runHook(payload, { ...hook(recording(seen)), paths: relative });
    expect(wireOf(seen[0]?.effects)).toEqual([{ kind: "read", path: "a.ts" }]);
  });

  test("a decide that throws, or returns no verdict, is a deny, never an allow", async () => {
    const boom: Decide = () => {
      throw new Error("boom");
    };
    expect(await runHook(stdin("Read", { file_path: "/p/a" }), hook(boom))).toBe(deny("bounded's Claude Code hook failed: boom", FAILED));
    const notAVerdict = (() => true) as unknown as Decide;
    expect(await runHook(stdin("Read", { file_path: "/p/a" }), hook(notAVerdict))).toBe(
      deny(
        "bounded's Claude Code hook failed: A verdict is { kind: 'allow' } or { kind: 'refuse', reason, redirect } with a non-empty reason and redirect",
        "Report this to the maintainers of bounded; the call stays refused until it is fixed",
      ),
    );
  });

  test("decide may be asynchronous: its settled verdict is the answer, its rejection a deny", async () => {
    expect(await runHook(stdin("Read", { file_path: "/p/a" }), hook(async () => Verdict.refuse("Later no", "Ask")))).toBe(deny("Later no", "Ask"));
    expect(await runHook(stdin("Read", { file_path: "/p/a" }), hook(async () => Verdict.allow))).toBe("");
    const rejects: Decide = () => Promise.reject(new Error("nope"));
    expect(await runHook(stdin("Read", { file_path: "/p/a" }), hook(rejects))).toBe(deny("bounded's Claude Code hook failed: nope", FAILED));
  });

  test("a decide that never settles is denied at the deadline, before Claude Code's own timeout", async () => {
    const started = Date.now();
    const out = await runHook(stdin("Read", { file_path: "/p/a" }), { ...hook(() => new Promise<Verdict>(() => {})), deadlineMs: 50 });
    expect(out).toBe(deny("bounded did not decide within 50 ms", "Retry the call; if it keeps timing out, report it to the maintainers of bounded"));
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("a Bash call whose read never settles is denied at the hook's deadline", async () => {
    let asked = false;
    const hanging: ReadShellCommand = { prepare: async () => {}, read: () => new Promise(() => {}) };
    const decide: Decide = () => {
      asked = true;
      return Verdict.allow;
    };
    const out = await runHook(stdin("Bash", { command: "ls" }), { ...hook(decide), readShellCommand: hanging, deadlineMs: 50 });
    expect(out).toBe(deny("bounded did not decide within 50 ms", "Retry the call; if it keeps timing out, report it to the maintainers of bounded"));
    expect(asked).toBe(false);
  });

  test("decide is told the project it decides for", async () => {
    const projects: unknown[] = [];
    await runHook(stdin("Read", { file_path: "/p/a" }), hook((_event, project) => {
      projects.push(project);
      return Verdict.allow;
    }));
    expect(projects).toEqual([{ projectRoot: "/p" }]);
  });
});
