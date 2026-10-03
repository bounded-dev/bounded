import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { decideLead, decideScout, seatMayHold, type SeatAction } from "./lead-policy.ts";
import { resolveSessionRole, type SessionFacts, type SessionSeat } from "./session-role.ts";
import type { TempProject } from "../test/support/temp-project.ts";
import { delivered, LOG, logLines, makeLeadProject, prepared, runStart } from "../test/support/lead-project.ts";

const projects: TempProject[] = [];
function project(files: Readonly<Record<string, string>> = {}): string {
  const p = makeLeadProject(files);
  projects.push(p);
  return p.dir;
}
afterEach(() => {
  vi.unstubAllEnvs();
  while (projects.length) projects.pop()?.cleanup();
});

const commission = (role: unknown, task: unknown = "investigate"): SeatAction => ({ kind: "commission", role, task });

describe("decideLead — the lead's decision table", () => {
  const cases: readonly (readonly [string, SeatAction, boolean, string?])[] = [
    ["a project read", { kind: "read", tool: "read", input: { path: "src/a.ts" } }, true],
    ["a read of .git", { kind: "read", tool: "read", input: { path: ".git/config" } }, false, ".git"],
    ["a read outside the project", { kind: "read", tool: "read", input: { path: "/etc/passwd" } }, false],
    ["an unscoped search", { kind: "read", tool: "grep", input: {} }, false, "unscoped"],
    ["a lookup", { kind: "lookup", tool: "web_search" }, true],
    ["watching a child", { kind: "observe", tool: "wait" }, true],
    ["a lead command", { kind: "lead-command", command: "start" }, true],
    ["a shape the host refused", { kind: "refused", reason: "subagent chain hides individual commissions" }, false, "chain hides"],
    ["an edit", { kind: "other", tool: "edit" }, false, "outside the read-only lead toolset"],
    ["a scout", commission("scout"), true],
    ["a builder", commission("builder"), false, "only the scout"],
    ["a delegate", commission("delegate"), false, "only the scout"],
    ["no role", commission(undefined), false, "only the scout"],
    ["an empty task", commission("scout", "  "), false, "needs a task"],
    ["a missing task", { kind: "commission", role: "scout", task: undefined }, false, "needs a task"],
    ["an architect", commission("architect"), false, "only through `bounded lead start <issue>`"],
  ];
  for (const [name, action, allow, why] of cases) test(name, () => {
    const decision = decideLead(action, project());
    expect(decision.allow).toBe(allow);
    if (!decision.allow) {
      expect(decision.reason.startsWith("team-lead: ")).toBe(true);
      if (why !== undefined) expect(decision.reason).toContain(why);
    }
  });

  test("an architect is never commissioned by the lead, even with a prepared run (ADR 2026-066)", () => {
    const dir = project({ ".bounded/active-ticket": "3\n", [LOG]: logLines(prepared("3")) });
    expect(decideLead(commission("architect"), dir).allow).toBe(false);
    writeFileSync(join(dir, LOG), logLines(prepared("3"), runStart, delivered));
    expect(decideLead(commission("architect"), dir).allow).toBe(false);
  });

  test("setup stops once a ticket has been started in its own worktree", () => {
    const dir = project({ ".bounded/lead/tickets/4.json": "{}\n" });
    expect(decideLead({ kind: "setup" }, dir)).toMatchObject({ allow: false });
  });

  test("setup only before the first run", () => {
    const fresh = project();
    expect(decideLead({ kind: "setup" }, fresh).allow).toBe(true);
    const started = project({ ".bounded/active-ticket": "1\n", [LOG]: logLines(prepared("1"), runStart) });
    expect(decideLead({ kind: "setup" }, started)).toMatchObject({ allow: false });
  });
});

describe("decideScout — reads only", () => {
  test.each([
    [{ kind: "read", tool: "grep", input: { path: "src" } } as SeatAction, true],
    [{ kind: "observe", tool: "contact_supervisor" } as SeatAction, true],
    [{ kind: "read", tool: "read", input: { path: ".git/HEAD" } } as SeatAction, false],
    [{ kind: "lookup", tool: "web_fetch" } as SeatAction, false],
    [{ kind: "other", tool: "bash" } as SeatAction, false],
    [commission("scout"), false],
    [{ kind: "lead-command", command: "status" } as SeatAction, false],
    [{ kind: "setup" } as SeatAction, false],
  ])("%j → %s", (action, allow) => {
    const decision = decideScout(action, project());
    expect(decision.allow).toBe(allow);
    if (!decision.allow) expect(decision.reason.startsWith("scout: ")).toBe(true);
  });
});

