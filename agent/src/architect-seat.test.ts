import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  architectStatus, claimPendingLaunch, claimStale, flagLike, LAUNCH_CLAIM_MAX_AGE_MS, pendingReplyFor, readArchitectState,
  readPendingLaunch, recordArchitectEnded, recordArchitectRunning, releaseLaunchClaim, seatContinuable, writePendingLaunch,
  writePendingReply, clearArchitectState, seatNeedsRelaunch, UNRECOGNISED_SEAT_MAX_AGE_MS,
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
    const me = { pid: 10, pidStarted: "t" };
    expect(claimPendingLaunch(main, "t1", me, { probe: live })).toEqual({ error: expect.stringContaining("run bounded lead start <issue> first") });
    writePendingLaunch(main, { issue: 7, worktree: wt, brief: "b", createdAt: "t" });
    expect(claimPendingLaunch(main, "t1", me, { probe: live })).toMatchObject({ issue: 7, claimedBy: "t1", claimant: me });
    expect(claimPendingLaunch(main, "t1", me, { probe: live })).toMatchObject({ claimedBy: "t1" });
    expect(claimPendingLaunch(main, "t2", me, { probe: live })).toEqual({ error: expect.stringContaining("already under way") });
    expect(readPendingLaunch(main)?.claimedBy).toBe("t1");
  });

  // Regression (final review M2): a claim that never bound wedged the board.
  test("a claim whose claimant has gone, or that is older than the limit, is stale and is taken over", () => {
    const me = { pid: 10, pidStarted: "t" };
    writePendingLaunch(main, { issue: 7, worktree: wt, brief: "b", createdAt: "t" });
    claimPendingLaunch(main, "t1", me, { probe: live });
    expect(claimStale(readPendingLaunch(main)!, live)).toBe(false);
    expect(claimStale(readPendingLaunch(main)!, dead)).toBe(true);
    expect(claimStale(readPendingLaunch(main)!, live, Date.now() + LAUNCH_CLAIM_MAX_AGE_MS + 1)).toBe(true);
    expect(claimPendingLaunch(main, "t2", me, { probe: dead })).toMatchObject({ claimedBy: "t2" });
    releaseLaunchClaim(main);
    expect(readPendingLaunch(main)).toMatchObject({ issue: 7 });
    expect(readPendingLaunch(main)?.claimedBy).toBeUndefined();
  });

  // Regression (final review M1).
  test("each ticket keeps its own pending reply; only a stopped seat whose session still runs is continuable", () => {
    writePendingReply(main, { issue: 7, worktree: wt, agent: "a1", message: "m7", createdAt: "t" });
    writePendingReply(main, { issue: 8, worktree: join(main, "w8"), agent: "a2", message: "m8", createdAt: "t" });
    expect(pendingReplyFor(main, "a1")?.message).toBe("m7");
    expect(pendingReplyFor(main, "a2")?.message).toBe("m8");
    recordArchitectRunning(wt, "a1", { pid: 10, pidStarted: "t", sessionBound: true });
    expect(seatContinuable(wt, "a1", live)).toBe(false);
    // Regression (U1): a lost seat cannot be continued from another session.
    expect(seatContinuable(wt, "a1", dead)).toBe(false);
    recordArchitectEnded(wt, "a1");
    expect(seatContinuable(wt, "a1", live)).toBe(true);
    expect(seatContinuable(wt, "a1", dead)).toBe(false);
    expect(seatContinuable(wt, "a2", live)).toBe(false);
  });
});

