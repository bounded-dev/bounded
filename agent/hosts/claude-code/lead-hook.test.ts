import { spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readGuardLog } from "../../src/guard-log.ts";
import type { TempProject } from "../../test/support/temp-project.ts";
import { LOG, logLines, makeLeadProject, prepared } from "../../test/support/lead-project.ts";
import { runHook } from "./path-gate-hook.ts";
import { boundDefinitionInForce, leadCommand } from "./lead-hook.ts";

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

describe("lead Bash: only run control, rewritten onto the project's harness", () => {
  test.each([
    ["bounded gates --list", q(`${HARNESS}/scripts/bounded`, "gates", "--list")],
    ["bash .bounded/harness/scripts/bounded gates --list", q(`${HARNESS}/scripts/bounded`, "gates", "--list")],
    ["bounded lead prepare", q(`${HARNESS}/scripts/bounded`, "lead", "prepare")],
    ["bash .bounded/harness/scripts/bounded lead prepare --new 4", q(`${HARNESS}/scripts/bounded`, "lead", "prepare", "--new", "4")],
  ])("%s", (command, rewritten) => {
    const r = hook(project(), "Bash", { command, description: "d" });
    expect(r).toEqual({ decision: "rewrite", input: { command: rewritten, description: "d" } });
  });

  test.each(["bounded lead prepare 1 2", "bounded lead prepare --new x", "bounded lead prepare --force"])(
    "bad prepare arguments are refused with the usage: %s", (command) => {
      const r = hook(project(), "Bash", { command });
      expect(r.decision).toBe("deny");
      expect(r.reason).toContain("usage: bounded lead prepare [--new] [ticket-number]");
    });

  test.each(["npm test", "rm -rf src", "bounded gates --list; rm -rf src", "bounded gates red-gate", "git status", "bounded lead finish",
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

  test.each(["general-purpose", "builder", "Explore"])("only scout and architect: %s refused", (role) => {
    expect(hook(project(), "Task", { subagent_type: role, prompt: "do" }).decision).toBe("deny");
  });

  test("the architect waits for a prepared run, then gets its tier", () => {
    const dir = project({ ".bounded/dev-stage-models.json": '{"designModel": "anthropic/claude-opus-5:high"}\n' });
    expect(hook(dir, "Agent", { subagent_type: "architect", prompt: "deliver" }).reason).toContain("prepare the ticket's run boundary");
    writeFileSync(join(dir, ".bounded/active-ticket"), "1\n");
    writeFileSync(join(dir, LOG), logLines(prepared("1")));
    const r = hook(dir, "Agent", { subagent_type: "architect", prompt: "deliver", model: "haiku" }, LEAD, { tool_use_id: "t1" });
    expect(r).toEqual({ decision: "rewrite", input: { subagent_type: "architect", prompt: "deliver", model: "opus" } });
    expect(readGuardLog(dir).find((e) => e.guard === "model-tier")).toMatchObject({ verdict: "pass", detail: { role: "team-lead" } });
  });

  test("one architect at a time: a second waits until the first's end is recorded", () => {
    const dir = project({ ".bounded/active-ticket": "1\n", [LOG]: logLines(prepared("1")) });
    const launch = (id: string) => hook(dir, "Agent", { subagent_type: "architect", prompt: "deliver" }, LEAD, { tool_use_id: id });
    const after = (event: string, id: string, extra: Readonly<Record<string, unknown>> = {}) =>
      runHook(LEAD, JSON.stringify({ cwd: dir, hook_event_name: event, tool_name: "Agent", tool_use_id: id,
        tool_input: { subagent_type: "architect", prompt: "deliver" }, ...extra }), dir);
    expect(launch("t1").decision).toBe("allow");
    expect(launch("t2").reason).toContain("an architect is already running");
    // A background launch is still running.
    after("PostToolUse", "t1", { tool_response: { status: "async_launched", agentId: "a0000000000000aaa" } });
    expect(launch("t2").decision).toBe("deny");
    after("PostToolUse", "t1", { tool_response: { status: "completed", agentId: "a0000000000000aaa", agentType: "architect" } });
    expect(launch("t2").decision).toBe("allow");
    // An interrupted or failed architect has ended too.
    after("PostToolUseFailure", "t2", { error: "interrupted", is_interrupt: true });
    expect(launch("t3").decision).toBe("allow");
    // A child's Agent calls never end the lead's architect.
    runHook(LEAD, JSON.stringify({ cwd: dir, hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: "t3",
      agent_id: "a0000000000000aaa", agent_type: "architect", tool_input: { subagent_type: "architect" }, tool_response: { status: "completed" } }), dir);
    expect(launch("t4").decision).toBe("deny");
  });

  test("an architect commission with no call id is refused: its end could never be recorded", () => {
    const dir = project({ ".bounded/active-ticket": "1\n", [LOG]: logLines(prepared("1")) });
    expect(hook(dir, "Agent", { subagent_type: "architect", prompt: "deliver" }).reason).toContain("no call id");
  });

  test("only the user releases a stuck architect: the lead may not run the release", () => {
    const dir = project({ ".bounded/active-ticket": "1\n", [LOG]: logLines(prepared("1")) });
    expect(hook(dir, "Agent", { subagent_type: "architect", prompt: "deliver" }, LEAD, { tool_use_id: "t1" }).decision).toBe("allow");
    expect(hook(dir, "Bash", { command: "bounded lead release" }).decision).toBe("deny");
    expect(hook(dir, "Bash", { command: "bash .bounded/harness/scripts/bounded lead release" }).decision).toBe("deny");
    const cli = spawnSync(process.execPath, [fileURLToPath(new URL("../../src/lead-cli.ts", import.meta.url)), "release"], { cwd: dir, encoding: "utf8", env: { ...process.env, BOUNDED_GUARD_LOG: "" } });
    expect(cli.stdout).toContain("released");
    expect(hook(dir, "Agent", { subagent_type: "architect", prompt: "deliver" }, LEAD, { tool_use_id: "t2" }).decision).toBe("allow");
  });

  test("a tier this host cannot run refuses the architect; no tier leaves the call untouched", () => {
    const dir = project({
      ".bounded/dev-stage-models.json": '{"designModel": "fireworks/kimi-k3:medium"}\n',
      ".bounded/active-ticket": "1\n", [LOG]: logLines(prepared("1")),
    });
    expect(hook(dir, "Agent", { subagent_type: "architect", prompt: "deliver" }, LEAD, { tool_use_id: "t1" }).reason).toContain("names no model this host can run");
    const plain = project({ ".bounded/active-ticket": "1\n", [LOG]: logLines(prepared("1")) });
    expect(hook(plain, "Agent", { subagent_type: "architect", prompt: "deliver" }, LEAD, { tool_use_id: "t1" }).decision).toBe("allow");
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
