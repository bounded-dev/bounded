import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  clearPendingLaunch, readArchitectState, readPendingLaunch, readPendingReply, recordArchitectEnded, recordArchitectRunning,
  writePendingLaunch, writePendingReply, type ArchitectHost,
} from "./architect-seat.ts";
import { logGuardEvent, readGuardLog } from "./guard-log.ts";
import { backgroundWorkers, SEAT_RELEASED, SUBAGENT_STOPPED, WORKER_RESUMED } from "./lead-state.ts";
import {
  gitCommandLine, LEAD_COMMANDS, parseLeadArgs, runLeadCommand, type LeadDeps, type LeadRequest,
} from "./lead-commands.ts";
import { readStartedTicket, readTicketMarker, ticketWorktreePath, writeStartedTicket } from "./ticket-worktree.ts";
import { readDeliverySnapshot, recordDeliverySnapshot } from "./delivery-snapshot.ts";
import { commandsIn } from "../test/fixtures/user-steps.ts";
import { listJobs, runOrCollect } from "./detached-job.ts";
import { LEAD_LOCK_RELATIVE } from "./lead-commands.ts";
import { FakeTracker } from "../test/support/fake-tracker.ts";
import { delivered, logLines, prepared, runStart } from "../test/support/lead-project.ts";

// The lead's commands and every board transition they make (ADR LEG-2026-066),
// against real git repositories (a bare origin and the main worktree) and a
// fake tracker, setup and architect host. The project check is a fixture
// pack's (ADR LEG-2026-073): a small script whose exit code and duration a test
// sets in check.json, and which appends a line to checks.log each time it runs.

let root = "";
let main = "";
let origin = "";
let tracker: FakeTracker;
let checkPacks = "";
let setup: ReturnType<typeof vi.fn<(worktree: string) => Promise<{ ok: boolean; summary: string }>>>;
let preflight: ReturnType<typeof vi.fn<(worktree: string) => string | undefined>>;
let syncConfig: ReturnType<typeof vi.fn<(worktree: string) => { ok: boolean; output: string }>>;

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
  // The project check: the composed fixture pack's one command.
  checkPacks = join(root, "check-packs");
  write(root, "check.mjs", [
    'import { appendFileSync, existsSync, readFileSync } from "node:fs";',
    `const config = existsSync(${JSON.stringify(join(root, "check.json"))}) ? JSON.parse(readFileSync(${JSON.stringify(join(root, "check.json"))}, "utf8")) : {};`,
    `appendFileSync(${JSON.stringify(join(root, "checks.log"))}, "check\\n");`,
    'console.log(config.code ? "1 test failed" : "check passed");',
    "setTimeout(() => process.exit(config.code ?? 0), config.ms ?? 0);",
  ].join("\n"));
  write(checkPacks, "checker/contrib.json", JSON.stringify({ projectCheckCommands: [[process.execPath, join(root, "check.mjs")]] }));
  write(main, ".bounded/composed-packs.json", '["checker"]\n');
  tracker = new FakeTracker();
  setup = vi.fn(async () => ({ ok: true, summary: "installed" }));
  preflight = vi.fn(() => undefined);
  syncConfig = vi.fn(() => ({ ok: true, output: "sync-config: OK — 3 files restored" }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  killJobs();
  rmSync(root, { recursive: true, force: true });
});

/** Every background run a test started, in main and in each ticket worktree. */
function jobPids(): number[] {
  const places = [main, ...(existsSync(join(main, ".bounded/worktrees")) ? readdirSync(join(main, ".bounded/worktrees")).map((n) => join(main, ".bounded/worktrees", n)) : [])];
  const pids: number[] = [];
  for (const place of places) {
    const jobs = join(place, ".bounded/jobs");
    if (!existsSync(jobs)) continue;
    for (const name of readdirSync(jobs)) {
      try {
        const pid = (JSON.parse(readFileSync(join(jobs, name, "job.json"), "utf8")) as { pid?: unknown }).pid;
        if (typeof pid === "number" && pid > 0) pids.push(pid);
      } catch { /* not a job */ }
    }
  }
  return pids;
}
function killJobs(): void {
  for (const pid of jobPids()) {
    try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
  }
}

