import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readGuardLog } from "../../src/guard-log.ts";
import type { TempProject } from "../../test/support/temp-project.ts";
import { LOG, logLines, makeLeadProject, prepared } from "../../test/support/lead-project.ts";
import { runHook } from "./path-gate-hook.ts";
import { boundDefinitionInForce, leadCommand } from "./lead-hook.ts";
import { LAUNCHED_SEAT_ENV } from "./architect-launch.ts";
import { TICKET_MARKER_RELATIVE } from "../../src/ticket-worktree.ts";

// ADR 2026-048 on Claude Code: the project-wide hook (`--project-local`)
// makes the main session the read-only team lead, holds unbound children to
// the scout's read-only policy, and stands down only for a child whose
// generated definition carries its own bound hook.

const HARNESS = "/opt/harness";
const LEAD = ["--project-local", "--harness-root", HARNESS];

const projects: TempProject[] = [];
function project(files: Readonly<Record<string, string>> = {}): string {
  const p = makeLeadProject(files);
  projects.push(p);
  return p.dir;
}
beforeEach(() => {
  vi.stubEnv("CLAUDE_PROJECT_DIR", undefined);
  vi.stubEnv("BOUNDED_DEV_STAGE_ROLE", undefined);
  vi.stubEnv("BOUNDED_TICKET", undefined);
  vi.stubEnv("BOUNDED_GUARD_LOG", "");
  vi.stubEnv(LAUNCHED_SEAT_ENV, undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  while (projects.length) projects.pop()?.cleanup();
});

interface Outcome {
  readonly decision: "allow" | "deny" | "rewrite";
  readonly reason?: string;
  readonly input?: Readonly<Record<string, unknown>>;
}

function hook(dir: string, tool: string, input: Readonly<Record<string, unknown>>, flags: readonly string[] = LEAD,
  extra: Readonly<Record<string, unknown>> = {}): Outcome {
  const out = runHook(flags, JSON.stringify({ cwd: dir, hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, ...extra }), dir);
  if (out.stdout === "") return { decision: "allow" };
  const parsed = JSON.parse(out.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string; updatedInput?: Record<string, unknown> } };
  const o = parsed.hookSpecificOutput;
  return o.permissionDecision === "deny"
    ? { decision: "deny", reason: o.permissionDecisionReason ?? "" }
    : { decision: "rewrite", input: o.updatedInput ?? {} };
}

const q = (...words: string[]): string => words.map((w) => `'${w}'`).join(" ");

