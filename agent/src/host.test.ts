import { afterEach, describe, expect, test } from "vitest";
import { readGuardLog } from "./guard-log.ts";
import {
  COMMAND_TIMEOUT_ENV,
  commandTimeoutMs,
  CONSTRAINTS,
  HOST_GUARD,
  NO_HOST,
  declareHost,
  hostSummary,
  lastHostDeclaration,
  recordHostDeclaration,
} from "./host.ts";
import { makeTempProject } from "../test/support/temp-project.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});
function project(): string {
  const { dir, cleanup } = makeTempProject({}, { prefix: "host-" });
  cleanups.push(cleanup);
  return dir;
}

describe("declareHost", () => {
  test("derives unenforced from enforced, in canonical order, whatever order was given", () => {
    const d = declareHost("claude-code", ["phase-gate", "path-gate"]);
    expect(d.enforced).toEqual(["path-gate", "phase-gate"]);
    expect(d.unenforced).toEqual(["tool-strip", "scoped-views"]);
    expect([...d.enforced, ...d.unenforced].sort()).toEqual([...CONSTRAINTS].sort());
  });

  test("a bare shell enforces nothing and says so", () => {
    expect(NO_HOST.host).toBe("none");
    expect(NO_HOST.enforced).toEqual([]);
    expect(hostSummary(NO_HOST)).toBe(
      "host none: enforces nothing; unenforced: tool-strip, path-gate, phase-gate, scoped-views",
    );
  });

  test("a host that enforces everything has no 'unenforced' clause", () => {
    expect(hostSummary(declareHost("pi", CONSTRAINTS))).toBe(
      "host pi: enforces tool-strip, path-gate, phase-gate, scoped-views",
    );
  });
});

describe("recordHostDeclaration", () => {
  test("writes one host event carrying both lists", () => {
    const cwd = project();
    expect(recordHostDeclaration(cwd, NO_HOST)).toBe(true);
    const events = readGuardLog(cwd).filter((e) => e.guard === HOST_GUARD);
    expect(events).toHaveLength(1);
    expect(events[0]?.verdict).toBe("pass");
    expect(events[0]?.detail).toEqual({
      kind: "host",
      host: "none",
      enforced: [],
      unenforced: [...CONSTRAINTS],
    });
  });

  test("records on change, not once: none → pi → pi → none is three lines", () => {
    const cwd = project();
    const pi = declareHost("pi", CONSTRAINTS);
    expect(recordHostDeclaration(cwd, NO_HOST)).toBe(true);
    expect(recordHostDeclaration(cwd, pi)).toBe(true);
    expect(recordHostDeclaration(cwd, pi)).toBe(false);
    expect(recordHostDeclaration(cwd, NO_HOST)).toBe(true);
    expect(readGuardLog(cwd).filter((e) => e.guard === HOST_GUARD).map((e) => e.summary)).toEqual([
      hostSummary(NO_HOST),
      hostSummary(pi),
      hostSummary(NO_HOST),
    ]);
  });

  test("the same host with a different enforced set is a change", () => {
    const cwd = project();
    expect(recordHostDeclaration(cwd, declareHost("claude-code", ["path-gate"]))).toBe(true);
    expect(recordHostDeclaration(cwd, declareHost("claude-code", ["path-gate", "tool-strip"]))).toBe(
      true,
    );
  });

  test("lastHostDeclaration reads back what was written and ignores other guards", () => {
    const cwd = project();
    expect(lastHostDeclaration(cwd)).toBeUndefined();
    recordHostDeclaration(cwd, declareHost("claude-code", ["path-gate", "phase-gate"]));
    expect(lastHostDeclaration(cwd)).toEqual(declareHost("claude-code", ["path-gate", "phase-gate"]));
  });
});

// The time a host gives a command before killing it (issue #48): a gate that
// can split its work across calls keeps each call inside it.
describe("the host's command deadline", () => {
  test("commandTimeoutMs reads a positive integer and ignores anything else", () => {
    expect(COMMAND_TIMEOUT_ENV).toBe("BOUNDED_COMMAND_TIMEOUT_MS");
    expect(commandTimeoutMs({ BOUNDED_COMMAND_TIMEOUT_MS: "600000" })).toBe(600_000);
    for (const value of ["abc", "-5", "", "0", "1.5"]) {
      expect(commandTimeoutMs({ BOUNDED_COMMAND_TIMEOUT_MS: value }), value).toBeUndefined();
    }
    expect(commandTimeoutMs({})).toBeUndefined();
  });
});
