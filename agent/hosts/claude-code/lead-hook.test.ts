import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readGuardLog } from "../../src/guard-log.ts";
import type { TempProject } from "../../test/support/temp-project.ts";
import { LOG, logLines, makeLeadProject, prepared } from "../../test/support/lead-project.ts";
import { runHook } from "./path-gate-hook.ts";
import { boundDefinitionInForce, leadCommand } from "./lead-hook.ts";
import {
  readArchitectState, readPendingLaunch, readPendingReply, recordArchitectEnded, recordArchitectRunning, writePendingLaunch, writePendingReply,
} from "../../src/architect-seat.ts";
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

describe("the architect seat in a ticket worktree (ADR 2026-066)", () => {
  const AGENT = "a00000000000000a7";
  /** A main worktree with one ticket worktree under it, as `bounded lead start` leaves them. */
  const ticketed = (owns: readonly string[] = []): { main: string; wt: string } => {
    const main = project({ "src/a.ts": "" });
    const wt = join(main, ".bounded/worktrees/7");
    for (const [rel, text] of Object.entries({
      [TICKET_MARKER_RELATIVE]: JSON.stringify({ issue: 7, branch: "ticket/7", main, owns }),
      ".bounded/installation.json": "{}\n", ".bounded/harness/.keep": "", ".bounded/composed-packs.json": "[\"ts\"]\n", "docs/tn/README.md": "# TNs\n",
      ".bounded/active-ticket": "7\n", [LOG]: logLines(prepared("7")),
    })) {
      mkdirSync(join(wt, rel, ".."), { recursive: true });
      writeFileSync(join(wt, rel), text);
    }
    vi.stubEnv("CLAUDE_PROJECT_DIR", main);
    return { main, wt };
  };
  const ARCHITECT = [...LEAD, "--role", "architect"];
  const child = (role: string) => ({ agent_id: AGENT, agent_type: role });
  const at = (wt: string, tool: string, input: Readonly<Record<string, unknown>>, flags = ARCHITECT, role = "architect") =>
    runHook(flags, JSON.stringify({ cwd: wt, hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, ...child(role) }), wt);
  const verdict = (out: { stdout: string }): string =>
    out.stdout === "" ? "none" : (JSON.parse(out.stdout) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision;

  test("its calls are judged against the ticket worktree and allowed in words; a write outside is refused", () => {
    const { main, wt } = ticketed();
    expect(verdict(at(wt, "Write", { file_path: join(wt, "docs/tn/TN-7.md"), content: "x" }))).toBe("allow");
    expect(verdict(at(wt, "Write", { file_path: join(main, "src/a.ts"), content: "x" }))).toBe("deny");
    expect(verdict(at(wt, "Write", { file_path: "/tmp/elsewhere.md", content: "x" }))).toBe("deny");
    expect(readGuardLog(wt).some((e) => e.guard === "host")).toBe(true);
    expect(readGuardLog(main).some((e) => e.guard === "host")).toBe(false);
  });

  test("a worker it commissions is allowed in words by its own bound hook, in the same worktree", () => {
    const { wt } = ticketed();
    expect(verdict(at(wt, "Read", { file_path: join(wt, "docs/tn/README.md") }, [...LEAD, "--role", "reviewer"], "reviewer"))).toBe("allow");
    expect(verdict(at(wt, "Write", { file_path: join(wt, "x.md"), content: "" }, [...LEAD, "--role", "reviewer"], "reviewer"))).toBe("deny");
  });

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
  ])("a tool the gate does not judge is denied to the architect and to its workers: %s", (tool, input) => {
    const { wt } = ticketed();
    const out = at(wt, tool, input);
    expect(verdict(out)).toBe("deny");
    expect(out.stdout).toContain("not a tool the gate judges");
    expect(verdict(at(wt, tool, input, [...LEAD, "--role", "builder"], "builder"))).toBe("deny");
  });

  // Regression (#47 planning): a worker's report and loading a deferred tool
  // are a seat's plumbing, judged as such and allowed, never denied as unknown.
  test.each([
    ["SubagentHandback", { message: "report" }],
    ["ToolSearch", { query: "select:SendMessage", max_results: 1 }],
  ])("%s is allowed in words to the architect and to its workers", (tool, input) => {
    const { wt } = ticketed();
    expect(verdict(at(wt, tool, input))).toBe("allow");
    for (const role of ["reviewer", "test-writer", "builder"]) {
      expect(verdict(at(wt, tool, input, [...LEAD, "--role", role], role)), role).toBe("allow");
    }
  });

  test("NotebookEdit is judged as an edit, not waved through", () => {
    const { wt } = ticketed();
    expect(verdict(at(wt, "NotebookEdit", { notebook_path: join(wt, "src/x.ipynb"), new_source: "" }))).toBe("deny");
  });

  test("outside a ticket worktree an allowed call is left to the host's own permissions", () => {
    const dir = project({ "src/a.ts": "" });
    expect(hook(dir, "Read", { file_path: join(dir, "src/a.ts") })).toEqual({ decision: "allow" });
  });

  test("a top-level session in a ticket worktree is only read-only", () => {
    const { wt } = ticketed();
    vi.stubEnv("CLAUDE_PROJECT_DIR", wt);
    expect(hook(wt, "Write", { file_path: join(wt, "docs/tn/TN-7.md"), content: "x" }).decision).toBe("deny");
    expect(hook(wt, "Bash", { command: "bounded lead status" }).decision).toBe("deny");
    expect(hook(wt, "Read", { file_path: join(wt, "docs/tn/README.md") }).decision).toBe("allow");
  });
});