describe("the seat's life", () => {
  test("running, then ended by its own agent only; each continuation is a new turn", () => {
    expect(architectStatus(wt, live)).toEqual({ kind: "none" });
    recordArchitectRunning(wt, "a1", { pid: 10, pidStarted: "t" });
    expect(architectStatus(wt, live)).toMatchObject({ kind: "running", turn: 1, agent: "a1" });
    expect(recordArchitectEnded(wt, "a2")).toBe(false);
    expect(recordArchitectEnded(wt, "a1")).toBe(true);
    expect(architectStatus(wt, live)).toEqual({ kind: "ended", turn: 1, agent: "a1", sessionGone: false });
    expect(readGuardLog(wt).at(-1)).toMatchObject({ detail: { kind: ARCHITECT_ENDED, agent: "a1" } });
    recordArchitectRunning(wt, "a1", { pid: 10, pidStarted: "t" });
    expect(readArchitectState(wt)).toMatchObject({ turn: 2, state: "running" });
  });

  test("a seat whose host session is gone is lost, never running", () => {
    recordArchitectRunning(wt, "a1", { pid: 10, pidStarted: "t", sessionBound: true });
    expect(architectStatus(wt, dead)).toEqual({ kind: "lost", turn: 1, agent: "a1", why: "session-gone" });
    expect(seatNeedsRelaunch(architectStatus(wt, dead))).toBe(true);
    expect(architectStatus(wt, { startTime: () => "a later process" }).kind).toBe("lost");
    recordArchitectEnded(wt, "a1");
    expect(architectStatus(wt, dead)).toMatchObject({ kind: "ended", sessionGone: true });
    expect(seatNeedsRelaunch(architectStatus(wt, dead))).toBe(true);
    expect(seatNeedsRelaunch(architectStatus(wt, live))).toBe(false);
  });

  test("where the recorded process is the subagent's own (pi), a stopped seat stays continuable after it exits", () => {
    recordArchitectRunning(wt, "run-1", { pid: 10, pidStarted: "t" });
    recordArchitectEnded(wt, "run-1");
    expect(architectStatus(wt, dead)).toMatchObject({ kind: "ended", sessionGone: false });
    expect(seatContinuable(wt, "run-1", dead)).toBe(true);
  });

  // Regression (U3): a seat whose session cannot be recognised does not stay running forever.
  test("an unrecognised session counts as running only until the age limit", () => {
    const unknown: ProcessProbe = { startTime: () => null };
    recordArchitectRunning(wt, "a1", { pid: 10, pidStarted: "t", sessionBound: true });
    const since = Date.parse(readArchitectState(wt)!.startedAt);
    expect(architectStatus(wt, unknown, since + 1000)).toMatchObject({ kind: "running", unrecognised: true });
    expect(architectStatus(wt, live, since + 1000)).not.toHaveProperty("unrecognised");
    const late = since + UNRECOGNISED_SEAT_MAX_AGE_MS + 1;
    expect(architectStatus(wt, unknown, late)).toEqual({ kind: "lost", turn: 1, agent: "a1", why: "unrecognised-expired" });
    expect(seatNeedsRelaunch(architectStatus(wt, unknown, late))).toBe(true);
    recordArchitectEnded(wt, "a1");
    expect(architectStatus(wt, unknown, late)).toMatchObject({ kind: "ended", sessionGone: true });
    expect(architectStatus(wt, unknown, since + 1000)).toMatchObject({ kind: "ended", sessionGone: false });
  });

  test("clearing the seat leaves no architect", () => {
    recordArchitectRunning(wt, "a1", { pid: 10, pidStarted: "t" });
    clearArchitectState(wt);
    expect(architectStatus(wt, live)).toEqual({ kind: "none" });
    expect(seatNeedsRelaunch(architectStatus(wt, live))).toBe(true);
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
    settings(["PreToolUse", "WorktreeCreate", "WorktreeRemove", "SubagentStop"]);
    expect(claudeGateProblem(wt, [])).toBeUndefined();
    settings(["PreToolUse", "WorktreeCreate", "WorktreeRemove"]);
    expect(claudeGateProblem(wt, [])).toContain("on SubagentStop");
    settings(["PreToolUse", "WorktreeCreate", "WorktreeRemove", "SubagentStop"]);
    definition("builder", "");
    expect(claudeGateProblem(wt, [])).toContain("builder definition does not run in dontAsk");
    definition("builder");
    // Final review: local settings can switch every hook off too.
    writeFileSync(join(main, ".claude/settings.local.json"), JSON.stringify({ disableAllHooks: true }));
    expect(claudeGateProblem(wt, [])).toContain("settings.local.json switches hooks off");
    rmSync(join(main, ".claude/settings.local.json"));
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
