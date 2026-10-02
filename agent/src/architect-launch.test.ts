import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  architectStatus, launchArchitectTurn, readArchitectState, runArchitectTurn, turnOutput, type ArchitectHost, type ArchitectTurnSpec,
} from "./architect-launch.ts";
import { readGuardLog } from "./guard-log.ts";
import { ARCHITECT_ENDED } from "./lead-state.ts";
import { CLAUDE_ARCHITECT_HOST, claudeGateProblem, LAUNCHED_SEAT_ENV } from "../hosts/claude-code/architect-launch.ts";
import { ARCHITECT_LOADER_RELATIVE, PI_ARCHITECT_HOST, piGateProblem } from "../hosts/pi/architect-launch.ts";
import type { ProcessProbe } from "./process-lock.ts";

/** A probe under the test's control: the listed pids run, each started at "t". */
const probe = (alive: () => boolean): ProcessProbe => ({ startTime: () => (alive() ? "t" : undefined) });

// One architect per ticket worktree, as its own host session (ADR 2026-066).

let worktree = "";
beforeEach(() => {
  worktree = mkdtempSync(join(tmpdir(), "bounded-architect-"));
  vi.stubEnv("BOUNDED_GUARD_LOG", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(worktree, { recursive: true, force: true });
});

/** A host whose turn runs a tiny node program, recording the spec it was given. */
function host(script = "process.stdout.write('report: done\\n')", problem?: string): ArchitectHost & { specs: ArchitectTurnSpec[] } {
  const specs: ArchitectTurnSpec[] = [];
  return {
    name: "test", specs, model: (p) => p, preflight: () => problem,
    command(spec) {
      specs.push(spec);
      return { command: process.execPath, args: ["-e", script], env: { MARK: "1" }, unset: ["UNWANTED"] };
    },
  };
}

describe("launching turns", () => {
  test("the first turn opens a session; a running turn locks the worktree; the next continues the same session", () => {
    const h = host();
    let alive = true;
    const spawn = vi.fn((_command: string, _args: readonly string[], _cwd: string) => 4242);
    const first = launchArchitectTurn(worktree, "brief", h, { spawn, probe: probe(() => alive), model: "opus" });
    expect(first).toMatchObject({ ok: true, turn: 1 });
    expect(h.specs[0]).toMatchObject({ worktree, message: "brief", resume: false, model: "opus" });
    expect(spawn.mock.calls[0]![1]).toEqual([expect.stringMatching(/architect-launch\.ts$/), worktree, "1"]);
    expect(architectStatus(worktree, probe(() => alive))).toMatchObject({ kind: "running", turn: 1 });
    const refused = launchArchitectTurn(worktree, "again", h, { spawn, probe: probe(() => alive) });
    expect(refused).toMatchObject({ ok: false, reason: expect.stringContaining("one architect runs per worktree") });
    alive = false;
    expect(architectStatus(worktree, probe(() => alive))).toEqual({ kind: "lost", turn: 1 });
    const second = launchArchitectTurn(worktree, "the user says yes", h, { spawn, probe: probe(() => alive) });
    expect(second).toMatchObject({ ok: true, turn: 2 });
    expect(h.specs[1]).toMatchObject({ resume: true, message: "the user says yes", sessionId: h.specs[0]!.sessionId });
  });

  test("a reused pid is not the architect: a different start time means the turn ended", () => {
    launchArchitectTurn(worktree, "brief", host(), { spawn: () => 4242, probe: { startTime: () => "t" } });
    expect(architectStatus(worktree, { startTime: () => "t" }).kind).toBe("running");
    expect(architectStatus(worktree, { startTime: () => "a later process" })).toEqual({ kind: "lost", turn: 1 });
  });

  test("a stale launch lock, whose owner has gone, is cleared; a live one is respected", () => {
    mkdirSync(join(worktree, ".bounded/architect"), { recursive: true });
    writeFileSync(join(worktree, ".bounded/architect/launch.lock"), JSON.stringify({ pid: 999_999, started: "long ago" }));
    expect(launchArchitectTurn(worktree, "brief", host(), { spawn: () => 4242, probe: { startTime: (pid) => (pid === 999_999 ? undefined : "t") } }).ok).toBe(true);
    writeFileSync(join(worktree, ".bounded/architect/launch.lock"), JSON.stringify({ pid: 999_998, started: "t" }));
    const held = launchArchitectTurn(worktree, "again", host(), { spawn: () => 4243, probe: { startTime: (pid) => (pid === 4242 ? undefined : "t") } });
    expect(held).toMatchObject({ ok: false, reason: expect.stringContaining("in progress (held by pid 999998)") });
  });

  test("a message that could be read as an option, or a worktree whose gate would not hold, launches nothing", () => {
    const spawn = vi.fn(() => 1);
    expect(launchArchitectTurn(worktree, "--dangerously-skip-permissions", host(), { spawn })).toMatchObject({ ok: false, reason: expect.stringContaining("may not begin with '-'") });
    expect(launchArchitectTurn(worktree, "brief", host(undefined, "no hook registered"), { spawn }))
      .toMatchObject({ ok: false, reason: expect.stringContaining("its gate would not hold: no hook registered") });
    expect(spawn).not.toHaveBeenCalled();
    expect(readArchitectState(worktree)).toBeUndefined();
  });

  test("a launch that cannot start leaves no turn recorded as running", () => {
    const spawn = vi.fn((): number => { throw new Error("no node"); });
    const out = launchArchitectTurn(worktree, "brief", host(), { spawn });
    expect(out).toMatchObject({ ok: false, reason: expect.stringContaining("no node") });
    expect(readArchitectState(worktree)).toMatchObject({ state: "ended", exitCode: 127 });
  });

  test("the wrapper runs the recorded turn, keeps its report, and records its end in the worktree's guard log", async () => {
    vi.stubEnv("UNWANTED", "leak");
    const h = host("process.stdout.write(`report ${process.env.MARK} ${process.env.UNWANTED ?? 'none'}\\n`); process.exit(3)");
    launchArchitectTurn(worktree, "brief", h, { spawn: () => process.pid, probe: { startTime: () => "t" } });
    expect(await runArchitectTurn(worktree, 1)).toBe(3);
    expect(turnOutput(worktree, 1)).toBe("report 1 none");
    expect(architectStatus(worktree)).toEqual({ kind: "ended", turn: 1, exitCode: 3 });
    expect(readGuardLog(worktree).at(-1)).toMatchObject({ guard: "team-lead", detail: { kind: ARCHITECT_ENDED, launch: "turn-1", exitCode: 3 } });
  });

  test("no state, no architect", () => {
    expect(architectStatus(worktree)).toEqual({ kind: "none" });
    expect(turnOutput(worktree, 1)).toBe("");
  });
});

describe("the hosts' commands", () => {
  const definition = (tools: string, body: string) => `---\nname: architect\ntools: ${tools}\n---\n\n${body}\n`;

  test("Claude Code: the worktree's own top-level session, its seat in the environment, the definition's strip and brief", () => {
    mkdirSync(join(worktree, ".claude", "agents"), { recursive: true });
    writeFileSync(join(worktree, ".claude", "agents", "architect.md"), definition("Read, Bash, Write, Edit, Agent, SendMessage", "## Brief"));
    const first = CLAUDE_ARCHITECT_HOST.command({ worktree, sessionId: "0000-1", message: "Ticket #4", resume: false, model: "opus" });
    expect(first.command).toBe("claude");
    // Only the project's settings load, nothing is pre-approved, and the
    // message follows `--`: the hook's explicit allow is the only way a call
    // that needs permission runs.
    expect(first.args).toEqual([
      "-p", "--session-id", "0000-1", "--setting-sources", "project", "--permission-mode", "dontAsk",
      "--append-system-prompt", "## Brief", "--tools", "Read,Bash,Write,Edit,Agent,SendMessage",
      "--model", "opus", "--strict-mcp-config", "--mcp-config", "{\"mcpServers\":{}}", "--output-format", "text", "--", "Ticket #4",
    ]);
    expect(first.args).not.toContain("--allowedTools");
    expect(first.args).not.toContain("acceptEdits");
    expect(first.env).toEqual({ [LAUNCHED_SEAT_ENV]: "architect" });
    expect(first.unset).toContain("CLAUDE_PROJECT_DIR");
    const next = CLAUDE_ARCHITECT_HOST.command({ worktree, sessionId: "0000-1", message: "yes", resume: true });
    expect(next.args.slice(0, 3)).toEqual(["-p", "--resume", "0000-1"]);
    expect(CLAUDE_ARCHITECT_HOST.model("anthropic/claude-opus-5:high")).toBe("opus");
    expect(CLAUDE_ARCHITECT_HOST.model("fireworks/kimi")).toBeUndefined();
  });

  test("pi: the worktree's own session, its project extensions trusted, the architect's loader passed explicitly", () => {
    mkdirSync(join(worktree, ".pi", "agents"), { recursive: true });
    writeFileSync(join(worktree, ".pi", "agents", "architect.md"), definition("read, write, subagent, design_gate", "You are the architect."));
    const cmd = PI_ARCHITECT_HOST.command({ worktree, sessionId: "s-1", message: "Ticket #4", resume: false, model: "anthropic/claude-opus-5:high" });
    expect(cmd.command).toBe("pi");
    expect(cmd.args).toEqual([
      "-p", "--approve", "--session-id", "s-1", "--extension", join(worktree, ARCHITECT_LOADER_RELATIVE),
      "--tools", "read,write,subagent,design_gate", "--append-system-prompt", join(worktree, ".bounded/architect/brief.md"),
      "--model", "anthropic/claude-opus-5:high", "--", "Ticket #4",
    ]);
    expect(readFileSync(join(worktree, ".bounded/architect/brief.md"), "utf8")).toBe("You are the architect.\n");
    expect(cmd.unset).toContain("PI_SUBAGENT_CHILD");
  });

  test("a definition without its strip refuses to launch", () => {
    mkdirSync(join(worktree, ".claude", "agents"), { recursive: true });
    writeFileSync(join(worktree, ".claude", "agents", "architect.md"), "---\nname: architect\n---\nbody\n");
    expect(() => CLAUDE_ARCHITECT_HOST.command({ worktree, sessionId: "x", message: "m", resume: false })).toThrow("names no tools");
  });
});

describe("preflight: the gate must hold before a launch", () => {
  const hookEntry = (command: string, matcher = "") => ({ matcher, hooks: [{ type: "command", command }] });
  const HOOK = 'node "${CLAUDE_PROJECT_DIR}/.bounded/harness/hosts/claude-code/bootstrap-hook.ts" --project-local';
  const claudeWorktree = (settings: unknown, managed?: unknown): string[] => {
    mkdirSync(join(worktree, ".claude", "agents"), { recursive: true });
    writeFileSync(join(worktree, ".claude", "agents", "architect.md"), "---\nname: architect\ntools: Read, Write\n---\nbrief\n");
    writeFileSync(join(worktree, ".claude", "settings.json"), typeof settings === "string" ? settings : JSON.stringify(settings));
    mkdirSync(join(worktree, ".bounded/harness/hosts/claude-code"), { recursive: true });
    writeFileSync(join(worktree, ".bounded/harness/hosts/claude-code/bootstrap-hook.ts"), "");
    if (managed === undefined) return [join(worktree, "no-managed.json")];
    writeFileSync(join(worktree, "managed.json"), JSON.stringify(managed));
    return [join(worktree, "managed.json")];
  };

  test("Claude Code: the project-wide hook registered for every tool, nothing switching hooks off", () => {
    expect(claudeGateProblem(worktree, claudeWorktree({ hooks: { PreToolUse: [hookEntry(HOOK)] } }))).toBeUndefined();
    expect(claudeGateProblem(worktree, claudeWorktree("not json"))).toContain("missing or not JSON");
    expect(claudeGateProblem(worktree, claudeWorktree({ hooks: {} }))).toContain("register no project-wide PreToolUse hook");
    expect(claudeGateProblem(worktree, claudeWorktree({ hooks: { PreToolUse: [hookEntry(HOOK, "Write")] } }))).toContain("register no project-wide");
    expect(claudeGateProblem(worktree, claudeWorktree({ hooks: { PreToolUse: [hookEntry("echo ok")] } }))).toContain("register no project-wide");
    expect(claudeGateProblem(worktree, claudeWorktree({ disableAllHooks: true, hooks: { PreToolUse: [hookEntry(HOOK)] } }))).toContain("switch hooks off");
    expect(claudeGateProblem(worktree, claudeWorktree({ hooks: { PreToolUse: [hookEntry(HOOK)] } }, { disableAllHooks: true }))).toContain("managed settings");
    expect(claudeGateProblem(worktree, claudeWorktree({ hooks: { PreToolUse: [hookEntry(HOOK)] } }, { allowManagedHooksOnly: true }))).toContain("managed settings");
    rmSync(join(worktree, ".bounded/harness/hosts/claude-code/bootstrap-hook.ts"));
    expect(claudeGateProblem(worktree, [])).toContain("missing from the worktree's harness");
  });

  test("pi: the architect's loader, the project extension and the definition", () => {
    expect(piGateProblem(worktree)).toContain("loader");
    mkdirSync(join(worktree, ".bounded/harness/hosts/pi/extensions/path-gate"), { recursive: true });
    writeFileSync(join(worktree, ARCHITECT_LOADER_RELATIVE), "");
    expect(piGateProblem(worktree)).toContain("project extension");
    mkdirSync(join(worktree, ".pi/extensions/bounded"), { recursive: true });
    writeFileSync(join(worktree, ".pi/extensions/bounded/index.ts"), "");
    mkdirSync(join(worktree, ".pi/agents"), { recursive: true });
    writeFileSync(join(worktree, ".pi/agents/architect.md"), "---\nname: architect\ntools: read\n---\nbrief\n");
    expect(piGateProblem(worktree)).toBeUndefined();
  });
});
