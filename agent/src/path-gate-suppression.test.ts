import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ambientRole,
  boundRole,
  evaluateAmbientPathGate,
  evaluatePathGate,
  isAmbientSuppressed,
  markBoundRoleInstalled,
  resetPathGateRegistry,
  sessionRole,
} from "./path-gate.ts";
import { writeProjectPacks } from "./project-composition.ts";

// The layout the composed packs will contribute (ADRs 2026-056…058), overlaid
// until an installed pack does: see hexagonal-layout.test-support.ts.
vi.mock("./pack-contrib.ts", async (importOriginal) => {
  const { withHexagonalLayout } = await import("./hexagonal-layout.test-support.ts");
  return withHexagonalLayout(await importOriginal());
});

// THE BUG THIS EXISTS FOR (dogfood Run 6, 2026-09-02)
//
// A subagent installs TWO path-gate hooks, and neither knows about the other:
//
//   1. the BOUND hook, from its frontmatter `subagentOnlyExtensions`
//      (hosts/pi/extensions/path-gate/test-writer.ts → installPathGate(pi, "test-writer"))
//   2. the AMBIENT hook, because hosts/pi/extensions/path-gate.ts auto-loads in EVERY
//      pi session — including a child — and resolves its role from
//      `.bounded/dev-stage-role` in the project cwd, which the child SHARES with
//      its parent.
//
// So when the parent session is gated as `architect` through that file, the
// child gets architect's zone applied on top of its own. Both hooks run on
// every tool call and either may block, so the child is confined to the
// INTERSECTION — and the architect may not write `tests/**`.
//
// Live consequence: the test-writer was refused permission to write its own
// tests, with the message "architect may not write 'tests/start.test.ts'". It
// correctly reported "a mismatch between my active_agent tag as test-writer
// and the gate treating me as architect", escalated, and the run deadlocked at
// the first worker.
//
// Restrictions must never leak DOWNWARD. A child's role is decided by its
// parent at spawn, from a file outside the project; that binding wins, and the
// ambient guess stands down in any process where a bound role was installed.

// A real directory: the gate resolves links against the project root, and a
// root that does not exist fails closed.
const CTX = { cwd: mkdtempSync(join(tmpdir(), "gate-suppression-")) } as const;
// A ts-composed project: its contract suffix is what the builder may not write.
writeProjectPacks(CTX.cwd, ["ts"]);
afterAll(() => rmSync(CTX.cwd, { recursive: true, force: true }));

const write = (path: string) => ({ toolName: "write", input: { path }, cwd: CTX.cwd });

beforeEach(() => {
  resetPathGateRegistry();
});

