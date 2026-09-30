// A pack not composed leaves zero trace of behaviour (ADR 2026-046). Every
// tRPC-shaped rule, emitter and obligation the TypeScript gates run comes from
// this pack, so a project without it meets none of them and a project with it
// meets all. Checked through the registry the gates read, so the test does not
// depend on where a gate looks for files.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { writeProjectPacks } from "../../src/project-composition.ts";
import { lintSrcRuleId } from "../ts/pack.ts";
import { composedPacks } from "../installed.ts";
import { contractSupportFiles, deliverChecks, lintSrcRules, skeletonEmitters } from "../ts/pack.ts";
import { contributedContractRuleIds } from "../ts/scripts/contract-purity.ts";
import { runTrpcObligation } from "./trpc-obligation.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function project(packs: readonly string[], files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "ts-trpc-compose-"));
  dirs.push(dir);
  writeProjectPacks(dir, packs);
  for (const [rel, source] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), source);
  }
  return dir;
}

const WITHOUT = ["ts", "ts-hexagonal"];
const WITH = ["ts", "ts-hexagonal", "ts-trpc"];

describe("tRPC behaviour follows ts-trpc composition", () => {
  test("the builder's lint rules", () => {
    // ts-hexagonal's own rules are the baseline; ts-trpc adds exactly its three.
    const baseline = new Set(composedPacks(project(WITHOUT)).read(lintSrcRules).map(lintSrcRuleId));
    expect([...baseline].every((id) => id.startsWith("bounded-ts-hexagonal/"))).toBe(true);
    expect(composedPacks(project(WITH)).read(lintSrcRules).map(lintSrcRuleId).filter((id) => !baseline.has(id))).toEqual([
      "bounded-ts-trpc/raw-framework-entry",
      "bounded-ts-trpc/no-erased-router",
      "bounded-ts-trpc/router-type-reexported",
    ]);
  });

  test("the architect's contract rule", () => {
    expect(contributedContractRuleIds(project(WITHOUT))).toEqual([]);
    expect(contributedContractRuleIds(project(WITH))).toEqual(["bounded-ts-trpc/no-erased-router"]);
  });

  test("the emitter, the obligation and the legacy runtime", () => {
    const bare = composedPacks(project(WITHOUT));
    // ts-hexagonal's own emitters are the baseline; ts-trpc adds exactly its one.
    const baseline = new Set(bare.read(skeletonEmitters).map((e) => e.name));
    expect(bare.read(deliverChecks)).toEqual([]);
    expect(bare.read(contractSupportFiles)).toEqual([]);
    const composed = composedPacks(project(WITH));
    expect(composed.read(skeletonEmitters).map((e) => e.name).filter((n) => !baseline.has(n))).toEqual(["trpc-in-adapter"]);
    expect(composed.read(deliverChecks).map((c) => c.name)).toEqual(["trpc-obligation"]);
    expect(composed.read(contractSupportFiles).map((f) => f.label)).toEqual(["API-service runtime"]);
  });

  test("composing ts-trpc without ts-hexagonal is refused", () => {
    expect(() => composedPacks(project(["ts", "ts-trpc"]))).toThrow(/depends on pack 'ts-hexagonal'/);
  });
});

describe("the delivery obligation", () => {
  test("blocks until a context exposes a feature through tRPC", () => {
    expect(runTrpcObligation(project(WITH)).verdict).toBe("block");
    const other = project(WITH, { "contexts/billing/src/adapters/in/mcp/index.ts": "export {};\n" });
    expect(runTrpcObligation(other).verdict).toBe("block");
    const exposed = project(WITH, { "contexts/billing/src/adapters/in/trpc/index.ts": "export {};\n" });
    expect(runTrpcObligation(exposed)).toEqual({ verdict: "pass", summary: "ts-trpc: generated tRPC adapter in billing" });
  });
});