const deps = (): LeadDeps => ({
  tracker: () => tracker, git: gitCommandLine, host: async () => HOST, setup, syncConfig, packsDir: checkPacks,
  // This test process runs (for the lead's lock, and as a bound architect's session); nothing else does.
  processes: { startTime: (pid) => (pid === process.pid ? "t" : undefined) },
});
/** The check's next exit code and duration. */
const checkWith = (config: { code?: number; ms?: number }): void => write(root, "check.json", JSON.stringify(config));
/** How many times the project check has run. */
const checks = (): string[] => existsSync(join(root, "checks.log")) ? readFileSync(join(root, "checks.log"), "utf8").trim().split("\n") : [];
const lead = (argv: string[]): Promise<{ ok: boolean; text: string; running?: true }> => {
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
  recordArchitectRunning(ticketWorktreePath(main, n), agent, { pid: process.pid, pidStarted: "t", sessionBound: true });
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
    expect(LEAD_COMMANDS.map((c) => c.name)).toEqual(["ticket create", "queue", "start", "status", "reply", "merge", "board", "sync-config", "release"]);
    expect(LEAD_COMMANDS.filter((c) => c.userOnly === true).map((c) => c.name)).toEqual(["release"]);
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
    expect((await lead(["start", String(n)])).text).toContain("is still running");
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
    expect(readPendingReply(main, n)).toMatchObject({ issue: n, agent, message: "Euros." });
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
    expect(checks()).toHaveLength(1);
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
    checkWith({ code: 1 });
    const out = await lead(["merge", String(n)]);
    expect(out.ok).toBe(false);
    expect(out.text).toContain("the project check failed");
    expect(out.text).toContain("the merge was undone");
    expect(git(main, "rev-parse", "main")).toBe(before);
    expect(git(origin, "rev-parse", "main")).toBe(before);
    expect(git(main, "status", "--porcelain")).toBe("");
    expect(issue(n)).toMatchObject({ status: "Awaiting Merge", state: "open" });
  });

  /** Someone else pushes one commit to origin/main; returns its sha. */
  const pushedElsewhere = (rel: string, content: string): string => {
    const other = join(root, "other");
    execFileSync("git", ["clone", "-q", origin, other]);
    write(other, rel, content);
    git(other, "add", "-A");
    git(other, "commit", "-q", "-m", "someone else's work");
    git(other, "push", "-q", "origin", "main");
    return git(other, "rev-parse", "HEAD");
  };

  // Issue #52: a main that is only behind origin is the lead's to bring level,
  // never the user's.
  test("merge fast-forwards a clean main that is only behind origin", async () => {
    const n = await create("A", ["contexts/a/a.contract.ts"]);
    await lead(["queue", String(n)]);
    await lead(["start", String(n)]);
    deliver(n);
    const theirs = pushedElsewhere("docs/other.md", "# Someone else's work\n");
    const out = await lead(["merge", String(n)]);
    expect(out.ok, out.text).toBe(true);
    expect(existsSync(join(main, "docs/other.md"))).toBe(true);
    expect(existsSync(join(main, `contexts/t${n}.ts`))).toBe(true);
    expect(git(main, "rev-list", "--count", `${theirs}..main`)).not.toBe("0");
    expect(git(main, "merge-base", "main", theirs)).toBe(theirs);
    expect(git(main, "rev-parse", "main")).toBe(git(origin, "rev-parse", "main"));
    expect(issue(n)).toMatchObject({ status: "Done", state: "closed" });
  });

  test("merge refuses a conflicting merge once main is level, and runs no check", async () => {
    const n = await create("A", ["contexts/a/a.contract.ts"]);
    await lead(["queue", String(n)]);
    await lead(["start", String(n)]);
    deliver(n, "README.md");
    const theirs = pushedElsewhere("README.md", "# Shop, renamed\n");
    const out = await lead(["merge", String(n)]);
    expect(out.text).toContain("does not merge cleanly");
    expect(git(main, "status", "--porcelain")).toBe("");
    expect(git(main, "rev-parse", "main")).toBe(theirs);
    expect(checks()).toEqual([]);
  });

  test("after a fast-forward, a failing check undoes to the fast-forwarded commit", async () => {
    const n = await create("A", ["contexts/a/a.contract.ts"]);
    await lead(["queue", String(n)]);
    await lead(["start", String(n)]);
    deliver(n);
    const before = git(main, "rev-parse", "main");
    const theirs = pushedElsewhere("docs/other.md", "# Someone else's work\n");
    checkWith({ code: 1 });
    const out = await lead(["merge", String(n)]);
    expect(out.ok).toBe(false);
    expect(out.text).toContain("the merge was undone");
    expect(git(main, "rev-parse", "main")).toBe(theirs);
    expect(git(main, "rev-parse", "main")).not.toBe(before);
    expect(git(origin, "rev-parse", "main")).toBe(theirs);
    expect(git(main, "status", "--porcelain")).toBe("");
    expect(issue(n)).toMatchObject({ status: "Awaiting Merge", state: "open" });
  });

  test("a diverged main is refused in product terms", async () => {
    const n = await create("A", ["contexts/a/a.contract.ts"]);
    await lead(["queue", String(n)]);
    await lead(["start", String(n)]);
    deliver(n);
    write(main, "docs/local.md", "# Made outside the harness\n");
    git(main, "add", "-A");
    git(main, "commit", "-q", "-m", "local only");
    const remote = git(origin, "rev-parse", "main");
    const out = await lead(["merge", String(n)]);
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/cannot combine/);
    expect(commandsIn(`the user: ${out.text}`)).toEqual([]);
    expect(checks()).toEqual([]);
    expect(git(origin, "rev-parse", "main")).toBe(remote);
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

describe("review fixes (ADR LEG-2026-066)", () => {
  const started = async (title: string, owns: string[]): Promise<number> => {
    const n = await create(title, owns);
    await lead(["queue", String(n)]);
    const out = await lead(["start", String(n)]);
    expect(out.ok, out.text).toBe(true);
    bind(n);
    return n;
  };

  // Regression (re-review N2): a worker resumed in the background could still change the tree being merged.
  test("merge refuses while a background worker of the ticket is held, naming it", async () => {
    const n = await started("A", ["contexts/a/"]);
    const wt = ticketWorktreePath(main, n);
    deliver(n, "contexts/a/a.ts");
    logGuardEvent(wt, { guard: "phase-gate", verdict: "pass", summary: "", detail: { kind: WORKER_RESUMED, worker: "a0000000000000w01", pid: process.pid, pidStarted: "t" } });
    const out = await lead(["merge", String(n)]);
    expect(out.ok).toBe(false);
    expect(out.text).toContain("worker a0000000000000w01");
    expect(checks()).toEqual([]);
    expect(issue(n).status).toBe("Awaiting Merge");
    logGuardEvent(wt, { guard: "phase-gate", verdict: "pass", summary: "", detail: { kind: SUBAGENT_STOPPED, agent: "a0000000000000w01" } });
    expect((await lead(["merge", String(n)])).text).not.toContain("worker a0000000000000w01");
  });

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
    expect(checks()).toEqual([]);
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
    expect(readPendingReply(main, n)).toBeUndefined();
  });

  // Regression (final review M1; re-review U1): one ticket's waiting reply
  // blocked every other ticket's; a lost seat is relaunched, never continued.
  test("replies to two tickets wait side by side; a lost seat is relaunched into its worktree", async () => {
    const a = await started("A", ["contexts/a/"]);
    const b = await started("B", ["contexts/b/"]);
    for (const n of [a, b]) recordArchitectEnded(ticketWorktreePath(main, n), readArchitectState(ticketWorktreePath(main, n))!.agent);
    expect((await lead(["reply", String(a), "one"])).ok).toBe(true);
    expect((await lead(["reply", String(b), "two"])).ok).toBe(true);
    expect(readPendingReply(main, a)?.message).toBe("one");
    expect(readPendingReply(main, b)?.message).toBe("two");
    const wt = ticketWorktreePath(main, a);
    recordArchitectRunning(wt, "a00000000000dead1", { pid: 999_999, pidStarted: "long ago", sessionBound: true });
    expect((await lead(["status"])).text).toContain(`ended with its session; relaunch it with bounded lead start ${a}`);
    expect((await lead(["reply", String(a), "after a lost session"])).text).toContain(`relaunch it with bounded lead start ${a}`);
    const relaunch = await lead(["start", String(a)]);
    expect(relaunch.text).toContain(`relaunched in its existing worktree. LAUNCH #${a}`);
    expect(readPendingLaunch(main)).toMatchObject({ issue: a, worktree: wt, brief: expect.stringContaining("Resuming: this ticket's earlier architect stopped") });
    expect(git(wt, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`ticket/${a}`);
    bind(a, "a00000000000live2");
    expect(readArchitectState(wt)).toMatchObject({ agent: "a00000000000live2", state: "running", turn: 3 });
  });

  test("a seat that stopped in a session that has since gone is relaunched by start", async () => {
    const n = await started("A", ["contexts/a/"]);
    const wt = ticketWorktreePath(main, n);
    recordArchitectRunning(wt, "a00000000000dead1", { pid: 999_999, pidStarted: "long ago", sessionBound: true });
    recordArchitectEnded(wt, "a00000000000dead1");
    expect((await lead(["status"])).text).toContain("its session has ended; relaunch it");
    expect((await lead(["start", String(n)])).text).toContain("relaunched in its existing worktree");
  });

  // Regression (re-review U3): an unrecognised session does not hold a seat as running forever.
  test("status names a seat whose session cannot be recognised, and the escape hatch", async () => {
    const n = await started("A", ["contexts/a/"]);
    const unknown: LeadDeps = { ...deps(), processes: { startTime: (pid) => (pid === process.pid ? "t" : null) } };
    recordArchitectRunning(ticketWorktreePath(main, n), "a00000000000what1", { pid: 999_999, pidStarted: "t", sessionBound: true });
    const text = (await runLeadCommand(main, { command: "status" }, unknown)).text;
    expect(text).toContain("could not be recognised, so it counts as running until its stop is recorded or the user releases it");
    expect(text).toContain(`the user (not the lead) can clear its seat with bounded lead release ${n}`);
  });

  // Regression (re-review R1 and the escape hatch).
  test("a background worker holds the gates until its session goes; status shows the hold", async () => {
    const n = await started("A", ["contexts/a/"]);
    const wt = ticketWorktreePath(main, n);
    logGuardEvent(wt, { guard: "phase-gate", verdict: "pass", summary: "", detail: { kind: WORKER_RESUMED, worker: "a0000000000000w01", pid: process.pid, pidStarted: "t" } });
    logGuardEvent(wt, { guard: "phase-gate", verdict: "pass", summary: "", detail: { kind: WORKER_RESUMED, worker: "a0000000000000w02", pid: 999_999, pidStarted: "long ago" } });
    const text = (await lead(["status"])).text;
    expect(text).toContain("gates held: worker a0000000000000w01");
    expect(text).not.toContain("a0000000000000w02");
    expect(text).toContain(`bounded lead release ${n}`);
    // Regression (re-review F1): the architect's end does not release a worker still running.
    recordArchitectEnded(wt, readArchitectState(wt)!.agent);
    expect((await lead(["status"])).text).toContain("gates held: worker a0000000000000w01");
    const refusedOut = await lead(["release", String(n)]);
    expect(refusedOut.ok).toBe(false);
    expect(refusedOut.text).toContain("worker a0000000000000w01");
    logGuardEvent(wt, { guard: "phase-gate", verdict: "pass", summary: "", detail: { kind: SUBAGENT_STOPPED, agent: "a0000000000000w01" } });
    expect((await lead(["status"])).text).not.toContain("gates held");
    expect((await lead(["release", String(n)])).ok).toBe(true);
  });

  test("release: refused while anything recorded still runs, unless forced; then every piece of seat state is cleared and logged", async () => {
    expect((await lead(["release", "9"])).text).toContain("#9 is not started");
    const n = await started("A", ["contexts/a/"]);
    const wt = ticketWorktreePath(main, n);
    logGuardEvent(wt, { guard: "phase-gate", verdict: "pass", summary: "", detail: { kind: WORKER_RESUMED, worker: "a0000000000000w01", pid: process.pid, pidStarted: "t" } });
    writePendingReply(main, { issue: n, worktree: wt, agent: "a1", message: "m", createdAt: "t" });
    const refusedOut = await lead(["release", String(n)]);
    expect(refusedOut.ok).toBe(false);
    expect(refusedOut.text).toContain("its architect (turn 1), worker a0000000000000w01");
    expect(refusedOut.text).toContain(`bounded lead release ${n} --force`);
    expect(readArchitectState(wt)).toBeDefined();
    const out = await lead(["release", String(n), "--force"]);
    expect(out.ok, out.text).toBe(true);
    expect(readArchitectState(wt)).toBeUndefined();
    expect(readPendingReply(main, n)).toBeUndefined();
    expect(backgroundWorkers(readGuardLog(wt))).toEqual([]);
    expect(readGuardLog(wt).at(-1)).toMatchObject({ detail: { kind: SEAT_RELEASED, issue: n, force: true } });
    expect(readGuardLog(main).at(-1)).toMatchObject({ detail: { kind: SEAT_RELEASED, issue: n, force: true, seat: "running", workers: ["a0000000000000w01"] } });
    // From released back to running: start relaunches into the same worktree.
    expect((await lead(["start", String(n)])).text).toContain(`LAUNCH #${n}`);
    bind(n);
    expect(readArchitectState(wt)?.state).toBe("running");
  });

  test("release without force once the recorded processes are gone clears a stale launch claim", async () => {
    const n = await create("A", ["contexts/a/"]);
    await lead(["queue", String(n)]);
    await lead(["start", String(n)]);
    writePendingLaunch(main, { ...readPendingLaunch(main)!, claimedBy: "t1", claimedAt: new Date().toISOString(), claimant: { pid: process.pid, pidStarted: "t" } });
    expect((await lead(["release", String(n)])).text).toContain("an architect launch under way");
    writePendingLaunch(main, { ...readPendingLaunch(main)!, claimant: { pid: 999_999, pidStarted: "long ago" } });
    expect((await lead(["release", String(n)])).ok).toBe(true);
    expect(readPendingLaunch(main)).toBeUndefined();
  });

  test("release is parsed only as release <issue> [--force]", () => {
    expect(parseLeadArgs(["release", "#4"])).toEqual({ ok: true, request: { command: "release", issue: 4, force: false } });
    expect(parseLeadArgs(["release", "4", "--force"])).toEqual({ ok: true, request: { command: "release", issue: 4, force: true } });
    expect(parseLeadArgs(["release", "4", "--forced"]).ok).toBe(false);
    expect(parseLeadArgs(["release"]).ok).toBe(false);
  });

  // Regression (final review M2): a claimed launch that never bound wedged the ticket.
  test("start, run again on a ticket whose launch claim never bound, releases the stale claim and says how to launch", async () => {
    const n = await create("A", ["contexts/a/"]);
    await lead(["queue", String(n)]);
    await lead(["start", String(n)]);
    writePendingLaunch(main, { ...readPendingLaunch(main)!, claimedBy: "t1", claimedAt: new Date().toISOString(), claimant: { pid: process.pid, pidStarted: "t" } });
    expect((await lead(["status"])).text).toContain("launch under way");
    expect((await lead(["start", String(n)])).text).toContain("launch is under way");
    writePendingLaunch(main, { ...readPendingLaunch(main)!, claimant: { pid: 999_999, pidStarted: "long ago" } });
    expect((await lead(["status"])).text).toContain(`never bound to the worktree; run bounded lead start ${n}`);
    expect((await lead(["start", String(n)])).text).toContain(`LAUNCH #${n}`);
    expect(readPendingLaunch(main)?.claimedBy).toBeUndefined();
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

// Issue #52 (ADR LEG-2026-072): generated config that drifted is restored by the
// lead, in the ticket's own worktree, once the user agrees; never by the user.
describe("sync-config: the lead restores a ticket's generated config", () => {
  const started = async (title: string, owns: string[]): Promise<number> => {
    const n = await create(title, owns);
    await lead(["queue", String(n)]);
    const out = await lead(["start", String(n)]);
    expect(out.ok, out.text).toBe(true);
    bind(n);
    return n;
  };
  const stopped = async (title: string, owns: string[]): Promise<number> => {
    const n = await started(title, owns);
    const wt = ticketWorktreePath(main, n);
    recordArchitectEnded(wt, readArchitectState(wt)!.agent);
    return n;
  };

  test("sync-config parses only with an issue", () => {
    expect(parseLeadArgs(["sync-config", "7"])).toEqual({ ok: true, request: { command: "sync-config", issue: 7 } });
    expect(parseLeadArgs(["sync-config", "#7"])).toEqual({ ok: true, request: { command: "sync-config", issue: 7 } });
    for (const argv of [["sync-config"], ["sync-config", "x"], ["sync-config", "7", "8"]]) expect(parseLeadArgs(argv).ok, argv.join(" ")).toBe(false);
    expect(LEAD_COMMANDS.find((c) => c.name === "sync-config")).toMatchObject({ usage: "bounded lead sync-config <issue>" });
    expect(LEAD_COMMANDS.find((c) => c.name === "sync-config")?.userOnly).toBeUndefined();
  });

  test("sync-config runs in the ticket's worktree", async () => {
    const n = await stopped("A", ["contexts/a/"]);
    const out = await lead(["sync-config", String(n)]);
    expect(out.ok, out.text).toBe(true);
    expect(syncConfig).toHaveBeenCalledTimes(1);
    expect(syncConfig).toHaveBeenCalledWith(ticketWorktreePath(main, n));
    expect(out.text).toContain("sync-config: OK — 3 files restored");
    // A failed sync is a refusal with its output.
    syncConfig.mockReturnValueOnce({ ok: false, output: "sync-config: BLOCK — the lockfile cannot be derived" });
    const failed = await lead(["sync-config", String(n)]);
    expect(failed.ok).toBe(false);
    expect(failed.text).toContain("the lockfile cannot be derived");
  });

  test("sync-config refuses an unstarted ticket and one whose architect is running", async () => {
    expect((await lead(["sync-config", "99"])).text).toContain("#99 is not started");
    const n = await started("A", ["contexts/a/"]);
    const running = await lead(["sync-config", String(n)]);
    expect(running.ok).toBe(false);
    expect(running.text).toMatch(/architect is still running/);
    const wt = ticketWorktreePath(main, n);
    recordArchitectEnded(wt, readArchitectState(wt)!.agent);
    logGuardEvent(wt, { guard: "phase-gate", verdict: "pass", summary: "", detail: { kind: WORKER_RESUMED, worker: "a0000000000000w01", pid: process.pid, pidStarted: "t" } });
    const held = await lead(["sync-config", String(n)]);
    expect(held.ok).toBe(false);
    expect(held.text).toContain("worker a0000000000000w01");
    expect(syncConfig).not.toHaveBeenCalled();
  });

  test("sync-config on a ticket Awaiting Merge reopens it to Building and clears its delivery snapshot", async () => {
    const n = await started("A", ["contexts/a/"]);
    deliver(n, "contexts/a/a.ts");
    expect(issue(n).status).toBe("Awaiting Merge");
    const out = await lead(["sync-config", String(n)]);
    expect(out.ok, out.text).toBe(true);
    expect(out.text).toMatch(/reopened to Building/);
    expect(issue(n).status).toBe("Building");
    expect(readDeliverySnapshot(ticketWorktreePath(main, n))).toBeUndefined();
    tracker.setStatus(n, "Awaiting Merge");
    expect((await lead(["merge", String(n)])).text).toContain("records no delivered tree");
  });

  test("the default sync-config resolves one contribution from the harness packs directory", async () => {
    const n = await stopped("A", ["contexts/a/"]);
    const wt = ticketWorktreePath(main, n);
    const packs = join(root, "packs");
    const pack = (name: string, manifest: Record<string, unknown>): void => {
      write(packs, `${name}/contrib.json`, JSON.stringify(manifest));
      write(packs, `${name}/s.ts`, `console.log("restored by ${name} in " + process.argv[2]);\n`);
    };
    const composed = (...names: string[]): void => write(wt, ".bounded/composed-packs.json", JSON.stringify(names));
    const sync = (): Promise<{ ok: boolean; text: string }> => {
      const { syncConfig: _spy, ...real } = deps();
      return runLeadCommand(main, { command: "sync-config", issue: n } as LeadRequest, { ...real, packsDir: packs } as LeadDeps);
    };

    pack("fake", { projectConfigSyncCommand: "sync-config", projectCommands: { "sync-config": "s.ts" } });
    composed("fake");
    const out = await sync();
    expect(out.ok, out.text).toBe(true);
    expect(out.text).toContain(`restored by fake in ${wt}`);

    pack("plain", { projectCommands: { other: "s.ts" } });
    composed("plain");
    expect((await sync()).text).toMatch(/no composed capability restores project config/);

    pack("second", { projectConfigSyncCommand: "again", projectCommands: { again: "s.ts" } });
    composed("fake", "second");
    expect((await sync()).text).toMatch(/more than one/);

    pack("broken", { projectConfigSyncCommand: 3, projectCommands: { "sync-config": "s.ts" } });
    composed("broken");
    expect((await sync()).text).toContain("'broken'");
    pack("dangling", { projectConfigSyncCommand: "restore", projectCommands: { "sync-config": "s.ts" } });
    composed("dangling");
    expect((await sync()).text).toContain("'dangling'");
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

// Issue #53 (ADR LEG-2026-073): the project check behind a merge runs as a
// background job, so a check that outlasts the host's command limit finishes
// over repeated merges. Local main is never left unsafe: the merge is recorded
// before git merges, and adopted, collected, undone or refused by the rules
// the cases below name. A deadline of 16000 ms gives each call a 1000 ms budget.
describe("a merge whose check outlasts the call", () => {
  const DEADLINE = "16000";
  const deadline = (): void => { vi.stubEnv("BOUNDED_COMMAND_TIMEOUT_MS", DEADLINE); };
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  beforeEach(() => { vi.stubEnv("BOUNDED_COMMAND_TIMEOUT_MS", undefined); });

  const delivered = async (title = "A", owns = ["contexts/a/"]): Promise<number> => {
    const n = await create(title, owns);
    await lead(["queue", String(n)]);
    const out = await lead(["start", String(n)]);
    expect(out.ok, out.text).toBe(true);
    bind(n);
    deliver(n, `${owns[0]}${title.toLowerCase()}.ts`);
    return n;
  };
  /** Merge until the answer is not RUNNING: every 500 ms, up to 40 times. */
  const pollMerge = async (n: number): Promise<{ ok: boolean; text: string; running?: true }> => {
    let out = await lead(["merge", String(n)]);
    for (let i = 0; i < 40 && out.running === true; i++) {
      await sleep(500);
      out = await lead(["merge", String(n)]);
    }
    return out;
  };
  const phase = (n: number): string | undefined => readStartedTicket(main, n)?.phase;
  const groupGone = async (pid: number): Promise<void> => {
    for (let i = 0; i < 100; i++) {
      try { process.kill(-pid, 0); } catch { return; }
      await sleep(100);
    }
  };

  test("a merge whose check outlasts the call answers RUNNING and finishes on a later merge", async () => {
    const n = await delivered();
    const before = git(origin, "rev-parse", "main");
    checkWith({ ms: 3000 });
    deadline();
    const first = await lead(["merge", String(n)]);
    expect(first.ok).toBe(false);
    expect(first.running).toBe(true);
    expect(first.text).toMatch(/check.*running/);
    expect(git(main, "log", "-1", "--format=%s")).toBe(`Merge #${n}: A`);
    expect(git(origin, "rev-parse", "main")).toBe(before);
    expect(phase(n)).toBe("merging");
    const last = await pollMerge(n);
    expect(last.ok, last.text).toBe(true);
    expect(git(origin, "rev-parse", "main")).toBe(git(main, "rev-parse", "main"));
    expect(issue(n)).toMatchObject({ status: "Done", state: "closed" });
    expect(existsSync(ticketWorktreePath(main, n))).toBe(false);
    expect(issue(n).comments.filter((c) => /check/.test(c))).toHaveLength(1);
    expect(readGuardLog(main).some((e) => e.guard === "team-lead" && e.verdict === "running")).toBe(true);
  }, 60_000);

  test("without a deadline the check runs to its end in one call", async () => {
    const n = await delivered();
    checkWith({ ms: 1500 });
    const out = await lead(["merge", String(n)]);
    expect(out.ok, out.text).toBe(true);
    expect(checks()).toHaveLength(1);
  }, 30_000);

  test("a failing check collected later undoes the merge", async () => {
    const n = await delivered();
    const before = git(main, "rev-parse", "main");
    checkWith({ ms: 2000, code: 1 });
    deadline();
    expect((await lead(["merge", String(n)])).running).toBe(true);
    const last = await pollMerge(n);
    expect(last.ok).toBe(false);
    expect(last.text).toContain("the merge was undone");
    expect(git(main, "rev-parse", "main")).toBe(before);
    expect(git(origin, "rev-parse", "main")).toBe(before);
    expect(issue(n).status).toBe("Awaiting Merge");
    expect(phase(n)).not.toBe("merging");
  }, 60_000);

  test("a check that never completes undoes the merge as a harness bug and pushes nothing", async () => {
    const n = await delivered();
    const before = git(main, "rev-parse", "main");
    checkWith({ ms: 30_000 });
    deadline();
    let out = await lead(["merge", String(n)]);
    expect(out.running).toBe(true);
    for (let death = 1; death <= 3 && out.running === true; death++) {
      const pid = jobPids().at(-1)!;
      process.kill(-pid, "SIGKILL");
      await groupGone(pid);
      out = await lead(["merge", String(n)]);
    }
    expect(out.running).toBeUndefined();
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/did not complete/);
    expect(out.text).toMatch(/harness bug/);
    expect(git(main, "rev-parse", "main")).toBe(before);
    expect(git(origin, "rev-parse", "main")).toBe(before);
  }, 60_000);

  test("the merging record is written after the fast-forward", async () => {
    const n = await delivered();
    const other = join(root, "other");
    execFileSync("git", ["clone", "-q", origin, other]);
    write(other, "docs/other.md", "# Someone else's work\n");
    git(other, "add", "-A");
    git(other, "commit", "-q", "-m", "someone else's work");
    git(other, "push", "-q", "origin", "main");
    const theirs = git(other, "rev-parse", "HEAD");
    checkWith({ ms: 3000, code: 1 });
    deadline();
    expect((await lead(["merge", String(n)])).running).toBe(true);
    expect(readStartedTicket(main, n)).toMatchObject({ phase: "merging", merging: { local: theirs } });
    const last = await pollMerge(n);
    expect(last.text).toContain("the merge was undone");
    expect(git(main, "rev-parse", "main")).toBe(theirs);
  }, 60_000);

  test("while a merge is being checked, start, another merge, its reply and its sync-config refuse, and status names it", async () => {
    const n = await delivered();
    const m = await create("B", ["contexts/b/"]);
    await lead(["queue", String(m)]);
    checkWith({ ms: 3000 });
    deadline();
    expect((await lead(["merge", String(n)])).running).toBe(true);
    expect((await lead(["start", String(m)])).text).toMatch(/being merged/);
    expect((await lead(["merge", String(m)])).text).toMatch(/being merged/);
    expect((await lead(["reply", String(n), "x"])).text).toMatch(/being merged/);
    expect((await lead(["sync-config", String(n)])).text).toMatch(/being merged/);
    const status = (await lead(["status"])).text;
    expect(status).toContain(`#${n}`);
    expect(status).toMatch(/being merged/);
  }, 60_000);

  test("a merge interrupted right after git merge is adopted, not merged twice", async () => {
    const n = await delivered();
    let interrupted = false;
    const flaky: LeadDeps = {
      ...deps(),
      git: (args, cwd) => {
        const run = gitCommandLine(args, cwd);
        if (!interrupted && args[0] === "merge" && args.includes("--no-ff") && run.status === 0) {
          interrupted = true;
          throw new Error("the process was interrupted");
        }
        return run;
      },
    };
    const first = await runLeadCommand(main, { command: "merge", issue: n }, flaky);
    expect(first.ok).toBe(false);
    const out = await lead(["merge", String(n)]);
    expect(out.ok, out.text).toBe(true);
    expect(git(main, "log", "--format=%s", "main").split("\n").filter((s) => s === `Merge #${n}: A`)).toHaveLength(1);
    expect(git(origin, "rev-parse", "main")).toBe(git(main, "rev-parse", "main"));
  }, 30_000);

  test("an untracked file in main never blocks the merge", async () => {
    const n = await delivered();
    checkWith({ ms: 3000 });
    deadline();
    expect((await lead(["merge", String(n)])).running).toBe(true);
    write(main, "stray.txt", "left by someone\n");
    const last = await pollMerge(n);
    expect(last.ok, last.text).toBe(true);
    expect(existsSync(join(main, "stray.txt"))).toBe(true);
  }, 60_000);

  test("a tracked change in main during the check undoes the merge", async () => {
    const n = await delivered();
    const before = git(main, "rev-parse", "main");
    checkWith({ ms: 3000 });
    deadline();
    expect((await lead(["merge", String(n)])).running).toBe(true);
    write(main, "README.md", "# Shop, edited mid-check\n");
    const last = await pollMerge(n);
    expect(last.ok).toBe(false);
    expect(last.text).toMatch(/main changed while its check ran/);
    expect(last.text).toContain("the merge was undone");
    expect(git(main, "rev-parse", "main")).toBe(before);
    expect(readFileSync(join(main, "README.md"), "utf8")).toBe("# Shop\n");
  }, 60_000);

  test("a main that moved off the merge refuses and touches nothing; release keeps the phase", async () => {
    const n = await delivered();
    const before = git(origin, "rev-parse", "main");
    checkWith({ ms: 3000 });
    deadline();
    expect((await lead(["merge", String(n)])).running).toBe(true);
    git(main, "commit", "-q", "--allow-empty", "-m", "x");
    const moved = git(main, "rev-parse", "HEAD");
    const last = await pollMerge(n);
    expect(last.ok).toBe(false);
    expect(last.text).toMatch(/moved off the merge/);
    expect(git(main, "rev-parse", "HEAD")).toBe(moved);
    expect(git(origin, "rev-parse", "main")).toBe(before);
    const release = await lead(["release", String(n), "--force"]);
    expect(release.ok).toBe(false);
    expect(release.text).toMatch(/cannot undo/);
    expect(phase(n)).toBe("merging");
    expect(git(main, "rev-parse", "HEAD")).toBe(moved);
  }, 60_000);

  test("release stops a merging ticket's check and undoes the merge", async () => {
    const n = await delivered();
    const before = git(main, "rev-parse", "main");
    checkWith({ ms: 30_000 });
    deadline();
    expect((await lead(["merge", String(n)])).running).toBe(true);
    const refused = await lead(["release", String(n)]);
    expect(refused.ok).toBe(false);
    expect(refused.text).toMatch(/still running/);
    expect(refused.text).toMatch(/cannot prove|cannot tell/);
    const out = await lead(["release", String(n), "--force"]);
    expect(out.ok, out.text).toBe(true);
    expect(git(main, "rev-parse", "main")).toBe(before);
    expect(phase(n)).not.toBe("merging");
    expect(listJobs(main)).toEqual([]);
  }, 60_000);

  test("merge refuses a live gate job in the worktree and clears a finished one", async () => {
    const n = await delivered();
    const wt = ticketWorktreePath(main, n);
    const job = await runOrCollect(
      { cwd: wt, name: "gate-green-gate", key: "green-gate", argv: [process.execPath, "-e", "setTimeout(() => {}, 3000)"] },
      { deadlineMs: Number(DEADLINE) },
    );
    expect(job.state).toBe("running");
    const status = (await lead(["status"])).text;
    expect(status).toContain("green-gate");
    expect(status).toMatch(/background/);
    expect((await lead(["merge", String(n)])).text).toMatch(/green-gate/);
    await sleep(4000);
    checkWith({ ms: 3000 });
    deadline();
    expect((await lead(["merge", String(n)])).running).toBe(true);
    expect(listJobs(wt)).toEqual([]);
  }, 60_000);

  test("sync-config refuses a ticket with an uncollected gate job", async () => {
    const n = await delivered();
    const wt = ticketWorktreePath(main, n);
    const job = await runOrCollect(
      { cwd: wt, name: "gate-green-gate", key: "green-gate", argv: [process.execPath, "-e", "setTimeout(() => {}, 300)"] },
      { deadlineMs: Number(DEADLINE) },
    );
    expect(["running", "done"]).toContain(job.state);
    await sleep(1500);
    const out = await lead(["sync-config", String(n)]);
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/green-gate/);
  }, 30_000);

  // Review minor 4: a main already back at the recorded commit is a merge
  // already undone; the record is settled and the merge can start afresh.
  test("a main already reset to the pre-merge commit settles the record; merge and release go on", async () => {
    const n = await delivered();
    const before = git(main, "rev-parse", "main");
    checkWith({ ms: 3000 });
    deadline();
    expect((await lead(["merge", String(n)])).running).toBe(true);
    git(main, "reset", "-q", "--hard", before);
    const out = await pollMerge(n);
    expect(out.ok, out.text).toBe(true);
    expect(git(origin, "rev-parse", "main")).toBe(git(main, "rev-parse", "main"));

    const m = await delivered("B", ["contexts/b/"]);
    const beforeB = git(main, "rev-parse", "main");
    checkWith({ ms: 30_000 });
    expect((await lead(["merge", String(m)])).running).toBe(true);
    git(main, "reset", "-q", "--hard", beforeB);
    const release = await lead(["release", String(m), "--force"]);
    expect(release.ok, release.text).toBe(true);
    expect(phase(m)).not.toBe("merging");
    expect(git(main, "rev-parse", "main")).toBe(beforeB);
  }, 90_000);

  // Review minor 5: a check that could not be stopped still runs over the
  // merge, so the merge is not undone under it.
  test("a check that could not be stopped leaves the merge in place, as a harness bug", async () => {
    const n = await delivered();
    checkWith({ ms: 30_000 });
    deadline();
    expect((await lead(["merge", String(n)])).running).toBe(true);
    const merged = git(main, "rev-parse", "HEAD");
    const stuck: LeadDeps = { ...deps(), jobs: { now: () => Date.now() + 66 * 60_000, kill: () => true, graceMs: 200 } };
    const out = await runLeadCommand(main, { command: "merge", issue: n }, stuck);
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/could not be stopped/);
    expect(out.text).toMatch(/harness bug/);
    expect(out.text).not.toMatch(/the merge was undone/);
    expect(git(main, "rev-parse", "HEAD")).toBe(merged);
    expect(phase(n)).toBe("merging");
  }, 60_000);
});