describe("reads through links", () => {
  test("the lead and the scout cannot follow a link out of the project or into .git", () => {
    const dir = project({ "src/a.ts": "", ".git/config": "" });
    const outside = mkdtempSync(join(tmpdir(), "lead-outside-"));
    try {
      writeFileSync(join(outside, "passwd"), "x");
      symlinkSync(outside, join(dir, "lnk"));
      symlinkSync(join(dir, ".git"), join(dir, "g"));
      for (const decideSeat of [decideLead, decideScout]) {
        for (const input of [{ path: "lnk/passwd" }, { path: "g/config" }]) {
          expect(decideSeat({ kind: "read", tool: "read", input }, dir).allow, JSON.stringify(input)).toBe(false);
        }
        expect(decideSeat({ kind: "read", tool: "grep", input: { path: "lnk" } }, dir).allow).toBe(false);
        expect(decideSeat({ kind: "read", tool: "read", input: { path: "src/a.ts" } }, dir).allow).toBe(true);
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("seatMayHold — what each seat is shown", () => {
  test("the lead sees reads, lookups, commissions and its commands; the scout only reads and reports", () => {
    const dir = project();
    const read: SeatAction = { kind: "read", tool: "read", input: {} };
    expect(seatMayHold("lead", read, dir)).toBe(true);
    expect(seatMayHold("lead", commission(undefined, undefined), dir)).toBe(true);
    expect(seatMayHold("lead", { kind: "other", tool: "write" }, dir)).toBe(false);
    expect(seatMayHold("lead", { kind: "setup" }, dir)).toBe(true);
    expect(seatMayHold("scout", read, dir)).toBe(true);
    expect(seatMayHold("lead", { kind: "lead-command", command: "merge" }, dir)).toBe(true);
    expect(seatMayHold("scout", { kind: "lead-command", command: "merge" }, dir)).toBe(false);
  });
});

describe("resolveSessionRole — one seat resolution for both hosts", () => {
  const base: SessionFacts = { projectLocal: false, child: false, judgedElsewhere: false, ambientRole: () => undefined };
  const seats: readonly (readonly [string, Partial<SessionFacts>, SessionSeat])[] = [
    ["bound pipeline role", { boundSeat: "builder" }, { kind: "role", role: "builder", bound: true }],
    ["bound role never stands down", { boundSeat: "builder", judgedElsewhere: true }, { kind: "role", role: "builder", bound: true }],
    ["bound scout", { boundSeat: "scout" }, { kind: "scout", bound: true }],
    ["unknown binding in a project fails closed", { boundSeat: "delegate", projectLocal: true }, { kind: "scout", bound: false }],
    ["project main session is the lead", { projectLocal: true }, { kind: "lead" }],
    ["unbound project child is held read-only", { projectLocal: true, child: true }, { kind: "scout", bound: false }],
    ["a ticket worktree's own session is read-only unless launched as its architect", { projectLocal: true, ticketWorktree: true }, { kind: "scout", bound: false }],
    ["the launched architect of a ticket worktree", { projectLocal: true, ticketWorktree: true, boundSeat: "architect" }, { kind: "role", role: "architect", bound: true }],
    ["a child bound elsewhere stands down", { projectLocal: true, child: true, judgedElsewhere: true }, { kind: "none" }],
    ["ambient role outside a project", { ambientRole: () => "architect" }, { kind: "role", role: "architect", bound: false }],
    ["ambient stands down for a bound child", { ambientRole: () => "architect", judgedElsewhere: true }, { kind: "none" }],
    ["nothing to judge", {}, { kind: "none" }],
  ];
  for (const [name, facts, seat] of seats) test(name, () => {
    expect(resolveSessionRole({ ...base, ...facts })).toEqual(seat);
  });

  test("an unknown binding outside a project is said out loud and inert", () => {
    expect(resolveSessionRole({ ...base, boundSeat: "delegate" })).toMatchObject({ kind: "none", note: expect.stringContaining("delegate") });
  });
});

// #47: a read-only seat borrows the architect's read zone, but its refusal
// names the seat that was refused, not the architect.
describe("read refusals name the seat", () => {
  test("a read-only seat's read refusal names the seat, not the architect", () => {
    const dir = project({ "src/a.ts": "" });
    const outside = mkdtempSync(join(tmpdir(), "lead-outside-"));
    try {
      writeFileSync(join(outside, "x"), "x");
      symlinkSync(outside, join(dir, "lnk"));
      symlinkSync(dir, join(dir, "src/root"));
      const read = (path: string): SeatAction => ({ kind: "read", tool: "read", input: { path } });
      for (const [decideSeat, seat] of [[decideScout, "scout"], [decideLead, "team-lead"]] as const) {
        const asWritten = decideSeat(read("/etc/hosts"), dir);
        expect(asWritten.allow).toBe(false);
        const why = asWritten.allow ? "" : asWritten.reason;
        expect(why.startsWith(`${seat}: may not read '/etc/hosts'`), why).toBe(true);
        expect(why).not.toContain("architect");
        const resolved = decideSeat(read("lnk/x"), dir);
        expect(resolved.allow).toBe(false);
        const whyResolved = resolved.allow ? "" : resolved.reason;
        expect(whyResolved.startsWith(`${seat}: `), whyResolved).toBe(true);
        expect(whyResolved).not.toContain("architect");
        // Final review: a link out of the project is refused before the second
        // decide() runs. A link to the project root reaches it: as written the
        // search is scoped, resolved it searches the root.
        const root = decideSeat({ kind: "read", tool: "grep", input: { path: "src/root" } }, dir);
        expect(root.allow).toBe(false);
        const whyRoot = root.allow ? "" : root.reason;
        expect(whyRoot.startsWith(`${seat}: may not search '.'`), whyRoot).toBe(true);
        expect(whyRoot).not.toContain("architect");
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
