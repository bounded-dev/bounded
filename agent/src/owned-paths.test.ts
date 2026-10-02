import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { pathGateCtx } from "./path-gate.ts";
import { decide, type Ctx } from "./path-policy.ts";
import { TICKET_MARKER_RELATIVE } from "./ticket-worktree.ts";

// In a ticket worktree every role writes only under the ticket's owned
// paths, plus test-side and generated files (ADR 2026-066); paths compare
// without case (ADR 2026-057).

const LAYOUT: Omit<Ctx, "cwd"> = {
  sourceRoots: ["contexts"],
  testSuffixes: [".test.ts"],
  generatedGlobs: ["**/*.laws.test.ts"],
  contractGlobs: ["contexts/**/*.contract.ts"],
  writeProtection: { dirNames: [], fileNames: [] },
};
const ctx = (paths: readonly string[]): Ctx => ({ cwd: "/p", ...LAYOUT, ownedPaths: { ticket: 7, paths } });
const write = (role: "architect" | "builder" | "test-writer", path: string, paths: readonly string[] = ["contexts/billing/"]) =>
  decide(role, "write", { path, content: "" }, ctx(paths));

describe("owned-path confinement", () => {
  test("a write under an owned path is allowed, in any case", () => {
    expect(write("builder", "contexts/billing/invoice.ts").allow).toBe(true);
    expect(write("builder", "Contexts/Billing/invoice.ts").allow).toBe(true);
    expect(write("architect", "contexts/billing/invoice.contract.ts").allow).toBe(true);
    expect(write("builder", "contexts/billing.ts", ["contexts/billing.ts"]).allow).toBe(true);
  });

  test("a write outside every owned path is refused with its route", () => {
    const refused = write("builder", "contexts/orders/order.ts");
    expect(refused.allow).toBe(false);
    if (!refused.allow) {
      expect(refused.reason).toContain("ticket #7 owns only contexts/billing/");
      expect(refused.reason).toContain("route → team lead");
    }
    expect(write("architect", "contexts/orders/order.contract.ts").allow).toBe(false);
    expect(write("builder", "contexts/billingx/a.ts").allow).toBe(false);
    expect(write("architect", "CONTEXT.md").allow).toBe(false);
  });

  test("test-side files, the ticket's own TN and the architect's scratch are allowed outside", () => {
    expect(write("test-writer", "contexts/orders/order.test.ts").allow).toBe(true);
    expect(write("architect", "docs/tn/TN-7.md").allow).toBe(true);
    expect(write("architect", "docs/tn/tn-7.md").allow).toBe(true);
    expect(write("architect", "docs/tn/TN-8.md").allow).toBe(false);
    expect(write("architect", "scratch/probe.ts").allow).toBe(true);
    expect(write("builder", "scratch/probe.ts").allow).toBe(false);
  });

  test("outside a ticket worktree nothing is confined", () => {
    expect(decide("builder", "write", { path: "contexts/orders/order.ts", content: "" }, { cwd: "/p", ...LAYOUT }).allow).toBe(true);
  });
});

describe("the path gate reads the confinement from the ticket worktree's marker", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bounded-owned-"));
    vi.stubEnv("BOUNDED_GUARD_LOG", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  test("owned paths come from the marker; a marker with none confines to nothing", () => {
    mkdirSync(join(dir, ".bounded"));
    writeFileSync(join(dir, TICKET_MARKER_RELATIVE), JSON.stringify({ issue: 3, branch: "ticket/3", main: "/m", owns: ["contexts/a/"] }));
    expect(pathGateCtx("builder", dir).ownedPaths).toEqual({ ticket: 3, paths: ["contexts/a/"] });
    writeFileSync(join(dir, TICKET_MARKER_RELATIVE), JSON.stringify({ issue: 3, branch: "ticket/3", main: "/m", owns: "contexts/a/" }));
    expect(pathGateCtx("builder", dir).ownedPaths).toEqual({ ticket: 3, paths: [] });
    rmSync(join(dir, TICKET_MARKER_RELATIVE));
    expect(pathGateCtx("builder", dir).ownedPaths).toBeUndefined();
  });
});
