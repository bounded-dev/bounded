import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import { readGuardLog } from "./guard-log.ts";
import { nextLocalTicket, prepareLeadRun } from "./lead-run.ts";
import { preparedTicket } from "./lead-state.ts";
import type { TempProject } from "../test/support/temp-project.ts";
import {
  delivered, leadTier, LOG, logLines, makeLeadProject, MANIFEST, prepared, runStart, workerEvidence,
} from "../test/support/lead-project.ts";

const boundary = vi.mocked(execFileSync);
const projects: TempProject[] = [];
function project(files: Readonly<Record<string, string>> = {}): string {
  const p = makeLeadProject(files);
  projects.push(p);
  return p.dir;
}
beforeEach(() => {
  boundary.mockReset();
  vi.stubEnv("BOUNDED_TICKET", undefined as unknown as string);
  vi.stubEnv("BOUNDED_GUARD_LOG", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  while (projects.length) projects.pop()?.cleanup();
});

const active = (dir: string): string => readFileSync(join(dir, ".bounded/active-ticket"), "utf8").trim();
/** The ticket the change boundary was drawn for, per call. */
const boundaryTickets = (): (string | undefined)[] =>
  boundary.mock.calls.map((call) => (call[2] as { env?: NodeJS.ProcessEnv }).env?.["BOUNDED_TICKET"]);

describe("nextLocalTicket", () => {
  test("an empty project starts at 1", () => {
    expect(nextLocalTicket(project())).toBe("1");
  });
  test("one past every TN, ticket directory and the active selection", () => {
    const dir = project({
      "docs/tn/TN-3.md": "", "docs/tn/TN-x.md": "", ".bounded/tickets/7/.keep": "", ".bounded/tickets/draft/.keep": "",
      ".bounded/active-ticket": "5\n",
    });
    expect(nextLocalTicket(dir)).toBe("8");
    writeFileSync(join(dir, ".bounded/active-ticket"), "20\n");
    expect(nextLocalTicket(dir)).toBe("21");
  });
});

describe("prepareLeadRun", () => {
  test("first run: allocates, records the selection, logs the preparation", () => {
    const dir = project();
    const result = prepareLeadRun(dir);
    expect(result).toMatchObject({ ok: true, kind: "first", ticket: "1" });
    expect(active(dir)).toBe("1");
    expect(preparedTicket(dir)).toBe("1");
    expect(boundary).not.toHaveBeenCalled();
    expect(readGuardLog(dir).at(-1)).toMatchObject({ guard: "team-lead", detail: { kind: "run-prepared", ticket: "1", boundary: "first" } });
  });

  test("resume: a started, undelivered run continues", () => {
    const dir = project({ ".bounded/active-ticket": "4\n", [LOG]: logLines(prepared("4"), runStart) });
    expect(prepareLeadRun(dir)).toMatchObject({ ok: true, kind: "resume", ticket: "4" });
    expect(boundary).not.toHaveBeenCalled();
  });

  test("change after delivery draws the boundary for the same ticket", () => {
    const dir = project({ ".bounded/active-ticket": "4\n", [MANIFEST("4")]: "{}", [LOG]: logLines(prepared("4"), runStart, delivered) });
    expect(prepareLeadRun(dir)).toMatchObject({ ok: true, kind: "change", ticket: "4" });
    expect(boundaryTickets()).toEqual(["4"]);
  });

  test("a delivered log with no frozen design is refused", () => {
    const dir = project({ ".bounded/active-ticket": "4\n", [LOG]: logLines(prepared("4"), runStart, delivered) });
    expect(prepareLeadRun(dir)).toMatchObject({ ok: false, reason: expect.stringContaining("no frozen design for ticket #4") });
  });

  test("a failing boundary refuses and leaves the selection alone", () => {
    boundary.mockImplementation(() => { throw new Error("rotate failed"); });
    const dir = project({ ".bounded/active-ticket": "4\n", [MANIFEST("4")]: "{}", [LOG]: logLines(prepared("4"), runStart, delivered) });
    expect(prepareLeadRun(dir, undefined, true)).toMatchObject({ ok: false, reason: expect.stringContaining("rotate failed") });
    expect(active(dir)).toBe("4");
  });

  test("switching without final delivery is refused", () => {
    const dir = project({ ".bounded/active-ticket": "4\n", [LOG]: logLines(prepared("4"), runStart) });
    expect(prepareLeadRun(dir, undefined, true)).toMatchObject({ ok: false, reason: expect.stringContaining("no final delivery") });
    expect(prepareLeadRun(dir, "9")).toMatchObject({ ok: false, reason: expect.stringContaining("#4 is active") });
    expect(active(dir)).toBe("4");
  });

  test("--new naming the already-active ticket is refused", () => {
    const dir = project({ ".bounded/active-ticket": "3\n" });
    expect(prepareLeadRun(dir, "3", true)).toMatchObject({ ok: false, reason: expect.stringContaining("already active") });
  });

  test("--new to a new design after delivery snapshots the delivered ticket and is a first run", () => {
    const dir = project({ ".bounded/active-ticket": "2\n", [MANIFEST("2")]: "{}", [LOG]: logLines(prepared("2"), runStart, delivered) });
    expect(prepareLeadRun(dir, undefined, true)).toMatchObject({ ok: true, kind: "first", ticket: "3" });
    expect(boundaryTickets()).toEqual(["2"]);
    expect(active(dir)).toBe("3");
  });

  test("--new to an older frozen ticket snapshots THAT ticket and is a change", () => {
    const dir = project({
      ".bounded/active-ticket": "2\n", [MANIFEST("1")]: "{}", [MANIFEST("2")]: "{}",
      [LOG]: logLines(prepared("2"), runStart, delivered),
    });
    expect(prepareLeadRun(dir, "1", true)).toMatchObject({ ok: true, kind: "change", ticket: "1" });
    expect(boundaryTickets()).toEqual(["1"]);
  });

  test("an archived log (after delivery) permits switching", () => {
    const dir = project({ ".bounded/active-ticket": "2\n", [MANIFEST("2")]: "{}" });
    expect(prepareLeadRun(dir, undefined, true)).toMatchObject({ ok: true, kind: "first", ticket: "3" });
    expect(boundary).not.toHaveBeenCalled();
  });

  test("an archived log and a frozen target is a change", () => {
    const dir = project({ ".bounded/active-ticket": "2\n", [MANIFEST("5")]: "{}" });
    expect(prepareLeadRun(dir, "5", true)).toMatchObject({ ok: true, kind: "change", ticket: "5" });
  });

  test("the lead's own entries are not run evidence: re-prepare after an aborted architect", () => {
    const dir = project({ ".bounded/active-ticket": "1\n", [LOG]: logLines(prepared("1"), leadTier) });
    expect(prepareLeadRun(dir)).toMatchObject({ ok: true, kind: "first", ticket: "1" });
  });

  test("other run evidence without a run-start is refused", () => {
    const dir = project({ ".bounded/active-ticket": "1\n", [LOG]: logLines(prepared("1"), workerEvidence) });
    expect(prepareLeadRun(dir)).toMatchObject({ ok: false, reason: expect.stringContaining("unfinished run evidence") });
  });

  test("a malformed log is refused, never parsed past", () => {
    const dir = project({ ".bounded/active-ticket": "1\n", [LOG]: "{not json\n" });
    expect(prepareLeadRun(dir)).toMatchObject({ ok: false, reason: expect.stringContaining("malformed") });
    expect(preparedTicket(dir)).toBeUndefined();
  });

  test("BOUNDED_TICKET must agree; empty counts as unset", () => {
    const dir = project();
    vi.stubEnv("BOUNDED_TICKET", "9");
    expect(prepareLeadRun(dir)).toMatchObject({ ok: false, reason: expect.stringContaining("BOUNDED_TICKET selects #9") });
    expect(prepareLeadRun(dir, "9")).toMatchObject({ ok: true, ticket: "9" });
    vi.stubEnv("BOUNDED_TICKET", "");
    expect(prepareLeadRun(project())).toMatchObject({ ok: true, ticket: "1" });
  });

  test("an active-ticket path that is a directory or a symlink is refused and not written through", () => {
    const dir = project();
    mkdirSync(join(dir, ".bounded/active-ticket"));
    expect(prepareLeadRun(dir)).toMatchObject({ ok: false, reason: expect.stringContaining("not a regular file") });
    rmSync(join(dir, ".bounded/active-ticket"), { recursive: true });
    symlinkSync(join(dir, "elsewhere"), join(dir, ".bounded/active-ticket"));
    expect(prepareLeadRun(dir)).toMatchObject({ ok: false, reason: expect.stringContaining("not a regular file") });
    expect(() => readFileSync(join(dir, "elsewhere"))).toThrow();
  });

  test("outside an installation, or without ticket notes, nothing is prepared", () => {
    const dir = project();
    rmSync(join(dir, ".bounded/installation.json"));
    expect(prepareLeadRun(dir)).toMatchObject({ ok: false, reason: expect.stringContaining("no project-local") });
    const bare = project();
    rmSync(join(bare, "docs/tn/README.md"));
    expect(prepareLeadRun(bare)).toMatchObject({ ok: false, reason: expect.stringContaining("no ticket-numbered") });
  });
});
