import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  architectStatus, claimPendingLaunch, flagLike, readArchitectState, readPendingLaunch, recordArchitectEnded, recordArchitectRunning,
  writePendingLaunch,
} from "./architect-seat.ts";
import { readGuardLog } from "./guard-log.ts";
import { ARCHITECT_ENDED } from "./lead-state.ts";
import type { ProcessProbe } from "./process-lock.ts";
import { CLAUDE_ARCHITECT_HOST, claudeGateProblem } from "../hosts/claude-code/architect-seat.ts";
import { ARCHITECT_LOADER_RELATIVE, PI_ARCHITECT_HOST, piGateProblem } from "../hosts/pi/architect-seat.ts";

// The architect seat is the host's own subagent (ADR 2026-066): the core
// keeps the pending launch and the seat's life; the adapters bind and record.

let main = "";
let wt = "";
beforeEach(() => {
  main = mkdtempSync(join(tmpdir(), "bounded-seat-"));
  wt = join(main, ".bounded/worktrees/7");
  mkdirSync(join(wt, ".bounded"), { recursive: true });
  writeFileSync(join(wt, ".bounded/ticket-worktree.json"), JSON.stringify({ issue: 7, branch: "ticket/7", main, owns: [] }));
  vi.stubEnv("BOUNDED_GUARD_LOG", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(main, { recursive: true, force: true });
});

const live: ProcessProbe = { startTime: () => "t" };
const dead: ProcessProbe = { startTime: () => undefined };

describe("the pending launch", () => {
  test("one launch call claims it; another is refused; with none pending, nothing launches", () => {
    expect(claimPendingLaunch(main, "t1")).toEqual({ error: expect.stringContaining("run bounded lead start <issue> first") });
    writePendingLaunch(main, { issue: 7, worktree: wt, brief: "b", createdAt: "t" });
    expect(claimPendingLaunch(main, "t1")).toMatchObject({ issue: 7, claimedBy: "t1" });
    expect(claimPendingLaunch(main, "t1")).toMatchObject({ claimedBy: "t1" });
    expect(claimPendingLaunch(main, "t2")).toEqual({ error: expect.stringContaining("already under way") });
    expect(readPendingLaunch(main)?.claimedBy).toBe("t1");
  });
});

describe("the seat's life", () => {
  test("running, then ended by its own agent only; each continuation is a new turn", () => {
    expect(architectStatus(wt, live)).toEqual({ kind: "none" });
    recordArchitectRunning(wt, "a1", { pid: 10, pidStarted: "t" });
    expect(architectStatus(wt, live)).toMatchObject({ kind: "running", turn: 1, agent: "a1" });
    expect(recordArchitectEnded(wt, "a2")).toBe(false);
    expect(recordArchitectEnded(wt, "a1")).toBe(true);
    expect(architectStatus(wt, live)).toEqual({ kind: "ended", turn: 1, agent: "a1" });
    expect(readGuardLog(wt).at(-1)).toMatchObject({ detail: { kind: ARCHITECT_ENDED, agent: "a1" } });
    recordArchitectRunning(wt, "a1", { pid: 10, pidStarted: "t" });
    expect(readArchitectState(wt)).toMatchObject({ turn: 2, state: "running" });
  });

  test("a seat whose host session is gone is lost, never running", () => {
    recordArchitectRunning(wt, "a1", { pid: 10, pidStarted: "t" });
    expect(architectStatus(wt, dead)).toEqual({ kind: "lost", turn: 1, agent: "a1" });
    expect(architectStatus(wt, { startTime: () => "a later process" }).kind).toBe("lost");
    expect(architectStatus(wt, { startTime: () => null }).kind).toBe("running");
  });

  test("a message that reads as an option", () => {
    expect(flagLike("--dangerously-skip-permissions")).toBe(true);
    expect(flagLike("  -p")).toBe(true);
    expect(flagLike("Euros, please")).toBe(false);
  });
});

describe("the hosts' instructions and preflights", () => {
  test("Claude Code: launch and reply instructions name the seat's own tools", () => {
    expect(CLAUDE_ARCHITECT_HOST.launchInstruction({ issue: 7, worktree: wt, brief: "b", createdAt: "t" }))
      .toContain('subagent_type "architect", isolation "worktree" and run_in_background true');
    expect(CLAUDE_ARCHITECT_HOST.replyInstruction({ issue: 7, worktree: wt, agent: "a1", message: "m", createdAt: "t" }))
      .toContain('SendMessage with to "a1"');
  });

  test("Claude Code: the lead's settings run the project hook on every seat event, and every role runs in dontAsk", () => {
    const hook = 'node "${CLAUDE_PROJECT_DIR}/.bounded/harness/hosts/claude-code/bootstrap-hook.ts" --project-local';
    const entry = [{ matcher: "", hooks: [{ type: "command", command: hook }] }];
    const settings = (events: string[]) => writeFileSync(join(main, ".claude/settings.json"),
      JSON.stringify({ hooks: Object.fromEntries(events.map((e) => [e, entry])) }));
    const definition = (role: string, mode = "permissionMode: dontAsk\n") => writeFileSync(join(main, `.claude/agents/${role}.md`),
      `---\nname: ${role}\ntools: Read\n${mode}hooks:\n  PreToolUse:\n    - command: "${hook} --role ${role}"\n---\nbody\n`);
    mkdirSync(join(main, ".claude/agents"), { recursive: true });
    mkdirSync(join(wt, ".bounded/harness/hosts/claude-code"), { recursive: true });
    writeFileSync(join(wt, ".bounded/harness/hosts/claude-code/bootstrap-hook.ts"), "");
    for (const role of ["architect", "reviewer", "test-writer", "builder"]) definition(role);
    settings(["PreToolUse", "WorktreeCreate", "SubagentStop"]);
    expect(claudeGateProblem(wt, [])).toBeUndefined();
    settings(["PreToolUse", "WorktreeCreate"]);
    expect(claudeGateProblem(wt, [])).toContain("on SubagentStop");
    settings(["PreToolUse", "WorktreeCreate", "SubagentStop"]);
    definition("builder", "");
    expect(claudeGateProblem(wt, [])).toContain("builder definition does not run in dontAsk");
    definition("builder");
    writeFileSync(join(main, "managed.json"), JSON.stringify({ disableAllHooks: true }));
    expect(claudeGateProblem(wt, [join(main, "managed.json")])).toContain("switch project hooks off");
  });

  test("pi: the worktree's definition loads the worktree's own architect loader, resolved as pi-subagents resolves it", () => {
    expect(PI_ARCHITECT_HOST.launchInstruction({ issue: 7, worktree: wt, brief: "b", createdAt: "t" })).toContain(`async true and cwd "${wt}"`);
    expect(piGateProblem(wt)).toContain("loader");
    mkdirSync(join(wt, ".bounded/harness/hosts/pi/extensions/path-gate"), { recursive: true });
    writeFileSync(join(wt, ARCHITECT_LOADER_RELATIVE), "");
    mkdirSync(join(wt, ".pi/extensions/bounded"), { recursive: true });
    writeFileSync(join(wt, ".pi/extensions/bounded/index.ts"), "");
    mkdirSync(join(wt, ".pi/agents"), { recursive: true });
    const definition = (loader: string) => writeFileSync(join(wt, ".pi/agents/architect.md"), `---\nname: architect\nsubagentOnlyExtensions: ${loader}\n---\nbody\n`);
    definition("./.bounded/harness/hosts/pi/extensions/path-gate/architect.ts");
    expect(piGateProblem(wt)).toContain("is not the worktree's own architect loader");
    definition("../../.bounded/harness/hosts/pi/extensions/path-gate/architect.ts");
    expect(piGateProblem(wt)).toBeUndefined();
  });
});