describe("lead Bash: only its commands, rewritten onto the project's harness", () => {
  const CLI = `${HARNESS}/scripts/bounded`;
  test.each([
    ["bounded gates --list", q(CLI, "gates", "--list")],
    ["bash .bounded/harness/scripts/bounded gates --list", q(CLI, "gates", "--list")],
    ["bounded lead status", q(CLI, "lead", "status")],
    ["bounded lead queue 4", q(CLI, "lead", "queue", "4")],
    ["bash .bounded/harness/scripts/bounded lead start 4", q(CLI, "lead", "start", "4")],
    ["bounded lead merge '#4'", q(CLI, "lead", "merge", "#4")],
    ["bounded lead reply 4 'use the shorter name'", q(CLI, "lead", "reply", "4", "use the shorter name")],
    ["bounded lead ticket create --title 'Invoices' --outcome 'Send invoices' --acceptance 'A sent invoice is listed' --owns contexts/billing/invoice.contract.ts --depends 3 --decisions 'Currency'",
      q(CLI, "lead", "ticket", "create", "--title", "Invoices", "--outcome", "Send invoices", "--acceptance", "A sent invoice is listed",
        "--owns", "contexts/billing/invoice.contract.ts", "--depends", "3", "--decisions", "Currency")],
  ])("%s", (command, rewritten) => {
    const r = hook(project(), "Bash", { command, description: "d" });
    expect(r).toEqual({ decision: "rewrite", input: { command: rewritten, description: "d" } });
  });

  test.each([
    ["bounded lead prepare", "usage: bounded lead"],
    ["bounded lead release", "usage: bounded lead"],
    ["bounded lead start", "usage: bounded lead start <issue>"],
    ["bounded lead start 1 2", "usage: bounded lead start <issue>"],
    ["bounded lead reply 4", "usage: bounded lead reply <issue> <message>"],
    ["bounded lead ticket create --title x --outcome y --acceptance z --decisions d", "at least one owned path"],
    ["bounded lead ticket create --title x --outcome y --acceptance z --owns ../up --decisions d", "plain project-relative path"],
  ])("a malformed lead command is refused with its reason: %s", (command, why) => {
    const r = hook(project(), "Bash", { command });
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain(why);
  });

  test.each(["npm test", "rm -rf src", "bounded gates --list; rm -rf src", "bounded gates red-gate", "git status", "bounded lead finish",
    "gh issue list",
    "bounded sync-config", "bash .bounded/harness/scripts/bounded sync-config"])(
    "anything else is refused: %s", (command) => {
      const dir = project();
      expect(hook(dir, "Bash", { command }).decision).toBe("deny");
      expect(readGuardLog(dir).at(-1)).toMatchObject({ guard: "team-lead", verdict: "block" });
    });

  test("before the first ticket the lead may re-plan with the user's own bounded init, unrewritten", () => {
    const dir = project();
    for (const command of [
      "bounded init",
      "bounded init --host claude-code --surface browser-ui --surface desktop --without network-api",
      `bounded init --host claude-code --surface browser-ui --apply ${"a".repeat(64)}`,
    ]) expect(hook(dir, "Bash", { command }), command).toEqual({ decision: "allow" });
    for (const command of [
      "bounded init --host claude-code --surface browser-ui --cwd /elsewhere",
      "bounded init --host pi --surface browser-ui",
      "bounded init --interactive",
      "bounded init --host claude-code --surface browser-ui | tail",
      "bounded init --host claude-code --apply abc",
    ]) {
      const r = hook(dir, "Bash", { command });
      expect(r.decision, command).toBe("deny");
      expect(r.reason, command).toMatch(/re-plan/);
    }
  });

  test("once a ticket is prepared, re-planning is refused", () => {
    const dir = project({ ".bounded/active-ticket": "1\n", [LOG]: logLines(prepared("1")) });
    const r = hook(dir, "Bash", { command: "bounded init --host claude-code --surface desktop" });
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("only before the first ticket");
  });

  test("leadCommand classifies without a project", () => {
    expect(leadCommand("bounded init --host claude-code --surface desktop").action.kind).toBe("replan");
    expect(leadCommand(42).action.kind).toBe("refused");
    expect(leadCommand("bounded setup").action.kind).toBe("refused");
    expect(leadCommand("npm run bounded:setup").action.kind).toBe("refused");
  });
});

describe("lead reads and lookups", () => {
  test("project reads pass; .git, outside paths, escaping patterns and writes do not", () => {
    const dir = project({ "src/a.ts": "" });
    expect(hook(dir, "Read", { file_path: join(dir, "src/a.ts") }).decision).toBe("allow");
    expect(hook(dir, "Glob", { pattern: "**/*.md", path: join(dir, "docs") }).decision).toBe("allow");
    expect(hook(dir, "WebSearch", { query: "x" }).decision).toBe("allow");
    expect(hook(dir, "Skill", { skill: "team-lead" }).decision).toBe("allow");
    expect(hook(dir, "Read", { file_path: join(dir, ".git/config") }).decision).toBe("deny");
    expect(hook(dir, "Read", { file_path: "/etc/hosts" }).decision).toBe("deny");
    expect(hook(dir, "Glob", { pattern: "../**" }).decision).toBe("deny");
    expect(hook(dir, "Grep", { pattern: "x", glob: "/etc/*" }).decision).toBe("deny");
    for (const pattern of [".gi?/config", "{.git,x}/**", ".[g]it/**", "**/.git*", "src/@(.git)/x"]) {
      expect(hook(dir, "Glob", { pattern, path: join(dir, "src") }).decision, pattern).toBe("deny");
      expect(hook(dir, "Grep", { pattern: "x", path: join(dir, "src"), glob: pattern }).decision, pattern).toBe("deny");
    }
    expect(hook(dir, "Write", { file_path: join(dir, "src/a.ts"), content: "" }).decision).toBe("deny");
    expect(hook(dir, "TodoWrite", { todos: [] }).decision).toBe("deny");
  });
});

