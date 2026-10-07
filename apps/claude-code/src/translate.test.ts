import { describe, expect, test } from "bun:test";
import { readPayload, translate } from "./translate.ts";

const payload = (tool_name: string, tool_input: Record<string, unknown>) => ({ tool_name, tool_input, cwd: "/p" });
const call = (tool_name: string, tool_input: Record<string, unknown>) => {
  const result = translate(payload(tool_name, tool_input));
  if (!result.ok) throw new Error(result.error.reason);
  return result.value;
};
const refusal = (tool_name: string, tool_input: Record<string, unknown>): string => {
  const result = translate(payload(tool_name, tool_input));
  if (result.ok) throw new Error(`translated: ${JSON.stringify(result.value)}`);
  return result.error.reason;
};

describe("translate: every Claude Code tool to a host-neutral call", () => {
  test.each([
    ["Read", { file_path: "/p/a.ts" }, { tool: "read", effects: [{ kind: "read", path: "/p/a.ts" }] }],
    ["Write", { file_path: "/p/a.ts", content: "x" }, { tool: "write", effects: [{ kind: "write", path: "/p/a.ts", change: "create-or-modify" }] }],
    ["Edit", { file_path: "/p/a.ts", old_string: "a", new_string: "b" }, { tool: "edit", effects: [{ kind: "write", path: "/p/a.ts", change: "modify" }] }],
    ["NotebookEdit", { notebook_path: "/p/n.ipynb", new_source: "" }, { tool: "edit", effects: [{ kind: "write", path: "/p/n.ipynb", change: "modify" }] }],
    ["LS", { path: "/p/src" }, { tool: "search", effects: [{ kind: "list", root: "/p/src" }] }],
    ["Glob", { pattern: "**/*.ts", path: "/p/src" }, { tool: "search", effects: [{ kind: "list", root: "/p/src", filter: "**/*.ts" }] }],
    ["Glob", { pattern: "**/*.ts" }, { tool: "search", effects: [{ kind: "list", root: ".", filter: "**/*.ts" }] }],
    ["Grep", { pattern: "TODO", glob: "*.md", path: "docs" }, { tool: "search", effects: [{ kind: "list", root: "docs", filter: "*.md" }, { kind: "read", path: "docs" }] }],
    ["Grep", { pattern: "TODO" }, { tool: "search", effects: [{ kind: "list", root: "." }, { kind: "read", path: "." }] }],
    ["Bash", { command: "ls -la", description: "list" }, { tool: "shell", effects: [{ kind: "execute", command: "ls -la" }] }],
    ["Agent", { subagent_type: "Explore", prompt: "look" }, { tool: "subagent", effects: [{ kind: "delegate", agent: "Explore" }] }],
    ["Task", { prompt: "look" }, { tool: "subagent", effects: [{ kind: "delegate", agent: "general-purpose" }] }],
    ["WebFetch", { url: "https://example.com", prompt: "x" }, { tool: "web", effects: [{ kind: "fetch", url: "https://example.com" }] }],
    ["WebSearch", { query: "x" }, { tool: "web", effects: [{ kind: "execute", command: "WebSearch" }] }],
    ["Skill", { skill: "x" }, { tool: "other", effects: [{ kind: "execute", command: "Skill" }] }],
    ["mcp__docs__read", { id: "1" }, { tool: "other", effects: [{ kind: "execute", command: "mcp__docs__read" }] }],
  ])("%s %j", (tool, input, expected) => {
    expect(call(tool, input)).toEqual(expected as never);
  });

  test("MultiEdit modifies the top-level path and every edit's own path, once each, in order", () => {
    const edits = [{ old_string: "a", new_string: "b" }, { file_path: "/p/b.ts", old_string: "a", new_string: "b" }, { file_path: "/p/a.ts" }];
    expect(call("MultiEdit", { file_path: "/p/a.ts", edits })).toEqual({
      tool: "edit",
      effects: [
        { kind: "write", path: "/p/a.ts", change: "modify" },
        { kind: "write", path: "/p/b.ts", change: "modify" },
      ],
    });
  });

  test("a call without the path or command its tool needs is refused, never passed through", () => {
    expect(refusal("Read", {})).toBe("Claude Code's Read call has no file_path to check");
    expect(refusal("Write", { file_path: 3 })).toBe("Claude Code's Write call has no file_path to check");
    expect(refusal("NotebookEdit", { notebook_path: "" })).toBe("Claude Code's NotebookEdit call has no notebook_path to check");
    expect(refusal("MultiEdit", { edits: [{ old_string: "a" }] })).toBe("Claude Code's MultiEdit call has no file_path to check");
    expect(refusal("MultiEdit", { file_path: "/p/a.ts", edits: [{ file_path: 7 }] })).toBe("Claude Code's MultiEdit call has an edit whose file_path is not text");
    expect(refusal("LS", {})).toBe("Claude Code's LS call has no path to check");
    expect(refusal("Glob", { pattern: "*", path: 1 })).toBe("Claude Code's Glob call has a path that is not text");
    expect(refusal("Grep", { pattern: "x", glob: ["*.ts"] })).toBe("Claude Code's Grep call has a glob that is not text");
    expect(refusal("Bash", { command: "  " })).toBe("Claude Code's Bash call has no command to check");
    expect(refusal("Agent", { subagent_type: 5 })).toBe("Claude Code's Agent call has a subagent_type that is not text");
    expect(refusal("WebFetch", { prompt: "x" })).toBe("Claude Code's WebFetch call has no url to check");
  });

  test("every refusal says what to do next", () => {
    const result = translate(payload("Read", {}));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.redirect).toBe("Retry the call with its file_path given as text");
  });
});

describe("readPayload: the hook's stdin, fail closed", () => {
  const good = { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "a" }, cwd: "/p", session_id: "s" };
  const reason = (stdin: string): string => {
    const result = readPayload(stdin);
    if (result.ok) throw new Error("read");
    return result.error.reason;
  };

  test("keeps the tool name, its input and the session's directory, nothing else", () => {
    expect(readPayload(JSON.stringify(good))).toEqual({ ok: true, value: { tool_name: "Read", tool_input: { file_path: "a" }, cwd: "/p" } });
  });

  test("a missing or relative cwd is no directory", () => {
    expect(readPayload(JSON.stringify({ ...good, cwd: undefined }))).toEqual({ ok: true, value: { tool_name: "Read", tool_input: { file_path: "a" }, cwd: null } });
    expect(readPayload(JSON.stringify({ ...good, cwd: "rel" }))).toEqual({ ok: true, value: { tool_name: "Read", tool_input: { file_path: "a" }, cwd: null } });
  });

  test("empty, malformed or misshapen input is refused", () => {
    expect(reason("")).toBe("The hook was given no input");
    expect(reason("  \n")).toBe("The hook was given no input");
    expect(reason("{not json")).toStartWith("The hook's input is not JSON: ");
    expect(reason("[]")).toBe("The hook's input is not a PreToolUse call: an object with tool_name and tool_input");
    expect(reason(JSON.stringify({ ...good, tool_name: "" }))).toBe("The hook's input is not a PreToolUse call: an object with tool_name and tool_input");
    expect(reason(JSON.stringify({ ...good, tool_input: "x" }))).toBe("The hook's input is not a PreToolUse call: an object with tool_name and tool_input");
    expect(reason(JSON.stringify({ ...good, hook_event_name: "PostToolUse" }))).toBe("The hook is registered for PostToolUse; it answers only PreToolUse");
  });
});
