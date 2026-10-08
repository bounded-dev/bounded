import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  readArchitectState, readPendingLaunch, readPendingReply, recordArchitectEnded, recordArchitectRunning, writePendingLaunch, writePendingReply,
} from "../../src/architect-seat.ts";
import { afterLeadArchitectCall, leadArchitectCall, recordArchitectSeatLife } from "./extensions/lib/architect-seat-gate.ts";

// pi's architect seat (ADR 2026-066): the lead's async child in the ticket
// worktree, started and continued only as the lead's commands prepared.

let main = "";
let wt = "";
beforeEach(() => {
  main = mkdtempSync(join(tmpdir(), "bounded-pi-seat-"));
  wt = join(main, ".bounded/worktrees/7");
  mkdirSync(join(wt, ".bounded"), { recursive: true });
  writeFileSync(join(wt, ".bounded/ticket-worktree.json"), JSON.stringify({ issue: 7, branch: "ticket/7", main, owns: [] }));
  vi.stubEnv("BOUNDED_GUARD_LOG", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(main, { recursive: true, force: true });
});

const pending = (): void => writePendingLaunch(main, { issue: 7, worktree: wt, brief: "Ticket #7 brief", model: "anthropic/claude-opus-5", createdAt: "t" });

describe("the lead's architect launch", () => {
  test("needs a pending ticket, and is rewritten to exactly its brief, worktree and background running", () => {
    expect(leadArchitectCall({ agent: "architect", task: "go" }, "c1", main)).toEqual({ handled: true, refuse: expect.stringContaining("run bounded lead start") });
    pending();
    expect(leadArchitectCall({ agent: "architect", task: "go", share: true }, "c1", main)).toEqual({ handled: true, refuse: expect.stringContaining("'share' is not allowed") });
    const input: Record<string, unknown> = { agent: "architect", task: "go", cwd: "/elsewhere", async: false };
    expect(leadArchitectCall(input, "c1", main)).toEqual({ handled: true });
    expect(input).toEqual({ agent: "architect", task: "Ticket #7 brief", cwd: wt, async: true, agentScope: "project", model: "anthropic/claude-opus-5" });
    expect(leadArchitectCall({ agent: "architect", task: "again" }, "c2", main)).toEqual({ handled: true, refuse: expect.stringContaining("already under way") });
  });

  test("a failed launch releases its claim; any other subagent call is left to the lead policy", () => {
    pending();
    leadArchitectCall({ agent: "architect", task: "go" }, "c1", main);
    afterLeadArchitectCall({ agent: "architect" }, "c1", true, main);
    expect(readPendingLaunch(main)?.claimedBy).toBeUndefined();
    expect(leadArchitectCall({ agent: "scout", task: "look" }, "c3", main)).toEqual({ handled: false });
  });

  test("the child records its own start, which releases the pending launch, and its end", () => {
    pending();
    vi.stubEnv("PI_SUBAGENT_RUN_ID", "run-1");
    recordArchitectSeatLife(wt, "start");
    expect(readArchitectState(wt)).toMatchObject({ agent: "run-1", state: "running", pid: process.pid });
    expect(readPendingLaunch(main)).toBeUndefined();
    recordArchitectSeatLife(wt, "end");
    expect(readArchitectState(wt)?.state).toBe("ended");
  });
});

describe("the lead's continuation", () => {
  test("resume carries exactly the prepared reply, to exactly the recorded run", () => {
    expect(leadArchitectCall({ action: "resume", id: "run-1", message: "x" }, "c1", main).handled).toBe(true);
    recordArchitectRunning(wt, "run-1", { pid: 1, pidStarted: "t" });
    recordArchitectEnded(wt, "run-1");
    writePendingReply(main, { issue: 7, worktree: wt, agent: "run-1", message: "Euros.", createdAt: "t" });
    expect(leadArchitectCall({ action: "resume", id: "run-9", message: "x" }, "c1", main)).toEqual({ handled: true, refuse: expect.stringContaining("only a reply prepared") });
    expect(leadArchitectCall({ action: "resume", id: "run-1", message: "x", index: 1 }, "c1", main)).toEqual({ handled: true, refuse: expect.stringContaining("'index' is not allowed") });
    const input: Record<string, unknown> = { action: "resume", id: "run-1", message: "anything" };
    expect(leadArchitectCall(input, "c1", main)).toEqual({ handled: true });
    expect(input["message"]).toBe("Euros.");
    expect(readPendingReply(main, 7)).toBeUndefined();
  });

  // Regression (final review M2; re-review U1).
  test("a lost seat is relaunched, not resumed; a claim whose launch never started its child can be claimed again", () => {
    recordArchitectRunning(wt, "run-1", { pid: 999_999, pidStarted: "long ago" });
    writePendingReply(main, { issue: 7, worktree: wt, agent: "run-1", message: "Go on.", createdAt: "t" });
    const input: Record<string, unknown> = { action: "resume", id: "run-1", message: "x" };
    expect(leadArchitectCall(input, "c1", main)).toEqual({ handled: true, refuse: expect.stringContaining("relaunch it with bounded lead start 7") });
    expect(input["message"]).toBe("x");
    pending();
    writePendingLaunch(main, { ...readPendingLaunch(main)!, claimedBy: "c1", claimedAt: new Date(Date.now() - 16 * 60_000).toISOString(), claimant: { pid: process.pid, pidStarted: "t" } });
    expect(leadArchitectCall({ agent: "architect", task: "go" }, "c2", main)).toEqual({ handled: true });
  });
});
