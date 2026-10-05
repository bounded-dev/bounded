import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { applyBoardOps, boardOpsFor, boardPending, pendingOps, quarantinedOps, routeOf, runGateWithBoard } from "./board-sync.ts";
import { gateRunning, type GateResult } from "./gate-result.ts";
import { logGuardEvent, readGuardLog } from "./guard-log.ts";
import { SUBAGENT_STOPPED, WORKER_RESUMED } from "./lead-state.ts";
import { TICKET_MARKER_RELATIVE } from "./ticket-worktree.ts";
import { FakeTracker } from "../test/support/fake-tracker.ts";

// The board follows the gates in a ticket worktree (ADR 2026-066).

const pass = (summary = "ok", detail: Readonly<Record<string, unknown>> = {}): GateResult =>
  ({ code: 0, verdict: "pass", summary, lines: [summary], detail });
const block = (route?: string): GateResult => ({
  code: 1, verdict: "block", summary: "contracts not frozen",
  lines: ["x: BLOCK — contracts not frozen", ...(route !== undefined ? [`x: route → ${route}`] : [])], detail: {},
});
const error = (): GateResult => ({ code: 2, verdict: "error", summary: "misuse", lines: [], detail: {} });

let dir = "";
let tracker: FakeTracker;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bounded-board-"));
  // A ticket worktree is a git checkout: a delivered pass records its tree.
  execFileSync("git", ["init", "-q", dir]);
  writeFileSync(join(dir, ".gitignore"), ".bounded/\n");
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir });
  mkdirSync(join(dir, ".bounded"));
  writeFileSync(join(dir, TICKET_MARKER_RELATIVE), JSON.stringify({ issue: 7, branch: "ticket/7", main: "/m" }));
  tracker = new FakeTracker();
  tracker.seed({ number: 7, title: "t", status: "In Design" });
  vi.stubEnv("BOUNDED_GUARD_LOG", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const run = (gate: { name: string; milestone?: "design-frozen" | "delivered" | "handoff-published" }, result: GateResult, role?: string) => {
  const ran = vi.fn(async () => result);
  return { ran, out: runGateWithBoard(dir, gate, ran, () => tracker, role) };
};

describe("routeOf", () => {
  test("the detail's route, else the gate's own route line", () => {
    expect(routeOf(pass("x", { route: "builder" }))).toBe("builder");
    expect(routeOf(block("test-writer"))).toBe("test-writer");
    expect(routeOf(block())).toBeUndefined();
  });
});

describe("boardOpsFor — the transitions", () => {
  const state = { blocked: {} };
  test("every gate comments its one-line summary", () => {
    expect(boardOpsFor(7, { name: "typecheck" }, error(), state).ops).toEqual([{ op: "comment", issue: 7, body: "`typecheck`: ERROR — misuse" }]);
  });
  test("design frozen → Building; delivered → Awaiting Merge", () => {
    expect(boardOpsFor(7, { name: "design-gate", milestone: "design-frozen" }, pass(), state).ops).toContainEqual({ op: "status", issue: 7, status: "Building" });
    expect(boardOpsFor(7, { name: "deliver", milestone: "delivered" }, pass(), state).ops).toContainEqual({ op: "status", issue: 7, status: "Awaiting Merge" });
    expect(boardOpsFor(7, { name: "deliver", milestone: "delivered" }, block("builder"), state).ops).not.toContainEqual(expect.objectContaining({ op: "status" }));
  });
  test("a refusal labels the route; the same gate's pass clears it; another gate's label stays", () => {
    const blocked = boardOpsFor(7, { name: "red-gate" }, block("test-writer"), state);
    expect(blocked.ops).toContainEqual({ op: "add-label", issue: 7, label: "blocked: test-writer" });
    const other = boardOpsFor(7, { name: "green-gate" }, block(), blocked.state, { role: "builder" });
    expect(other.ops).toContainEqual({ op: "add-label", issue: 7, label: "blocked: builder" });
    const otherPass = boardOpsFor(7, { name: "typecheck" }, pass(), other.state);
    expect(otherPass.ops).toHaveLength(1);
    const cleared = boardOpsFor(7, { name: "red-gate" }, pass(), other.state);
    expect(cleared.ops).toContainEqual({ op: "remove-label", issue: 7, label: "blocked: test-writer" });
    expect(cleared.state.blocked).toEqual({ "green-gate": "blocked: builder" });
  });
  test("a refusal routed elsewhere replaces that gate's label; a label two gates share stays until both pass", () => {
    const first = boardOpsFor(7, { name: "red-gate" }, block("test-writer"), state);
    const moved = boardOpsFor(7, { name: "red-gate" }, block("architect"), first.state);
    expect(moved.ops).toContainEqual({ op: "remove-label", issue: 7, label: "blocked: test-writer" });
    const shared = boardOpsFor(7, { name: "green-gate" }, block("architect"), moved.state);
    expect(boardOpsFor(7, { name: "red-gate" }, pass(), shared.state).ops).not.toContainEqual(expect.objectContaining({ op: "remove-label" }));
  });
  test("a published handoff labels the producer and releases every ticket waiting on it", () => {
    const ops = boardOpsFor(7, { name: "handoff-publish", milestone: "handoff-published" }, pass(), state, { waiting: () => [8, 9] }).ops;
    expect(ops).toEqual(expect.arrayContaining([
      { op: "add-label", issue: 7, label: "handoff published" },
      { op: "remove-label", issue: 8, label: "waiting on #7" },
      { op: "remove-label", issue: 9, label: "waiting on #7" },
    ]));
  });
});

describe("runGateWithBoard", () => {
  // Final review M3: with background tasks on, a continued worker resumes in
  // the background (verified live); no gate may judge or freeze meanwhile.
  test("no gate runs while a worker resumed in the background has no recorded stop", async () => {
    logGuardEvent(dir, { guard: "phase-gate", verdict: "pass", summary: "resumed", detail: { kind: WORKER_RESUMED, role: "architect", worker: "a0000000000000001" } });
    const { ran, out } = run({ name: "design-gate", milestone: "design-frozen" }, pass());
    const result = await out;
    expect(ran).not.toHaveBeenCalled();
    expect(result).toMatchObject({ code: 2, detail: { route: "architect", workers: ["a0000000000000001"] } });
    expect(tracker.issues.get(7)!.status).toBe("In Design");
    logGuardEvent(dir, { guard: "phase-gate", verdict: "pass", summary: "stopped", detail: { kind: SUBAGENT_STOPPED, agent: "a0000000000000001" } });
    expect((await run({ name: "design-gate", milestone: "design-frozen" }, pass()).out).code).toBe(0);
  });

  test("a delivered pass records the delivered tree; a later refusal of that gate drops it", async () => {
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    await run({ name: "deliver", milestone: "delivered" }, pass("delivered")).out;
    const snapshot = JSON.parse(readFileSync(join(dir, ".bounded/delivery-snapshot.json"), "utf8")) as { tree: string; index: string };
    expect(snapshot.tree).toMatch(/^[0-9a-f]{40}$/);
    await run({ name: "deliver", milestone: "delivered" }, block("builder")).out;
    expect(existsSync(join(dir, ".bounded/delivery-snapshot.json"))).toBe(false);
  });

  test("outside a ticket worktree the gate just runs, and the tracker is never opened", async () => {
    rmSync(join(dir, TICKET_MARKER_RELATIVE));
    const open = vi.fn(() => tracker);
    const ran = vi.fn(async () => pass());
    expect(await runGateWithBoard(dir, { name: "design-gate" }, ran, open)).toEqual(pass());
    expect(open).not.toHaveBeenCalled();
  });

  test("a design-gate pass moves the ticket to Building and comments", async () => {
    const { out } = run({ name: "design-gate", milestone: "design-frozen" }, pass("frozen"));
    expect((await out).code).toBe(0);
    expect(tracker.issues.get(7)).toMatchObject({ status: "Building", comments: ["`design-gate`: PASS — frozen"] });
  });

  test("a refusal sets the blocked label; that gate's next pass clears it", async () => {
    await run({ name: "green-gate" }, block("builder")).out;
    expect(tracker.issues.get(7)!.labels).toEqual(["blocked: builder"]);
    await run({ name: "green-gate" }, pass()).out;
    expect(tracker.issues.get(7)!.labels).toEqual([]);
  });

  test("an unreachable tracker refuses before the gate runs, routed to the user", async () => {
    tracker.offline = true;
    const { ran, out } = run({ name: "deliver", milestone: "delivered" }, pass());
    const result = await out;
    expect(ran).not.toHaveBeenCalled();
    expect(result).toMatchObject({ code: 2, detail: { route: "user" } });
    expect(result.lines.at(-1)).toContain("route → user");
    expect(readGuardLog(dir).at(-1)).toMatchObject({ guard: "board", verdict: "block" });
  });

  test("a board update that fails after the gate ran stays pending; the next gate replays it first", async () => {
    tracker.failAfter = 2; // check, then the comment; the status update fails
    const result = await run({ name: "deliver", milestone: "delivered" }, pass("delivered")).out;
    expect(result).toMatchObject({ code: 2, detail: { route: "user", board: "pending", gateCode: 0 } });
    expect(boardPending(dir)).toBe(true);
    expect(pendingOps(dir)).toEqual([{ op: "status", issue: 7, status: "Awaiting Merge", attempts: 0 }]);
    expect(tracker.issues.get(7)!.status).toBe("In Design");
    // Still failing: the next gate does not run.
    const { ran, out } = run({ name: "typecheck" }, pass());
    expect((await out).code).toBe(2);
    expect(ran).not.toHaveBeenCalled();
    // Reachable again: the pending update lands before the next gate runs.
    tracker.failAfter = undefined;
    expect((await run({ name: "typecheck" }, pass()).out).code).toBe(0);
    expect(tracker.issues.get(7)!.status).toBe("Awaiting Merge");
    expect(existsSync(join(dir, ".bounded/board-pending.json"))).toBe(false);
  });
});

// A RUNNING result (ADR 2026-073): the board hears of a background run once,
// when it starts or restarts, never on each poll; it keeps every label.
describe("RUNNING on the board", () => {
  const deliverGate = { name: "deliver", milestone: "delivered" as const };
  const R = (job: "started" | "restarted" | "running"): GateResult =>
    gateRunning("deliver", { startedAt: "2026-10-05T10:00:00.000Z", job, pid: 4242 });

  test("a RUNNING that starts or restarts a job posts one comment; a poll posts nothing", () => {
    const state = { blocked: { deliver: "blocked: builder" } };
    for (const job of ["started", "restarted"] as const) {
      const { ops, state: after } = boardOpsFor(7, deliverGate, R(job), state);
      expect(ops).toHaveLength(1);
      expect(ops[0]).toMatchObject({ op: "comment", issue: 7 });
      expect((ops[0] as { body: string }).body).toContain("RUNNING");
      expect(after.blocked).toEqual({ deliver: "blocked: builder" });
    }
    expect(boardOpsFor(7, deliverGate, R("running"), state).ops).toEqual([]);
  });

  test("a RUNNING deliver neither records nor clears the delivery snapshot", async () => {
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    await run(deliverGate, pass("delivered")).out;
    const before = readFileSync(join(dir, ".bounded/delivery-snapshot.json"), "utf8");
    writeFileSync(join(dir, "b.ts"), "export const b = 2;\n");
    await run(deliverGate, R("started")).out;
    expect(readFileSync(join(dir, ".bounded/delivery-snapshot.json"), "utf8")).toBe(before);
  });
});

describe("pending board updates", () => {
  const pending = (ops: unknown[]) => writeFileSync(join(dir, ".bounded/board-pending.json"), JSON.stringify(ops));

  test("an unreachable tracker never counts toward quarantine", () => {
    pending([{ op: "status", issue: 7, status: "Building" }]);
    tracker.offline = true;
    for (let i = 0; i < 5; i++) expect(() => applyBoardOps(dir, tracker, [])).toThrow();
    expect(quarantinedOps(dir)).toEqual([]);
    expect(pendingOps(dir)).toEqual([{ op: "status", issue: 7, status: "Building", attempts: 0 }]);
  });

  test("after three failures with the tracker answering, the update is quarantined and the rest go on", () => {
    pending([{ op: "comment", issue: 404, body: "x" }, { op: "status", issue: 7, status: "Building" }]);
    expect(() => applyBoardOps(dir, tracker, [])).toThrow();
    expect(() => applyBoardOps(dir, tracker, [])).toThrow();
    applyBoardOps(dir, tracker, []);
    expect(quarantinedOps(dir)).toMatchObject([{ op: { op: "comment", issue: 404 }, attempts: 3, error: expect.stringContaining("not found") }]);
    expect(tracker.issues.get(7)!.status).toBe("Building");
    expect(pendingOps(dir)).toEqual([]);
  });

  // Regression (re-review): a gate and the lead replaying one worktree must
  // never both post the same update.
  test("a replay claims the pending file, so a second replay meanwhile finds nothing to post", () => {
    pending([{ op: "comment", issue: 7, body: "once" }]);
    const original = tracker.comment.bind(tracker);
    let nested = false;
    tracker.comment = (n: number, body: string) => {
      if (!nested) {
        nested = true;
        applyBoardOps(dir, tracker, []); // the other process, mid-replay
      }
      original(n, body);
    };
    applyBoardOps(dir, tracker, []);
    expect(tracker.issues.get(7)!.comments).toEqual(["once"]);
    expect(readdirSync(join(dir, ".bounded")).filter((f) => f.startsWith("board-pending"))).toEqual([]);
  });

  test("a claim left by a process that died is adopted", () => {
    writeFileSync(join(dir, ".bounded/board-pending.claim-4194311-dead"), JSON.stringify([{ op: "status", issue: 7, status: "Done" }]));
    applyBoardOps(dir, tracker, []);
    expect(tracker.issues.get(7)!.status).toBe("Done");
  });
});