describe("lead commissions", () => {
  test("a plain scout commission passes", () => {
    expect(hook(project(), "Agent", { subagent_type: "scout", prompt: "look" }).decision).toBe("allow");
  });

  test.each([
    [{ name: "s1" }], [{ resume: "a-1" }], [{ isolation: "worktree" }], [{ run_in_background: true }],
    [{ cwd: "/elsewhere" }], [{ team_name: "t" }], [{ mode: "bypassPermissions" }], [{ share: true }], [{ context: "fork" }],
  ])("a named, resumed, isolated or background commission is refused: %j", (extra) => {
    const r = hook(project(), "Agent", { subagent_type: "scout", prompt: "look", ...extra });
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("fresh, unnamed foreground");
  });

  test.each(["general-purpose", "builder", "Explore"])("only the scout: %s refused", (role) => {
    expect(hook(project(), "Task", { subagent_type: role, prompt: "do" }).decision).toBe("deny");
  });

  test("an architect is never commissioned in the lead's session, prepared run or not (ADR 2026-066)", () => {
    const dir = project({ ".bounded/active-ticket": "1\n", [LOG]: logLines(prepared("1")) });
    const r = hook(dir, "Agent", { subagent_type: "architect", prompt: "deliver" }, LEAD, { tool_use_id: "t1" });
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("bounded lead start <issue>");
  });
});

describe("a ticket worktree's own session (ADR 2026-066)", () => {
  const ticket = (): string => project({
    [TICKET_MARKER_RELATIVE]: JSON.stringify({ issue: 7, branch: "ticket/7", main: "/m" }),
    "docs/tn/README.md": "# TNs\n", ".bounded/active-ticket": "7\n", [LOG]: logLines(prepared("7")),
  });

  test("launched as the architect, the project-wide hook binds it, judges it, and allows in words what it allows", () => {
    const dir = ticket();
    vi.stubEnv(LAUNCHED_SEAT_ENV, "architect");
    vi.stubEnv("CLAUDE_PROJECT_DIR", dir);
    // The session grants nothing itself (dontAsk): an allowed call carries an explicit allow.
    expect(hook(dir, "Write", { file_path: join(dir, "docs/tn/TN-7.md"), content: "x" })).toEqual({ decision: "rewrite", input: {} });
    expect(hook(dir, "Write", { file_path: join(dir, "src/impl.ts"), content: "x" }).decision).toBe("deny");
    expect(hook(dir, "Bash", { command: "bounded lead status" }).decision).toBe("deny");
    expect(readGuardLog(dir).some((e) => e.guard === "host")).toBe(true);
  });

  // Regression (re-review): an empty verdict on a tool the gate never judged
  // was turned into an explicit allow.
  test.each([
    ["mcp__claude_ai_Gmail__send_message", { to: "x@example.invalid", body: "hi" }],
    ["mcp__any_server__any_tool", {}],
    ["WebFetch", { url: "https://example.invalid", prompt: "x" }],
    ["WebSearch", { query: "x" }],
    ["Skill", { skill: "developer-stage" }],
    ["TodoWrite", { todos: [] }],
    ["KillShell", { shell_id: "1" }],
    ["ExitPlanMode", { plan: "x" }],
    ["SomeFutureTool", {}],
  ])("a launched session denies a tool the gate does not judge: %s", (tool, input) => {
    const dir = ticket();
    vi.stubEnv(LAUNCHED_SEAT_ENV, "architect");
    vi.stubEnv("CLAUDE_PROJECT_DIR", dir);
    const r = hook(dir, tool, input);
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("not a tool the gate judges");
    // And a worker's own bound hook in that session does the same.
    const worker = hook(dir, tool, input, [...LEAD, "--role", "builder"], { agent_id: "a-3", agent_type: "builder" });
    expect(worker.decision).toBe("deny");
  });

  test("NotebookEdit is judged as an edit, not waved through", () => {
    const dir = ticket();
    vi.stubEnv(LAUNCHED_SEAT_ENV, "architect");
    vi.stubEnv("CLAUDE_PROJECT_DIR", dir);
    expect(hook(dir, "NotebookEdit", { notebook_path: join(dir, "src/x.ipynb"), new_source: "" }).decision).toBe("deny");
  });

  test("a worker the launched architect commissions is allowed in words by its own bound hook", () => {
    const dir = project({
      [TICKET_MARKER_RELATIVE]: JSON.stringify({ issue: 7, branch: "ticket/7", main: "/m", owns: ["contexts/billing/"] }),
      "docs/tn/README.md": "# TNs\n", ".bounded/active-ticket": "7\n", [LOG]: logLines(prepared("7")),
    });
    vi.stubEnv(LAUNCHED_SEAT_ENV, "architect");
    vi.stubEnv("CLAUDE_PROJECT_DIR", dir);
    const reviewerRead = hook(dir, "Read", { file_path: join(dir, "docs/tn/README.md") }, [...LEAD, "--role", "reviewer"], { agent_id: "a-2", agent_type: "reviewer" });
    expect(reviewerRead).toEqual({ decision: "rewrite", input: {} });
    expect(hook(dir, "Write", { file_path: join(dir, "x.md"), content: "" }, [...LEAD, "--role", "reviewer"], { agent_id: "a-2", agent_type: "reviewer" }).decision).toBe("deny");
  });

  test("outside a launched session an allowed call is left to the host's own permissions", () => {
    const dir = project({ "src/a.ts": "" });
    expect(hook(dir, "Read", { file_path: join(dir, "src/a.ts") })).toEqual({ decision: "allow" });
  });

  test("not launched, the worktree's top-level session is only read-only", () => {
    const dir = ticket();
    vi.stubEnv("CLAUDE_PROJECT_DIR", dir);
    expect(hook(dir, "Write", { file_path: join(dir, "docs/tn/TN-7.md"), content: "x" }).decision).toBe("deny");
    expect(hook(dir, "Bash", { command: "bounded lead status" }).decision).toBe("deny");
    expect(hook(dir, "Read", { file_path: join(dir, "docs/tn/README.md") }).decision).toBe("allow");
  });

  test("the launch's seat means nothing outside a marked ticket worktree, or for a child", () => {
    const main = project({ "src/a.ts": "" });
    vi.stubEnv(LAUNCHED_SEAT_ENV, "architect");
    vi.stubEnv("CLAUDE_PROJECT_DIR", main);
    expect(hook(main, "Write", { file_path: join(main, "docs/tn/TN-1.md"), content: "x" }).decision).toBe("deny");
    const dir = ticket();
    vi.stubEnv("CLAUDE_PROJECT_DIR", dir);
    expect(hook(dir, "Write", { file_path: join(dir, "docs/tn/TN-7.md"), content: "x" }, LEAD, { agent_id: "a-1", agent_type: "general-purpose" }).decision).toBe("deny");
  });
});


