import { describe, expect, test } from "vitest";
import { BASH_TOOL, claudeSeatActions, claudeTaskModel, mapToolCall } from "./tool-map.ts";

// ADR 2026-034: the Claude Code hook judges the SAME pi-shaped call the pi
// extension would. These fixtures are the tool_input shapes the Claude Code
// docs give, one per tool, and the pi call each must become.

const CWD = "/proj";
const map = (tool_name: string, tool_input: unknown) => mapToolCall({ tool_name, tool_input }, CWD);

describe("file tools → read/write/edit with input.path", () => {
  test("Read {file_path} → read", () => {
    expect(map("Read", { file_path: "/proj/src/x.ts" })).toEqual([{ toolName: "read", input: { path: "/proj/src/x.ts" } }]);
  });
  test("Write {file_path, content} → write", () => {
    expect(map("Write", { file_path: "/proj/src/x.ts", content: "…" })).toEqual([
      { toolName: "write", input: { path: "/proj/src/x.ts" } },
    ]);
  });
  test("Edit {file_path, old_string, new_string} → edit", () => {
    expect(map("Edit", { file_path: "/proj/a.ts", old_string: "a", new_string: "b" })).toEqual([
      { toolName: "edit", input: { path: "/proj/a.ts" } },
    ]);
  });
  test("NotebookEdit {notebook_path} → edit", () => {
    expect(map("NotebookEdit", { notebook_path: "/proj/n.ipynb", new_source: "" })).toEqual([
      { toolName: "edit", input: { path: "/proj/n.ipynb" } },
    ]);
  });
  test("a missing path is passed through empty, so decide() refuses it as such", () => {
    expect(map("Read", {})).toEqual([{ toolName: "read", input: {} }]);
    expect(map("Read", "not an object")).toEqual([{ toolName: "read", input: {} }]);
    expect(map("Write", undefined)).toEqual([{ toolName: "write", input: {} }]);
  });
});

describe("MultiEdit → one edit per distinct path", () => {
  test("the documented shape: top-level file_path, edits without one", () => {
    expect(map("MultiEdit", { file_path: "/proj/a.ts", edits: [{ old_string: "x", new_string: "y" }] })).toEqual([
      { toolName: "edit", input: { path: "/proj/a.ts" } },
    ]);
  });
  test("per-edit file_path values are judged too, deduplicated", () => {
    expect(
      map("MultiEdit", {
        file_path: "/proj/a.ts",
        edits: [{ file_path: "/proj/b.ts" }, { file_path: "/proj/a.ts" }, { file_path: "/proj/c.ts" }],
      }),
    ).toEqual([
      { toolName: "edit", input: { path: "/proj/a.ts" } },
      { toolName: "edit", input: { path: "/proj/b.ts" } },
      { toolName: "edit", input: { path: "/proj/c.ts" } },
    ]);
  });
  test("no path anywhere → a pathless edit (refused downstream, never allowed)", () => {
    expect(map("MultiEdit", { edits: [{ old_string: "x" }] })).toEqual([{ toolName: "edit", input: {} }]);
  });
});

describe("search tools → find/grep, defaulting to the session cwd", () => {
  test("Glob {pattern, path} → find {path, pattern}", () => {
    expect(map("Glob", { pattern: "**/*.ts", path: "/proj/app" })).toEqual([{ toolName: "find", input: { path: "/proj/app", pattern: "**/*.ts" } }]);
  });
  test("Glob without path searches cwd, so cwd is what is judged", () => {
    expect(map("Glob", { pattern: "**/*.ts" })).toEqual([{ toolName: "find", input: { path: CWD, pattern: "**/*.ts" } }]);
  });
  test("Grep {pattern, path} → grep {path}; without path → cwd", () => {
    expect(map("Grep", { pattern: "TODO", path: "/proj/app" })).toEqual([{ toolName: "grep", input: { path: "/proj/app" } }]);
    expect(map("Grep", { pattern: "TODO" })).toEqual([{ toolName: "grep", input: { path: CWD } }]);
  });
  // ADR 2026-057: a blind role's directory search is judged on its file glob,
  // so the glob must reach the gate exactly as the tool will use it.
  test("Grep's glob rides along under pi's own field name", () => {
    expect(map("Grep", { pattern: "TODO", path: "/proj/app", glob: "*.handler.ts" }))
      .toEqual([{ toolName: "grep", input: { path: "/proj/app", glob: "*.handler.ts" } }]);
    expect(map("Grep", { pattern: "TODO", glob: "!*.test.ts" }))
      .toEqual([{ toolName: "grep", input: { path: CWD, glob: "!*.test.ts" } }]);
  });
  test("a malformed filter is passed through for the gate to refuse, never dropped", () => {
    expect(map("Grep", { pattern: "TODO", glob: ["*.ts"] })).toEqual([{ toolName: "grep", input: { path: CWD, glob: ["*.ts"] } }]);
    expect(map("Glob", { pattern: 7 })).toEqual([{ toolName: "find", input: { path: CWD, pattern: 7 } }]);
  });
  test("LS {path} → ls", () => {
    expect(map("LS", { path: "/proj/tests" })).toEqual([{ toolName: "ls", input: { path: "/proj/tests" } }]);
  });
});

