import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readArchitectState, type ArchitectHost } from "./architect-launch.ts";
import {
  gitCommandLine, LEAD_COMMANDS, parseLeadArgs, runLeadCommand, type LeadDeps, type LeadRequest,
} from "./lead-commands.ts";
import { readStartedTicket, readTicketMarker, ticketWorktreePath } from "./ticket-worktree.ts";
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
let spawn: ReturnType<typeof vi.fn<(command: string, args: readonly string[], cwd: string) => number>>;
let hostSpecs: { message: string; resume: boolean }[];

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const write = (dir: string, rel: string, content: string): void => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), content);
};

const HOST: ArchitectHost = {
  name: "test", model: (p) => p,
  command(spec) {
    hostSpecs.push({ message: spec.message, resume: spec.resume });
    return { command: process.execPath, args: ["-e", "0"], env: {} };
  },
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
  spawn = vi.fn(() => 2 ** 22 + 1);
  hostSpecs = [];
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const deps = (): LeadDeps => ({
  tracker: () => tracker, git: gitCommandLine, host: async () => HOST, setup, check, spawn, alive: () => false,
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
/** What a delivered ticket worktree holds: its product files and a final delivery. */
const deliver = (n: number, rel = `contexts/t${n}.ts`): void => {
  const wt = ticketWorktreePath(main, n);
  write(wt, rel, `export const t${n} = ${n};\n`);
  write(wt, ".bounded/guard-log.jsonl", logLines(prepared(String(n)), runStart, delivered));
  tracker.setStatus(n, "Awaiting Merge");
};

describe("parseLeadArgs — one parser for every host", () => {
  test("every command's usage is a shape the parser knows", () => {
    expect(LEAD_COMMANDS.map((c) => c.name)).toEqual(["ticket create", "queue", "start", "status", "reply", "merge"]);
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
    expect(readTicketMarker(wt)).toEqual({ issue: n, branch: `ticket/${n}`, main });
    expect(readFileSync(join(wt, ".bounded/active-ticket"), "utf8")).toBe(`${n}\n`);
    expect(setup).toHaveBeenCalledWith(wt);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(hostSpecs[0]).toMatchObject({ resume: false, message: expect.stringContaining(`Ticket #${n}: Invoices`) });
    expect(issue(n).status).toBe("In Design");
    expect(readStartedTicket(main, n)).toMatchObject({ owns: ["contexts/billing/invoice.contract.ts"], worktree: wt });
    expect(git(main, "status", "--porcelain")).toBe("");
    expect((await lead(["start", String(n)])).text).toMatch(/is In Design|already has a worktree/);
  });

  test("start refuses a ticket still waiting on a dependency, and two parallel tickets owning one contract path", async () => {
    const a = await create("A", ["contexts/shared/"]);
    const b = await create("B", ["contexts/shared/money.contract.ts"]);
    const c = await create("C", ["contexts/c/c.contract.ts"], [String(a)]);
    for (const n of [a, b, c]) await lead(["queue", String(n)]);
    expect((await lead(["start", String(c)])).text).toContain(`still waiting on #${a}`);
    expect((await lead(["start", String(a)])).ok).toBe(true);
    const conflict = await lead(["start", String(b)]);
    expect(conflict.text).toContain(`overlaps 'contexts/shared/' owned by started ticket #${a}`);
    expect(existsSync(ticketWorktreePath(main, b))).toBe(false);
    expect(issue(b).status).toBe("Queued");
  });

  test("a start that cannot set up, or cannot launch, removes its worktree and branch and leaves the ticket Queued", async () => {
    const n = await create("A", ["contexts/a/a.contract.ts"]);
    await lead(["queue", String(n)]);
    setup.mockResolvedValueOnce({ ok: false, summary: "bun install failed" });
    expect((await lead(["start", String(n)])).text).toContain("not started — bun install failed");
    spawn.mockImplementationOnce(() => { throw new Error("no host"); });
    expect((await lead(["start", String(n)])).text).toContain("no host");
    expect(existsSync(ticketWorktreePath(main, n))).toBe(false);
    expect(git(main, "branch", "--list", `ticket/${n}`)).toBe("");
    expect(issue(n).status).toBe("Queued");
    expect(readStartedTicket(main, n)).toBeUndefined();
  });

  test("status shows each started ticket's board state and its architect's report; reply continues the same session", async () => {
    const n = await create("A", ["contexts/a/a.contract.ts"]);
    await lead(["queue", String(n)]);
    await lead(["start", String(n)]);
    const wt = ticketWorktreePath(main, n);
    write(wt, ".bounded/architect/turn-1.out", "Design frozen.\nDecision needed: which currency?\n");
    tracker.addLabel(n, "blocked: architect");
    const status = await lead(["status"]);
    expect(status.text).toContain(`#${n} A — In Design (blocked: architect)`);
    expect(status.text).toContain("  > Decision needed: which currency?");
    const reply = await lead(["reply", String(n), "Euros."]);
    expect(reply.ok, reply.text).toBe(true);
    expect(hostSpecs[1]).toEqual({ message: "Euros.", resume: true });
    expect(readArchitectState(wt)).toMatchObject({ turn: 2 });
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
    tracker.failAfter = 3; // check, view, then the Done update fails
    const out = await lead(["merge", String(n)]);
    expect(out.ok).toBe(false);
    expect(out.text).toContain("merged, checked and pushed, but the board update is pending");
    tracker.failAfter = undefined;
    await lead(["status"]);
    expect(issue(n)).toMatchObject({ status: "Done", state: "closed" });
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