describe("children: stand down only for a proven bound definition", () => {
  const child = (agent_type: string): Readonly<Record<string, unknown>> => ({ agent_id: "a-1", agent_type });
  const definition = (role: string, hookLine = `node "x/bootstrap-hook.ts" --project-local --role ${role}`): string =>
    ["---", `name: ${role}`, "tools: Read", "hooks:", "  PreToolUse:", '    - matcher: ""', "      hooks:", "        - type: command",
      `          command: ${JSON.stringify(hookLine)}`, "---", "", "body"].join("\n");

  test("an unbound child (forked skill, built-in agent) is held read-only", () => {
    const dir = project({ "src/a.ts": "" });
    for (const type of ["general-purpose", "architect"]) {
      expect(hook(dir, "Write", { file_path: join(dir, "src/a.ts"), content: "" }, LEAD, child(type)).decision).toBe("deny");
      expect(hook(dir, "Bash", { command: "bounded gates --list" }, LEAD, child(type)).decision).toBe("deny");
      expect(hook(dir, "Read", { file_path: join(dir, "src/a.ts") }, LEAD, child(type)).decision).toBe("allow");
    }
    expect(readGuardLog(dir).some((e) => e.guard === "path-gate" && e.detail?.["role"] === "scout")).toBe(true);
  });

  test("a child whose definition carries its own bound hook is left to that hook", () => {
    const dir = project({ ".claude/agents/architect.md": definition("architect") });
    expect(boundDefinitionInForce(dir, "architect")).toBe(true);
    expect(hook(dir, "Write", { file_path: join(dir, "docs/tn/TN-1.md"), content: "" }, LEAD, child("architect")).decision).toBe("allow");
  });

  test("a definition without a matching bound hook, or a non-seat type, is not trusted", () => {
    const dir = project({ ".claude/agents/architect.md": definition("architect", "node x --role builder") });
    mkdirSync(join(dir, ".claude/agents"), { recursive: true });
    writeFileSync(join(dir, ".claude/agents/helper.md"), definition("helper"));
    expect(boundDefinitionInForce(dir, "architect")).toBe(false);
    expect(boundDefinitionInForce(dir, "helper")).toBe(false);
    expect(boundDefinitionInForce(dir, undefined)).toBe(false);
    expect(hook(dir, "Write", { file_path: join(dir, "a"), content: "" }, LEAD, child("architect")).decision).toBe("deny");
  });
});