describe("ambient path gate suppression", () => {
  test("with no bound role installed, the ambient gate is live", () => {
    expect(isAmbientSuppressed()).toBe(false);
    const blocked = evaluateAmbientPathGate({ role: "architect", ...write("contexts/m/src/x.test.ts") });
    expect(blocked?.block).toBe(true);
  });

  test("once a bound role is installed, the ambient gate stands down", () => {
    markBoundRoleInstalled();
    expect(isAmbientSuppressed()).toBe(true);
    expect(evaluateAmbientPathGate({ role: "architect", ...write("contexts/m/src/x.test.ts") })).toBeUndefined();
  });

  // The exact live failure, as an executable case.
  test("a bound test-writer may write its own tests despite an architect role file", () => {
    // The child loads its bound loader...
    markBoundRoleInstalled();

    // ...the bound hook allows the write, as it always did:
    expect(evaluatePathGate({ role: "test-writer", ...write("contexts/m/src/start.test.ts") })).toBeUndefined();

    // ...and the ambient hook, which would otherwise apply the PARENT's
    // architect role from .bounded/dev-stage-role, no longer fires. Before the fix
    // this returned a block reading "architect may not write
    // 'tests/start.test.ts'" and deadlocked the pipeline at its first worker.
    expect(evaluateAmbientPathGate({ role: "architect", ...write("contexts/m/src/start.test.ts") })).toBeUndefined();
  });

  test("the bound gate still enforces the child's OWN zone — blindness is untouched", () => {
    markBoundRoleInstalled();
    // Suppression must not become a hole: a test-writer still cannot reach the
    // implementation, which is the one rule the whole pipeline rests on.
    const peek = evaluatePathGate({
      role: "test-writer",
      toolName: "read",
      input: { path: "contexts/m/src/money.ts" },
      cwd: CTX.cwd,
    });
    expect(peek?.block).toBe(true);
    expect(peek?.reason).toContain("may not read");
  });

  test("a builder is likewise confined to its own zone, not the parent's", () => {
    markBoundRoleInstalled();
    // Allowed by its own zone...
    expect(evaluatePathGate({ role: "builder", ...write("contexts/m/src/money.ts") })).toBeUndefined();
    // ...and the parent's architect zone, which forbids src/**, does not apply.
    expect(evaluateAmbientPathGate({ role: "architect", ...write("contexts/m/src/money.ts") })).toBeUndefined();
    // ...but the builder still cannot touch the contract or the tests.
    expect(evaluatePathGate({ role: "builder", ...write("contexts/m/src/money.contract.ts") })?.block).toBe(true);
    expect(evaluatePathGate({ role: "builder", ...write("contexts/m/src/x.test.ts") })?.block).toBe(true);
  });

  // The reviewer is the case where suppression matters most in the design
  // phase: it is spawned by an architect, so without it the parent's
  // architect zone would be applied on top — and the architect MAY write
  // spec.md, which would hand the reviewer a pen it is not supposed to have
  // only when the two zones happened to agree.
  test("a bound reviewer reads freely and still cannot write, whatever the parent is", () => {
    markBoundRoleInstalled();
    expect(
      evaluatePathGate({
        role: "reviewer",
        toolName: "read",
        input: { path: "contexts/m/src/money.contract.ts" },
        cwd: CTX.cwd,
      }),
    ).toBeUndefined();
    const refused = evaluatePathGate({ role: "reviewer", ...write("spec.md") });
    expect(refused?.block).toBe(true);
    expect(refused?.reason).toContain("no write zone");
    expect(evaluateAmbientPathGate({ role: "architect", ...write("spec.md") })).toBeUndefined();
  });

  test("suppression is not order-dependent — the check happens per call, not at install", () => {
    // The ambient extension may well load BEFORE the bound loader; what matters
    // is the state at tool-call time.
    const ev = { role: "architect" as const, ...write("contexts/m/src/x.test.ts") };
    expect(evaluateAmbientPathGate(ev)?.block).toBe(true); // ambient loaded first, still live
    markBoundRoleInstalled(); // bound loader arrives afterwards
    expect(evaluateAmbientPathGate(ev)).toBeUndefined();
  });
});

// --- Who is calling? (the answer every role-sensitive tool shares) ----------
//
// The path gate is no longer the only thing that must know the caller's role:
// `typecheck` scopes its diagnostics by it (packs/ts/scripts/typecheck-scope.ts)
// after dogfood Run 15 caught the tool handing a builder a test file's path,
// line and symbol name. A second, private notion of "who am I" is exactly how
// two enforcement layers drift apart, so both ask sessionRole().

describe("sessionRole", () => {
  const dirs: string[] = [];
  const project = (role?: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "session-role-"));
    dirs.push(dir);
    if (role !== undefined) {
      mkdirSync(join(dir, ".bounded"), { recursive: true });
      writeFileSync(join(dir, ".bounded", "dev-stage-role"), `${role}\n`);
    }
    return dir;
  };
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  test("no binding, no env, no role file ⇒ no role (a normal session)", () => {
    vi.stubEnv("BOUNDED_DEV_STAGE_ROLE", "");
    expect(sessionRole(project())).toBeUndefined();
  });

  test("falls back to the role file, exactly as the ambient gate does", () => {
    vi.stubEnv("BOUNDED_DEV_STAGE_ROLE", "");
    const dir = project("builder");
    expect(ambientRole(dir)).toBe("builder");
    expect(sessionRole(dir)).toBe("builder");
  });

  test("a garbage role file names no role", () => {
    vi.stubEnv("BOUNDED_DEV_STAGE_ROLE", "");
    expect(sessionRole(project("plumber"))).toBeUndefined();
  });

  test("the bound role wins over the parent's role file — restrictions never leak downward", () => {
    const dir = project("architect"); // the PARENT's file, shared with the child
    markBoundRoleInstalled("builder");
    expect(boundRole()).toBe("builder");
    expect(sessionRole(dir)).toBe("builder");
  });

  test("a binding with no role leaves the ambient guess stood down", () => {
    const dir = project("architect");
    markBoundRoleInstalled();
    expect(isAmbientSuppressed()).toBe(true);
    expect(sessionRole(dir)).toBeUndefined();
  });
});
