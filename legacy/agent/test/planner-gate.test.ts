// The planner's tool gate (scripts/workflow/planner-gate.ts, ADR LEG-2026-068):
// the harness-planner development agent writes only under .agent-state/ and
// runs only read-only commands. Its tests run here so `npm run check` covers it.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { decidePlanner } from "../../scripts/workflow/planner-gate.ts";

const SCRIPT = fileURLToPath(new URL("../../scripts/workflow/planner-gate.ts", import.meta.url));
const PLANNER = fileURLToPath(new URL("../../.claude/agents/harness-planner.md", import.meta.url));

const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "planner-gate-"));
  temporary.push(root);
  mkdirSync(join(root, ".agent-state", "45"), { recursive: true });
  return root;
}

const write = (file_path: string) => ({ tool_name: "Write", tool_input: { file_path, content: "x" } });
const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });

describe("file writes", () => {
  test("allows Write and Edit under .agent-state/", () => {
    const root = project();
    expect(decidePlanner(write(join(root, ".agent-state/45/plan.md")), root)).toEqual({ allow: true });
    expect(decidePlanner(write(".agent-state/45/plan.md"), root)).toEqual({ allow: true });
    expect(decidePlanner({ tool_name: "Edit", tool_input: { file_path: join(root, ".agent-state/45/plan.md") } }, root).allow).toBe(true);
  });

  test("refuses writes anywhere else, including by climbing out or through a link", () => {
    const root = project();
    symlinkSync(join(root, "agent"), join(root, ".agent-state", "escape"));
    for (const path of [
      join(root, "agent/src/x.ts"),
      join(root, "AGENTS.md"),
      join(root, ".agent-state/../AGENTS.md"),
      join(root, ".agent-state"),
      join(root, ".agent-state-other/plan.md"),
      join(root, ".agent-state/escape/x.ts"),
      "/elsewhere/plan.md",
    ]) {
      const decision = decidePlanner(write(path), root);
      expect(decision.allow, path).toBe(false);
    }
    expect(decidePlanner({ tool_name: "MultiEdit", tool_input: { file_path: join(root, "a.ts") } }, root).allow).toBe(false);
    expect(decidePlanner({ tool_name: "NotebookEdit", tool_input: { notebook_path: join(root, "a.ipynb") } }, root).allow).toBe(false);
    expect(decidePlanner({ tool_name: "Write", tool_input: {} }, root).allow).toBe(false);
  });
});

describe("shell commands", () => {
  const root = "/project";
  const allowed = (command: string) => decidePlanner(bash(command), root).allow;

  test("allows reading the issue, the history and the tree", () => {
    for (const command of [
      "gh issue view 45 --comments", "gh issue list --state open", "gh pr view 12", "gh pr diff 12",
      "git log --oneline -5", "git show HEAD:AGENTS.md", "git diff main", "git status", "ls agent/src", "pwd",
    ]) expect(allowed(command), command).toBe(true);
  });

  test("refuses anything that writes, sends or runs another program", () => {
    for (const command of [
      "git commit -m x", "git push", "git checkout main", "git -C /tmp log", "git -c alias.x=!sh x",
      "gh issue comment 45 --body x", "gh issue edit 45", "gh issue close 45", "gh pr create", "gh api repos/x",
      "gh issue view 45 --web", "rm -rf agent", "npm test", "node x.js", "touch .agent-state/x", "cat AGENTS.md",
      "ls; rm x", "gh issue view 45 > .agent-state/45/issue.md", "echo $(rm x)", "FOO=1 ls", "",
    ]) expect(allowed(command), command).toBe(false);
  });

  test("a refusal names what the planner may run instead", () => {
    const decision = decidePlanner(bash("npm test"), root);
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toMatch(/gh issue view/);
  });
});

test("tools the gate does not govern pass through", () => {
  expect(decidePlanner({ tool_name: "Read", tool_input: { file_path: "/anything" } }, "/project")).toEqual({ allow: true });
  expect(decidePlanner({ tool_name: "Grep", tool_input: { pattern: "x" } }, "/project")).toEqual({ allow: true });
});

describe("as a Claude Code PreToolUse hook", () => {
  function hook(payload: unknown, env: Record<string, string> = {}): string {
    return execFileSync(process.execPath, [SCRIPT], {
      input: typeof payload === "string" ? payload : JSON.stringify(payload), encoding: "utf8", env: { ...process.env, ...env },
    });
  }

  test("answers a refused call with a deny decision and an allowed one with nothing", () => {
    const root = project();
    const denied = JSON.parse(hook({ ...bash("npm test"), cwd: root }, { CLAUDE_PROJECT_DIR: root })) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(denied.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(hook({ ...write(join(root, ".agent-state/45/plan.md")), cwd: root }, { CLAUDE_PROJECT_DIR: root })).toBe("");
  });

  test("fails closed on a payload it cannot read", () => {
    const out = JSON.parse(hook("not json")) as { hookSpecificOutput: { permissionDecision: string } };
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("the planner's definition binds the gate to every writing and shell tool", () => {
    const definition = readFileSync(PLANNER, "utf8");
    const frontmatter = definition.split("---")[1] ?? "";
    expect(frontmatter).toMatch(/^hooks:\n {2}PreToolUse:\n {4}- matcher: "Write\|Edit\|MultiEdit\|NotebookEdit\|Bash"\n/m);
    expect(frontmatter).toMatch(/command: .*scripts\/workflow\/planner-gate\.ts.*\|\| exit 2/);
  });
});
