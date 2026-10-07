import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decidePlanner, deny, gitPolicy, shellWords } from "./planner-gate.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "planner-gate-")));
mkdirSync(join(root, ".agent-state", "core"), { recursive: true });

const write = (path: string) => decidePlanner({ tool_name: "Write", tool_input: { file_path: path } }, root);
const bash = (command: string) => decidePlanner({ tool_name: "Bash", tool_input: { command } }, root);

describe("planner-gate writes", () => {
  test("allows the plan under .agent-state/", () => {
    expect(write(".agent-state/core/plan.md")).toEqual({ allow: true });
    expect(write(join(root, ".agent-state/core/plan.md"))).toEqual({ allow: true });
  });

  test("refuses a write anywhere else, naming the path", () => {
    const decision = write("contexts/core/src/x.ts");
    expect(decision.allow).toBe(false);
    expect(!decision.allow && decision.reason).toBe(
      "planner-gate: the planner writes only its plan under .agent-state/<item>/, not contexts/core/src/x.ts",
    );
  });

  test("refuses climbing out of .agent-state with ..", () => {
    expect(write(".agent-state/../package.json").allow).toBe(false);
    expect(write(".agent-state").allow).toBe(false);
  });

  test("refuses a symbolic link inside .agent-state that points outside it", () => {
    symlinkSync(join(root, "src"), join(root, ".agent-state", "escape"));
    expect(write(".agent-state/escape/x.ts").allow).toBe(false);
  });

  test("refuses Edit, MultiEdit and NotebookEdit outside .agent-state as well", () => {
    for (const tool of ["Edit", "MultiEdit"]) {
      expect(decidePlanner({ tool_name: tool, tool_input: { file_path: "README.md" } }, root).allow).toBe(false);
    }
    expect(decidePlanner({ tool_name: "NotebookEdit", tool_input: { notebook_path: "x.ipynb" } }, root).allow).toBe(false);
  });

  test("refuses a write with no path and a call with no tool name", () => {
    expect(decidePlanner({ tool_name: "Write", tool_input: {} }, root).allow).toBe(false);
    expect(decidePlanner({ tool_input: {} }, root).allow).toBe(false);
  });

  test("lets read-only tools through to the agent's own allowlist", () => {
    expect(decidePlanner({ tool_name: "Read", tool_input: { file_path: "/etc/hosts" } }, root)).toEqual({ allow: true });
  });
});

describe("planner-gate commands", () => {
  test("allows one plain read-only command", () => {
    for (const command of ["git log --oneline -5", "git show HEAD:README.md", "git diff --stat main", "gh issue view 3", "gh pr diff 4", "ls docs", "pwd", "git status --short"]) {
      expect(bash(command)).toEqual({ allow: true });
    }
  });

  test("refuses separators, pipes, redirects, substitutions and globs", () => {
    for (const command of ["git log; rm -rf x", "git log | head", "git log > out", "echo $(id)", "ls *.ts", "ls && pwd", "ls ~/x", "ls \\x"]) {
      expect(bash(command).allow).toBe(false);
    }
  });

  test("refuses a command that is not on the list", () => {
    const decision = bash("rm -rf contexts");
    expect(!decision.allow && decision.reason).toContain("rm is not on the planner's read-only list");
  });

  test("refuses gh writes and --web", () => {
    expect(bash("gh issue create").allow).toBe(false);
    expect(bash("gh pr view 3 --web").allow).toBe(false);
  });

  test("refuses mutating git and git options that write or redirect", () => {
    for (const command of ["git commit -m x", "git checkout main", "git -C /tmp log", "git diff --output=/tmp/x", "git log --ext-diff", "git log --format --output=x"]) {
      expect(bash(command).allow).toBe(false);
    }
  });

  test("refuses a missing command and an empty one", () => {
    expect(decidePlanner({ tool_name: "Bash", tool_input: {} }, root).allow).toBe(false);
    expect(bash("").allow).toBe(false);
  });
});

describe("planner-gate helpers", () => {
  test("shellWords keeps quoted words whole and refuses an unterminated quote", () => {
    expect(shellWords(`git log --grep 'a b' "c d"`)).toEqual({ ok: true, argv: ["git", "log", "--grep", "a b", "c d"] });
    expect(shellWords("git log 'x").ok).toBe(false);
    expect(shellWords('git log "$HOME"').ok).toBe(false);
  });

  test("gitPolicy accepts valued and stuck options and refuses a missing value", () => {
    expect(gitPolicy(["log", "-n", "3", "--format=%H"])).toBeUndefined();
    expect(gitPolicy(["log", "-n"])).toBe("git log option '-n' needs a value");
    expect(gitPolicy(["--no-pager", "show", "HEAD"])).toBeUndefined();
  });

  test("deny prints Claude Code's PreToolUse refusal", () => {
    expect(JSON.parse(deny("no"))).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no" },
    });
  });
});
