import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  clearPendingLaunch, readArchitectState, readPendingLaunch, readPendingReply, recordArchitectEnded, recordArchitectRunning,
  type ArchitectHost,
} from "./architect-seat.ts";
import {
  gitCommandLine, LEAD_COMMANDS, parseLeadArgs, runLeadCommand, type LeadDeps, type LeadRequest,
} from "./lead-commands.ts";
import { readStartedTicket, readTicketMarker, ticketWorktreePath, writeStartedTicket } from "./ticket-worktree.ts";
import { recordDeliverySnapshot } from "./delivery-snapshot.ts";
import { LEAD_LOCK_RELATIVE } from "./lead-commands.ts";
import { FakeTracker } from "../test/support/fake-tracker.ts";
import { delivered, logLines, prepared, runStart } from "../test/support/lead-project.ts";

// The lead's commands and every board transition they make (ADR 2026-066),
// against real git repositories (a bare origin and the main worktree) and a
// fake tracker, setup, check and architect host.

let root = "";
let main = "";
let origin = "";
let tracker: FakeTracker;
let check: ReturnType<typeof vi.fn<(cwd: string) => { ok: boolean; output: string }>>;
let setup: ReturnType<typeof vi.fn<(worktree: string) => Promise<{ ok: boolean; summary: string }>>>;
let preflight: ReturnType<typeof vi.fn<(worktree: string) => string | undefined>>;

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const write = (dir: string, rel: string, content: string): void => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), content);
};

const HOST: ArchitectHost = {
  name: "test", model: (p) => p,
  preflight: (worktree) => preflight(worktree),
  launchInstruction: (launch) => `LAUNCH #${launch.issue}`,
  replyInstruction: (reply) => `SEND to ${reply.agent}`,
};