describe("--role scout", () => {
  const SCOUT = [...LEAD, "--role", "scout"];
  test("reads inside the project only; no shell, writes, commissions or lookups", () => {
    const dir = project({ "src/a.ts": "" });
    expect(hook(dir, "Grep", { pattern: "x", path: join(dir, "src") }, SCOUT).decision).toBe("allow");
    expect(hook(dir, "Read", { file_path: join(dir, ".git/HEAD") }, SCOUT).decision).toBe("deny");
    expect(hook(dir, "Bash", { command: "cat src/a.ts" }, SCOUT).decision).toBe("deny");
    expect(hook(dir, "Bash", { command: "ls src && cat src/a.ts" }, SCOUT).decision).toBe("deny");
    expect(hook(dir, "Edit", { file_path: join(dir, "src/a.ts") }, SCOUT).decision).toBe("deny");
    expect(hook(dir, "Agent", { subagent_type: "scout", prompt: "x" }, SCOUT).decision).toBe("deny");
    expect(hook(dir, "WebFetch", { url: "https://example.invalid" }, SCOUT).decision).toBe("deny");
  });

  // #35: the scout lists names through Bash, because this host gives it no
  // Glob it can rely on; a listing outside the project or into .git is not.
  test("lists names through Bash inside the project, and nothing more", () => {
    const dir = project({ "src/a.ts": "" });
    expect(hook(dir, "Bash", { command: "ls" }, SCOUT).decision).toBe("allow");
    expect(hook(dir, "Bash", { command: "ls src" }, SCOUT).decision).toBe("allow");
    expect(hook(dir, "Bash", { command: "find src -name '*.ts'" }, SCOUT).decision).toBe("allow");
    expect(hook(dir, "Bash", { command: "ls .git" }, SCOUT).decision).toBe("deny");
    expect(hook(dir, "Bash", { command: "ls /etc" }, SCOUT).decision).toBe("deny");
    expect(hook(dir, "Bash", { command: "find src -name '*.ts' -exec cat {} +" }, SCOUT).decision).toBe("deny");
    expect(hook(dir, "Bash", { command: "find src -path '../*'" }, SCOUT).decision).toBe("deny");
  });

  test("a link cannot carry a listing into .git or out of the project", () => {
    const dir = project({ "src/a.ts": "" });
    symlinkSync(join(dir, ".git"), join(dir, "src/g"));
    symlinkSync("/etc", join(dir, "src/out"));
    for (const command of ["ls src/g", "find src/g -name '*'", "ls src/out", "find src/out/ -type f"]) {
      expect(hook(dir, "Bash", { command }, SCOUT).decision, command).toBe("deny");
      expect(hook(dir, "Bash", { command }, LEAD).decision, command).toBe("deny");
    }
  });

  test("the scout and the lead search contents through Bash, inside the project only", () => {
    const dir = project({ "src/a.ts": "needle\n" });
    symlinkSync("/etc", join(dir, "src/out"));
    for (const seat of [SCOUT, LEAD]) {
      expect(hook(dir, "Bash", { command: "grep -rn -e 'needle' src" }, seat).decision).toBe("allow");
      expect(hook(dir, "Bash", { command: "grep -n 'needle' src/a.ts" }, seat).decision).toBe("allow");
      expect(hook(dir, "Bash", { command: "grep -rn -e 'x' src/out" }, seat).decision).toBe("deny");
      expect(hook(dir, "Bash", { command: "grep -rn -e 'x' .git" }, seat).decision).toBe("deny");
      expect(hook(dir, "Bash", { command: "grep -rn -f src/a.ts src" }, seat).decision).toBe("deny");
      expect(hook(dir, "Bash", { command: "grep -rn --filter=sh -e x src" }, seat).decision).toBe("deny");
    }
  });

  test("the lead lists names through Bash the same way", () => {
    const dir = project({ "src/a.ts": "" });
    expect(hook(dir, "Bash", { command: "ls" }, LEAD).decision).toBe("allow");
    expect(hook(dir, "Bash", { command: "find src -name '*.ts'" }, LEAD).decision).toBe("allow");
    expect(hook(dir, "Bash", { command: "ls -R src" }, LEAD).decision).toBe("deny");
  });

  test("a bound scout hook never stands down for its own child payload", () => {
    const dir = project();
    expect(hook(dir, "Write", { file_path: join(dir, "a"), content: "" }, SCOUT, { agent_id: "a-1", agent_type: "scout" }).decision).toBe("deny");
  });
});