describe("the lead's architect launch and reply (ADR 2026-066)", () => {
  const BRIEF = "Ticket #7: Invoices";
  const pendingAt = (main: string, wt: string): void => writePendingLaunch(main, { issue: 7, worktree: wt, brief: BRIEF, model: "opus", createdAt: "t" });
  const setup = () => {
    const main = project();
    const wt = join(main, ".bounded/worktrees/7");
    mkdirSync(join(wt, ".bounded"), { recursive: true });
    writeFileSync(join(wt, TICKET_MARKER_RELATIVE), JSON.stringify({ issue: 7, branch: "ticket/7", main, owns: [] }));
    vi.stubEnv("CLAUDE_PROJECT_DIR", main);
    return { main, wt };
  };
  const event = (main: string, name: string, fields: Readonly<Record<string, unknown>>) =>
    runHook(LEAD, JSON.stringify({ cwd: main, hook_event_name: name, ...fields }), main);

  test("an architect launch needs a pending ticket; it is rewritten to exactly that ticket's brief, in a background worktree", () => {
    const { main, wt } = setup();
    expect(hook(main, "Agent", { subagent_type: "architect", prompt: "go" }, LEAD, { tool_use_id: "t1" }).reason).toContain("run bounded lead start <issue> first");
    pendingAt(main, wt);
    expect(hook(main, "Agent", { subagent_type: "architect", prompt: "go", cwd: "/elsewhere" }, LEAD, { tool_use_id: "t1" }).reason).toContain("'cwd' is not allowed");
    const launch = hook(main, "Agent", { subagent_type: "architect", prompt: "go", run_in_background: false }, LEAD, { tool_use_id: "t1" });
    expect(launch).toEqual({ decision: "rewrite", input: {
      subagent_type: "architect", description: "Architect for ticket #7", prompt: BRIEF, isolation: "worktree", run_in_background: true, model: "opus",
    } });
    expect(hook(main, "Agent", { subagent_type: "architect", prompt: "again" }, LEAD, { tool_use_id: "t2" }).reason).toContain("already under way");
  });

  test("WorktreeCreate binds the launched agent to the ticket's existing worktree; nothing else gets a worktree", () => {
    const { main, wt } = setup();
    expect(event(main, "WorktreeCreate", { name: "agent-a1234567890abcdef" })).toMatchObject({ stdout: "", exit: 1 });
    pendingAt(main, wt);
    hook(main, "Agent", { subagent_type: "architect", prompt: "go" }, LEAD, { tool_use_id: "t1" });
    expect(event(main, "WorktreeCreate", { name: "feature-x" })).toMatchObject({ exit: 1 });
    expect(event(main, "WorktreeCreate", { name: "agent-a1234567890abcdef" })).toEqual({ stdout: `${wt}\n`, stderr: "", exit: 0 });
    expect(readArchitectState(wt)).toMatchObject({ agent: "a1234567890abcdef", state: "running", turn: 1 });
    expect(readPendingLaunch(main)).toBeUndefined();
    // Only that agent's stop ends the seat.
    runHook(LEAD, JSON.stringify({ cwd: wt, hook_event_name: "SubagentStop", agent_id: "a9999999999999999", agent_type: "builder" }), wt);
    expect(readArchitectState(wt)?.state).toBe("running");
    runHook(LEAD, JSON.stringify({ cwd: wt, hook_event_name: "SubagentStop", agent_id: "a1234567890abcdef", agent_type: "architect" }), wt);
    expect(readArchitectState(wt)?.state).toBe("ended");
  });

  test("a launch that failed releases its claim", () => {
    const { main, wt } = setup();
    pendingAt(main, wt);
    hook(main, "Agent", { subagent_type: "architect", prompt: "go" }, LEAD, { tool_use_id: "t1" });
    event(main, "PostToolUseFailure", { tool_name: "Agent", tool_use_id: "t1", tool_input: { subagent_type: "architect" } });
    expect(readPendingLaunch(main)?.claimedBy).toBeUndefined();
    expect(hook(main, "Agent", { subagent_type: "architect", prompt: "go" }, LEAD, { tool_use_id: "t3" }).decision).toBe("rewrite");
  });

  test("SendMessage continues only the architect a reply was prepared for, carrying exactly that reply", () => {
    const { main, wt } = setup();
    const agent = "a1234567890abcdef";
    expect(hook(main, "SendMessage", { to: agent, message: "yes" }).reason).toContain("no reply is waiting");
    writeArchitectEnded(wt, agent);
    writePendingReply(main, { issue: 7, worktree: wt, agent, message: "Euros.", createdAt: "t" });
    expect(hook(main, "SendMessage", { to: "a9999999999999999", message: "Euros." }).reason).toContain("not a9999999999999999");
    expect(hook(main, "SendMessage", { to: agent, message: "anything" })).toEqual({ decision: "rewrite", input: { to: agent, message: "Euros." } });
    expect(readArchitectState(wt)).toMatchObject({ state: "running", turn: 2 });
    expect(readPendingReply(main)).toBeUndefined();
    // A continuation that did not go through ends the turn again.
    event(main, "PostToolUse", { tool_name: "SendMessage", tool_input: { to: agent, message: "Euros." }, tool_response: { success: false } });
    expect(readArchitectState(wt)?.state).toBe("ended");
  });
});

function writeArchitectEnded(wt: string, agent: string): void {
  recordArchitectRunning(wt, agent, { pid: process.pid, pidStarted: "t" });
  recordArchitectEnded(wt, agent);
}

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
