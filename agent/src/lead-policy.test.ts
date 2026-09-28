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
    ["preparing a run", { kind: "prepare" }, true],
    ["a shape the host refused", { kind: "refused", reason: "subagent chain hides individual commissions" }, false, "chain hides"],
    ["an edit", { kind: "other", tool: "edit" }, false, "outside the read-only lead toolset"],
    ["a scout", commission("scout"), true],
    ["a builder", commission("builder"), false, "only scout and architect"],
    ["a delegate", commission("delegate"), false, "only scout and architect"],
    ["no role", commission(undefined), false, "only scout and architect"],
    ["an empty task", commission("scout", "  "), false, "needs a task"],
    ["a missing task", { kind: "commission", role: "scout", task: undefined }, false, "needs a task"],
    ["an architect before any run is prepared", commission("architect"), false, "prepare the ticket's run boundary"],
  ];
  for (const [name, action, allow, why] of cases) test(name, () => {
    const decision = decideLead(action, project());
    expect(decision.allow).toBe(allow);
    if (!decision.allow) {
      expect(decision.reason.startsWith("team-lead: ")).toBe(true);
      if (why !== undefined) expect(decision.reason).toContain(why);
    }
  });

  test("the architect becomes commissionable once the run is prepared, and not after delivery", () => {
    const dir = project({ ".bounded/active-ticket": "3\n", [LOG]: logLines(prepared("3")) });
    expect(decideLead(commission("architect"), dir).allow).toBe(true);
    writeFileSync(join(dir, LOG), logLines(prepared("3"), runStart, delivered));
    expect(decideLead(commission("architect"), dir).allow).toBe(false);
  });

  test("a preparation for another ticket does not count", () => {
    const dir = project({ ".bounded/active-ticket": "3\n", [LOG]: logLines(prepared("2")) });
    expect(decideLead(commission("architect"), dir).allow).toBe(false);
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
    [{ kind: "prepare" } as SeatAction, false],
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
  test("the lead sees reads, lookups, commissions and preparation; the scout only reads and reports", () => {
    const dir = project();
    const read: SeatAction = { kind: "read", tool: "read", input: {} };
    expect(seatMayHold("lead", read, dir)).toBe(true);
    expect(seatMayHold("lead", commission(undefined, undefined), dir)).toBe(true);
    expect(seatMayHold("lead", { kind: "other", tool: "write" }, dir)).toBe(false);
    expect(seatMayHold("lead", { kind: "setup" }, dir)).toBe(true);
    expect(seatMayHold("scout", read, dir)).toBe(true);
    expect(seatMayHold("scout", { kind: "prepare" }, dir)).toBe(false);
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