describe("Agent → subagent launch", () => {
  test("subagent_type becomes agent, prompt becomes task, no action (a launch)", () => {
    expect(map("Agent", { subagent_type: "builder", prompt: "implement", description: "d" })).toEqual([
      { toolName: "subagent", input: { agent: "builder", task: "implement" } },
    ]);
  });
  test("Task is the same tool under its older name", () => {
    expect(map("Task", { subagent_type: "reviewer", prompt: "review" })).toEqual([
      { toolName: "subagent", input: { agent: "reviewer", task: "review" } },
    ]);
  });
  test("a shapeless Agent call still reaches the phase gate as a subagent call", () => {
    expect(map("Agent", {})).toEqual([{ toolName: "subagent", input: {} }]);
  });
});

describe("Bash and the rest", () => {
  test("Bash → the explicit bash marker carrying the command", () => {
    expect(map("Bash", { command: "bounded gates typecheck" })).toEqual([{ toolName: BASH_TOOL, input: { command: "bounded gates typecheck" } }]);
    expect(BASH_TOOL).toBe("bash"); // the pi name: decide() would refuse it outright if a host forgot to route it
  });
  test.each(["WebFetch", "WebSearch", "TodoWrite", "AskUserQuestion", "Skill", "SomethingNew"])(
    "%s is not a tool the gate judges → []",
    (tool) => {
      expect(map(tool, { anything: true })).toEqual([]);
    },
  );
});

describe("Agent model passthrough and claudeTaskModel — ADR 2026-022 on this host", () => {
  test("a caller-passed model rides into the mapped spawn so the tier core can judge it", () => {
    const calls = map("Agent", { subagent_type: "builder", prompt: "implement it", model: "haiku" });
    expect(calls).toEqual([{ toolName: "subagent", input: { agent: "builder", task: "implement it", model: "haiku" } }]);
  });

  test.each([
    ["anthropic/claude-opus-5:high", "opus"],
    ["anthropic/claude-sonnet-5", "sonnet"],
    ["claude-haiku-4-5", "haiku"],
    ["anthropic/claude-fable-5", "fable"],
    ["anthropic/claude-mythos-5", "fable"], // same model, Fable's gated tier
  ])("%s → %s", (pattern, family) => {
    expect(claudeTaskModel(pattern)).toBe(family);
  });

  test.each(["fireworks/kimi-k3-fast:medium", "openai/gpt-6", "anthropic/claude-unknown-9"])(
    "%s names no model this host can run",
    (pattern) => {
      expect(claudeTaskModel(pattern)).toBeUndefined();
    },
  );
});

// #47: Claude Code's conversation tools, as the read-only seats' actions.
describe("claudeSeatActions: the session tools", () => {
  test("claudeSeatActions: SubagentHandback is a report to the commissioning seat", () => {
    expect(claudeSeatActions({ tool_name: "SubagentHandback", tool_input: { message: "r" } }, CWD))
      .toEqual([{ kind: "observe", tool: "SubagentHandback" }]);
  });
  test("claudeSeatActions: ToolSearch is a lookup", () => {
    expect(claudeSeatActions({ tool_name: "ToolSearch", tool_input: { query: "select:WebFetch" } }, CWD))
      .toEqual([{ kind: "lookup", tool: "ToolSearch" }]);
  });
});