beforeEach(() => {
  for (const [k, v] of Object.entries({
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid", BOUNDED_GUARD_LOG: "", BOUNDED_TICKET: undefined,
  })) vi.stubEnv(k, v as string);
  root = mkdtempSync(join(tmpdir(), "bounded-lead-"));
  origin = join(root, "origin.git");
  main = join(root, "main");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["init", "-q", "-b", "main", main]);
  write(main, ".gitignore", ".bounded/*\n!.bounded/harness/\n!.bounded/installation.json\n");
  write(main, ".bounded/installation.json", '{"host":"claude-code"}\n');
  write(main, ".bounded/harness/.keep", "");
  write(main, "docs/tn/README.md", "# Technical notes\n");
  write(main, "README.md", "# Shop\n");
  git(main, "add", "-A");
  git(main, "commit", "-q", "-m", "init");
  git(main, "remote", "add", "origin", origin);
  git(main, "push", "-q", "origin", "main");
  tracker = new FakeTracker();
  check = vi.fn(() => ({ ok: true, output: "check passed" }));
  setup = vi.fn(async () => ({ ok: true, summary: "installed" }));
  preflight = vi.fn(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const deps = (): LeadDeps => ({
  tracker: () => tracker, git: gitCommandLine, host: async () => HOST, setup, check,
  // This test process runs (for the lead's lock, and as a bound architect's session); nothing else does.
  processes: { startTime: (pid) => (pid === process.pid ? "t" : undefined) },
});
const lead = (argv: string[]): Promise<{ ok: boolean; text: string }> => {
  const parsed = parseLeadArgs(argv);
  if (!parsed.ok) throw new Error(parsed.reason);
  return runLeadCommand(main, parsed.request, deps());
};
const create = async (title: string, owns: string[], depends: string[] = []): Promise<number> => {
  const out = await lead(["ticket", "create", "--title", title, "--outcome", "o", "--acceptance", "a",
    ...owns.flatMap((p) => ["--owns", p]), ...depends.flatMap((d) => ["--depends", d]), "--decisions", "d"]);
  expect(out.ok, out.text).toBe(true);
  return Number(/#(\d+)/.exec(out.text)![1]);
};
const issue = (n: number) => tracker.issues.get(n)!;
/** What the host adapter does when it binds the lead's architect launch for `n`. */
const bind = (n: number, agent = `a${String(n).padStart(16, "0")}`): string => {
  expect(readPendingLaunch(main)?.issue).toBe(n);
  recordArchitectRunning(ticketWorktreePath(main, n), agent, { pid: process.pid, pidStarted: "t" });
  clearPendingLaunch(main);
  return agent;
};
/** What a delivered ticket worktree holds: its product files and a final delivery. */
const deliver = (n: number, rel = `contexts/t${n}.ts`): void => {
  const wt = ticketWorktreePath(main, n);
  write(wt, rel, `export const t${n} = ${n};\n`);
  write(wt, ".bounded/guard-log.jsonl", logLines(prepared(String(n)), runStart, delivered));
  recordDeliverySnapshot(wt);
  // A delivered ticket's architect has stopped.
  const seat = readArchitectState(wt);
  if (seat !== undefined) recordArchitectEnded(wt, seat.agent);
  tracker.setStatus(n, "Awaiting Merge");
};

describe("parseLeadArgs — one parser for every host", () => {
  test("every command's usage is a shape the parser knows", () => {
    expect(LEAD_COMMANDS.map((c) => c.name)).toEqual(["ticket create", "queue", "start", "status", "reply", "merge", "board"]);
  });
  test.each([
    [["status"], { command: "status" }],
    [["queue", "#4"], { command: "queue", issue: 4 }],
    [["start", "4"], { command: "start", issue: 4 }],
    [["merge", "4"], { command: "merge", issue: 4 }],
    [["reply", "4", "go ahead"], { command: "reply", issue: 4, message: "go ahead" }],
  ] as const)("%j", (argv, request) => {
    expect(parseLeadArgs(argv)).toEqual({ ok: true, request });
  });
  test.each([[["prepare"]], [["release"]], [["start"]], [["start", "x"]], [["status", "1"]], [["reply", "1"]], [["reply", "1", " "]],
    [["ticket", "create", "--title", "t"]], [["ticket", "create", "--bogus", "x"]], [["ticket", "create", "--depends", "x"]]])(
    "refuses %j", (argv) => {
      expect(parseLeadArgs(argv).ok).toBe(false);
    });
});

describe("the board transitions", () => {
  test("ticket create → Backlog, with the five sections", async () => {
    const n = await create("Invoices", ["contexts/billing/invoice.contract.ts"]);
    expect(issue(n)).toMatchObject({ title: "Invoices", status: "Backlog" });
    expect(issue(n).body).toContain("## Owned paths\n\n- `contexts/billing/invoice.contract.ts`");
  });

  test("queue → Queued; a dependency without a published handoff becomes a waiting label", async () => {
    const producer = await create("Catalog", ["contexts/catalog/a.contract.ts"]);
    const consumer = await create("Orders", ["contexts/orders/b.contract.ts"], [String(producer)]);
    expect((await lead(["queue", String(consumer)])).text).toContain(`waiting on #${producer}`);
    expect(issue(consumer)).toMatchObject({ status: "Queued", labels: [`waiting on #${producer}`] });
    expect((await lead(["queue", String(consumer)])).text).toContain("is Queued, not Backlog");
    // A dependency whose handoff is already published leaves no label.
    tracker.addLabel(producer, "handoff published");
    const second = await create("Payments", ["contexts/pay/c.contract.ts"], [String(producer)]);
    await lead(["queue", String(second)]);
    expect(issue(second).labels).toEqual([]);
  });

  test("start → In Design: its own worktree and branch, set up, its run prepared, its architect launched", async () => {
    const n = await create("Invoices", ["contexts/billing/invoice.contract.ts"]);
    expect((await lead(["start", String(n)])).text).toContain("only a Queued ticket starts");
    await lead(["queue", String(n)]);
    const out = await lead(["start", String(n)]);
    expect(out.ok, out.text).toBe(true);
    const wt = ticketWorktreePath(main, n);
    expect(git(wt, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`ticket/${n}`);
    expect(readTicketMarker(wt)).toEqual({ issue: n, branch: `ticket/${n}`, main, owns: ["contexts/billing/invoice.contract.ts"] });
    expect(readFileSync(join(wt, ".bounded/active-ticket"), "utf8")).toBe(`${n}\n`);
    expect(setup).toHaveBeenCalledWith(wt);
    // The core launches nothing: one pending launch waits for the host to bind it.
    expect(out.text).toContain(`LAUNCH #${n}`);
    expect(readPendingLaunch(main)).toMatchObject({ issue: n, worktree: wt, brief: expect.stringContaining(`Ticket #${n}: Invoices`) });
    expect(readArchitectState(wt)).toBeUndefined();
    expect(issue(n).status).toBe("In Design");
    expect(readStartedTicket(main, n)).toMatchObject({ owns: ["contexts/billing/invoice.contract.ts"], worktree: wt });
    expect(git(main, "status", "--porcelain")).toBe("");
    expect((await lead(["start", String(n)])).text).toContain(`is waiting for its architect. LAUNCH #${n}`);
    bind(n);
    expect((await lead(["start", String(n)])).text).toContain("already has a worktree and an architect");
  });

  test("one pending launch at a time: another ticket starts only once the waiting one is bound", async () => {
    const a = await create("A", ["contexts/a/"]);
    const b = await create("B", ["contexts/b/"]);
    for (const n of [a, b]) await lead(["queue", String(n)]);
    await lead(["start", String(a)]);
    expect((await lead(["start", String(b)])).text).toContain(`#${a} is waiting for its architect`);
    bind(a);
    expect((await lead(["start", String(b)])).ok).toBe(true);
  });

  test("start refuses a ticket still waiting on a dependency, and two parallel tickets owning one contract path", async () => {
    const a = await create("A", ["contexts/shared/"]);
    const b = await create("B", ["contexts/shared/money.contract.ts"]);
    const c = await create("C", ["contexts/c/c.contract.ts"], [String(a)]);
    for (const n of [a, b, c]) await lead(["queue", String(n)]);
    expect((await lead(["start", String(c)])).text).toContain(`still waiting on #${a}`);
    expect((await lead(["start", String(a)])).ok).toBe(true);
    bind(a);
    const conflict = await lead(["start", String(b)]);
    expect(conflict.text).toContain(`overlaps 'contexts/shared/' owned by started ticket #${a}`);
    expect(existsSync(ticketWorktreePath(main, b))).toBe(false);
    expect(issue(b).status).toBe("Queued");
  });

  test("a start that cannot set up, or whose architect's gate would not hold, removes its worktree and branch and leaves the ticket Queued", async () => {
    const n = await create("A", ["contexts/a/a.contract.ts"]);
    await lead(["queue", String(n)]);
    setup.mockResolvedValueOnce({ ok: false, summary: "bun install failed" });
    expect((await lead(["start", String(n)])).text).toContain("not started — bun install failed");
    preflight.mockReturnValueOnce("no hook registered");
    expect((await lead(["start", String(n)])).text).toContain("its architect's gate would not hold: no hook registered");
    expect(readPendingLaunch(main)).toBeUndefined();
    expect(existsSync(ticketWorktreePath(main, n))).toBe(false);
    expect(git(main, "branch", "--list", `ticket/${n}`)).toBe("");
    expect(issue(n).status).toBe("Queued");
    expect(readStartedTicket(main, n)).toBeUndefined();
  });

  test("status follows the seat; reply prepares exactly one continuation, only of a stopped architect", async () => {
    const n = await create("A", ["contexts/a/a.contract.ts"]);
    await lead(["queue", String(n)]);
    await lead(["start", String(n)]);
    const wt = ticketWorktreePath(main, n);
    expect((await lead(["status"])).text).toContain(`architect: waiting to be launched — LAUNCH #${n}`);
    expect((await lead(["reply", String(n), "x"])).text).toContain("was never launched");
    const agent = bind(n);
    tracker.addLabel(n, "blocked: architect");
    const running = await lead(["status"]);
    expect(running.text).toContain(`#${n} A — In Design (blocked: architect)`);
    expect(running.text).toContain("architect: running turn 1");
    expect((await lead(["reply", String(n), "Euros."])).text).toContain("still running");
    recordArchitectEnded(wt, agent);
    expect((await lead(["status"])).text).toContain("turn 1 stopped and reported to you");
    const reply = await lead(["reply", String(n), "Euros."]);
    expect(reply.ok, reply.text).toBe(true);
    expect(reply.text).toContain(`SEND to ${agent}`);
    expect(readPendingReply(main)).toMatchObject({ issue: n, agent, message: "Euros." });
    expect((await lead(["reply", "99", "x"])).text).toContain("#99 is not started");
  });

  test("merge → Done: delivered work committed, merged into main, checked, pushed and closed; the worktree removed", async () => {
    const n = await create("A", ["contexts/a/a.contract.ts"]);
    await lead(["queue", String(n)]);
    await lead(["start", String(n)]);
    tracker.setStatus(n, "Building");
    expect((await lead(["merge", String(n)])).text).toContain("only a ticket whose deliver gate passed merges");
    tracker.setStatus(n, "Awaiting Merge");
    expect((await lead(["merge", String(n)])).text).toContain("records no final delivery");
    write(ticketWorktreePath(main, n), ".bounded/guard-log.jsonl", logLines(prepared(String(n)), runStart, delivered));
    expect((await lead(["merge", String(n)])).text).toContain("records no delivered tree; rerun deliver");
    deliver(n);
    const out = await lead(["merge", String(n)]);
    expect(out.ok, out.text).toBe(true);
    expect(check).toHaveBeenCalledWith(main);
    expect(readFileSync(join(main, `contexts/t${n}.ts`), "utf8")).toContain(`t${n}`);
    expect(git(main, "rev-parse", "main")).toBe(git(origin, "rev-parse", "main"));
    expect(git(main, "log", "-1", "--format=%s")).toBe(`Merge #${n}: A`);
    expect(issue(n)).toMatchObject({ status: "Done", state: "closed" });
    expect(existsSync(ticketWorktreePath(main, n))).toBe(false);
    expect(readStartedTicket(main, n)).toBeUndefined();
  });

  test("a failing project check undoes the merge, pushes nothing and leaves the ticket Awaiting Merge", async () => {
    const n = await create("A", ["contexts/a/a.contract.ts"]);
    await lead(["queue", String(n)]);
    await lead(["start", String(n)]);
    deliver(n);
    const before = git(main, "rev-parse", "main");
    check.mockReturnValueOnce({ ok: false, output: "1 test failed" });
    const out = await lead(["merge", String(n)]);
    expect(out.ok).toBe(false);
    expect(out.text).toContain("the project check failed");
    expect(out.text).toContain("the merge was undone");
    expect(git(main, "rev-parse", "main")).toBe(before);
    expect(git(origin, "rev-parse", "main")).toBe(before);
    expect(git(main, "status", "--porcelain")).toBe("");
    expect(issue(n)).toMatchObject({ status: "Awaiting Merge", state: "open" });
  });

  test("merge refuses unless local main is level with origin/main, and refuses a conflicting merge", async () => {
    const n = await create("A", ["contexts/a/a.contract.ts"]);
    await lead(["queue", String(n)]);
    await lead(["start", String(n)]);
    deliver(n, "README.md");
    // Someone else pushed first.
    const other = join(root, "other");
    execFileSync("git", ["clone", "-q", origin, other]);
    write(other, "README.md", "# Shop, renamed\n");
    git(other, "commit", "-q", "-am", "rename");
    git(other, "push", "-q", "origin", "main");
    expect((await lead(["merge", String(n)])).text).toContain("not level with origin/main");
    git(main, "pull", "-q", "--ff-only", "origin", "main");
    const out = await lead(["merge", String(n)]);
    expect(out.text).toContain("does not merge cleanly");
    expect(git(main, "status", "--porcelain")).toBe("");
    expect(check).not.toHaveBeenCalled();
  });

  test("a pushed merge whose board update fails reports the pending update; the next command replays it first", async () => {
    const n = await create("A", ["contexts/a/a.contract.ts"]);
    await lead(["queue", String(n)]);
    await lead(["start", String(n)]);
    deliver(n);
    tracker.failAfter = 2; // check, view, then the Done update fails
    const out = await lead(["merge", String(n)]);
    expect(out.ok).toBe(false);
    expect(out.text).toContain("merged, checked and pushed, but the board update is pending");
    tracker.failAfter = undefined;
    await lead(["status"]);
    expect(issue(n)).toMatchObject({ status: "Done", state: "closed" });
  });
});

describe("review fixes (ADR 2026-066)", () => {
  const started = async (title: string, owns: string[]): Promise<number> => {
    const n = await create(title, owns);
    await lead(["queue", String(n)]);
    const out = await lead(["start", String(n)]);
    expect(out.ok, out.text).toBe(true);
    bind(n);
    return n;
  };

  test("merge refuses a worktree that changed after delivery — a new file, an edit, or only a staged change", async () => {
    const n = await started("A", ["contexts/a/"]);
    const wt = ticketWorktreePath(main, n);
    deliver(n, "contexts/a/a.ts");
    write(wt, "contexts/a/late.ts", "export const late = 1;\n");
    expect((await lead(["merge", String(n)])).text).toContain("the worktree changed after delivery; rerun deliver");
    rmSync(join(wt, "contexts/a/late.ts"));
    write(wt, "contexts/a/a.ts", "export const changed = 1;\n");
    expect((await lead(["merge", String(n)])).text).toContain("the worktree changed after delivery");
    deliver(n, "contexts/a/a.ts");
    git(wt, "add", "contexts/a/a.ts");
    expect((await lead(["merge", String(n)])).text).toContain("the worktree changed after delivery");
    expect(check).not.toHaveBeenCalled();
    expect((await lead(["status"])).text).toContain("the worktree changed after delivery");
  });

  test("a reply to a delivered ticket reopens it to Building and drops the delivery, so merge waits for deliver again", async () => {
    const n = await started("A", ["contexts/a/"]);
    deliver(n, "contexts/a/a.ts");
    recordArchitectEnded(ticketWorktreePath(main, n), readArchitectState(ticketWorktreePath(main, n))!.agent);
    const out = await lead(["reply", String(n), "One more field, please."]);
    expect(out.text).toContain("reopened to Building");
    expect(issue(n).status).toBe("Building");
    tracker.setStatus(n, "Awaiting Merge");
    expect((await lead(["merge", String(n)])).text).toContain("records no delivered tree");
  });

  test("a reply that could be read as an option is refused", async () => {
    const n = await started("A", ["contexts/a/"]);
    expect(parseLeadArgs(["reply", String(n), "--dangerously-skip-permissions"]).ok).toBe(false);
    expect((await runLeadCommand(main, { command: "reply", issue: n, message: "-p x" }, deps())).text).toContain("may not begin with '-'");
    expect(readPendingReply(main)).toBeUndefined();
  });

  test("one lead command at a time: a live holder refuses the next; a dead one's lock is cleared", async () => {
    write(main, LEAD_LOCK_RELATIVE, JSON.stringify({ pid: process.pid, started: "t" }));
    expect((await lead(["status"])).text).toContain("another lead command is running");
    write(main, LEAD_LOCK_RELATIVE, JSON.stringify({ pid: 999_999, started: "long ago" }));
    expect((await lead(["status"])).ok).toBe(true);
    expect(existsSync(join(main, LEAD_LOCK_RELATIVE))).toBe(false);
  });

  test("the started record is written before setup, so a parallel start sees the ownership at once", async () => {
    const a = await create("A", ["contexts/shared/"]);
    await lead(["queue", String(a)]);
    let seen: unknown;
    setup.mockImplementationOnce(async () => { seen = readStartedTicket(main, a); return { ok: true, summary: "installed" }; });
    await lead(["start", String(a)]);
    expect(seen).toMatchObject({ phase: "starting", owns: ["contexts/shared/"] });
    expect(readStartedTicket(main, a)).toMatchObject({ phase: "started" });
  });

  test("a start a crash interrupted is finished by running start again", async () => {
    const n = await create("A", ["contexts/a/"]);
    await lead(["queue", String(n)]);
    // The process died after the worktree was added and the board moved, before setup finished.
    const wt = ticketWorktreePath(main, n);
    git(main, "worktree", "add", "-q", "-b", `ticket/${n}`, wt, "main");
    writeStartedTicket(main, { phase: "starting", issue: n, title: "A", branch: `ticket/${n}`, worktree: wt, owns: ["contexts/a/"], startedAt: "t" });
    tracker.setStatus(n, "In Design");
    expect((await lead(["status"])).text).toContain(`run bounded lead start ${n} to finish it`);
    expect((await lead(["merge", String(n)])).text).toContain("start did not finish");
    const out = await lead(["start", String(n)]);
    expect(out.ok, out.text).toBe(true);
    expect(out.text).toContain("start finished");
    expect(readTicketMarker(wt)).toMatchObject({ issue: n, owns: ["contexts/a/"] });
    expect(readPendingLaunch(main)?.issue).toBe(n);
    bind(n);
    expect(readStartedTicket(main, n)).toMatchObject({ phase: "started" });
    // A worktree on the board with no record at all is finished the same way.
    const m = await create("B", ["contexts/b/"]);
    tracker.setStatus(m, "In Design");
    git(main, "worktree", "add", "-q", "-b", `ticket/${m}`, ticketWorktreePath(main, m), "main");
    expect((await lead(["start", String(m)])).text).toContain("start finished");
    bind(m);
    // A failure while finishing keeps the worktree and says how to finish.
    const k = await create("C", ["contexts/c/"]);
    tracker.setStatus(k, "In Design");
    git(main, "worktree", "add", "-q", "-b", `ticket/${k}`, ticketWorktreePath(main, k), "main");
    setup.mockResolvedValueOnce({ ok: false, summary: "offline" });
    const failed = await lead(["start", String(k)]);
    expect(failed.text).toContain(`run bounded lead start ${k} again to finish it`);
    expect(existsSync(ticketWorktreePath(main, k))).toBe(true);
  });

  // Regression (re-review): one permanently failing update blocked every command.
  test("a board update that keeps failing while the tracker answers is quarantined, reported, and retried or discarded", async () => {
    const n = await started("A", ["contexts/a/"]);
    const wt = ticketWorktreePath(main, n);
    write(wt, ".bounded/board-pending.json", JSON.stringify([
      { op: "add-label", issue: 999, label: "blocked: builder" }, { op: "status", issue: n, status: "Building" },
    ]));
    for (let i = 1; i < 3; i++) expect((await lead(["status"])).text, `attempt ${i}`).toContain("route → user");
    const status = await lead(["status"]);
    expect(status.ok, status.text).toBe(true);
    expect(status.text).toContain(`board update quarantined (.bounded/worktrees/${n}): add-label 'blocked: builder' on #999 failed 3 times`);
    expect(status.text).toContain("bounded lead board retry");
    expect(issue(n).status).toBe("Building");
    // A retry puts it back in line; it fails again and is set aside again.
    expect((await lead(["board", "retry"])).text).toContain("pending again");
    expect((await lead(["status"])).ok).toBe(false);
    expect((await lead(["status"])).text).toContain("quarantined");
    expect((await lead(["board", "discard"])).text).toContain("discarded 1");
    expect((await lead(["status"])).text).not.toContain("quarantined");
  });

  test("a board update a gate left pending in a ticket worktree is replayed by the next lead command", async () => {
    const n = await started("A", ["contexts/a/"]);
    write(ticketWorktreePath(main, n), ".bounded/board-pending.json", JSON.stringify([{ op: "status", issue: n, status: "Awaiting Merge" }]));
    await lead(["status"]);
    expect(issue(n).status).toBe("Awaiting Merge");
    expect(existsSync(join(ticketWorktreePath(main, n), ".bounded/board-pending.json"))).toBe(false);
    write(ticketWorktreePath(main, n), ".bounded/board-pending.json", JSON.stringify([{ op: "status", issue: n, status: "Building" }]));
    tracker.failAfter = 1;
    expect((await lead(["merge", String(n)])).text).toContain("route → user");
  });
});

describe("refusals before anything changes", () => {
  test("an unreachable tracker refuses every command, routed to the user", async () => {
    tracker.offline = true;
    for (const argv of [["status"], ["start", "1"], ["merge", "1"]]) {
      const out = await lead(argv);
      expect(out.ok).toBe(false);
      expect(out.text).toContain("route → user");
    }
    expect(existsSync(ticketWorktreePath(main, 1))).toBe(false);
  });

  test("the lead works only from the main worktree, on main", async () => {
    git(main, "checkout", "-q", "-b", "elsewhere");
    expect((await lead(["status"])).text).toContain("the lead works on main");
    git(main, "checkout", "-q", "main");
    write(main, ".bounded/ticket-worktree.json", JSON.stringify({ issue: 1, branch: "ticket/1", main }));
    expect((await lead(["status"])).text).toContain("this is a ticket worktree");
  });

  test("a command's outcome is recorded in the main worktree's guard log", async () => {
    await lead(["status"]);
    const log = readFileSync(join(main, ".bounded/guard-log.jsonl"), "utf8");
    expect(log).toContain('"command":"status"');
    const request: LeadRequest = { command: "status" };
    expect((await runLeadCommand(join(root, "nowhere"), request, deps())).text).toContain("no project-local Bounded installation");
  });
});
