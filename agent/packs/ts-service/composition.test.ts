// A pack not composed leaves zero trace of behaviour (ADR 2026-046). Every
// service-shaped rule the TypeScript gates enforce comes from this pack, so a
// ts-only project meets none of them and a ts + ts-service project meets all.
// (The shipped runtime in the red shadow and the delivery pin are covered in
// red-gate.test.ts and deliver.test.ts.)
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { writeProjectPacks } from "../../src/project-composition.ts";
import { lintSrc } from "../ts/scripts/lint-src.ts";
import { contributedContractRuleIds, runContractPurity } from "../ts/scripts/contract-purity.ts";
import { runScaffold } from "../ts/scripts/scaffold-contract.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function project(packs: readonly string[], files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "ts-service-compose-"));
  dirs.push(dir);
  writeProjectPacks(dir, packs);
  for (const [rel, source] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), source);
  }
  return dir;
}

const TS_ONLY = ["ts"];
const SERVICE = ["ts", "ts-service"];

// A service contract WITHOUT the router re-export router-type-reexported demands.
const SERVICE_CONTRACT = 'import type { Ack } from "./service-runtime.js";\nexport declare function submit(): Ack;\n';

describe("service behaviour follows ts-service composition", () => {
  test("src lint: raw framework entry is refused only with ts-service", async () => {
    const files = { "src/api/api.ts": 'import { initTRPC } from "@trpc/server";\nexport const t = initTRPC;\n' };
    const bare = await lintSrc(project(TS_ONLY, files));
    expect(bare.lines.join("\n")).not.toContain("raw-framework-entry");
    const composed = await lintSrc(project(SERVICE, files));
    expect(composed.code).toBe(1);
    expect(composed.lines.join("\n")).toContain("bounded-ts-service/raw-framework-entry");
  });

  test("contract purity: router re-export is required only with ts-service", async () => {
    const files = { "src/api/api.contract.ts": SERVICE_CONTRACT };
    const bareDir = project(TS_ONLY, files);
    expect(contributedContractRuleIds(bareDir)).toEqual([]);
    const bare = await runContractPurity(bareDir);
    expect(bare.lines.join("\n")).not.toContain("router-type-reexported");
    const composedDir = project(SERVICE, files);
    expect(contributedContractRuleIds(composedDir)).toEqual([
      "bounded-ts-service/no-erased-router",
      "bounded-ts-service/router-type-reexported",
    ]);
    const composed = await runContractPurity(composedDir);
    expect(composed.code).toBe(1);
    expect(composed.lines.join("\n")).toContain("bounded-ts-service/router-type-reexported");
  });

  test("scaffold: the runtime is shipped only with ts-service", () => {
    const bare = project(TS_ONLY, { "src/api/api.contract.ts": SERVICE_CONTRACT });
    expect(runScaffold(bare).code).toBe(0);
    expect(existsSync(join(bare, "src/api/service-runtime.ts"))).toBe(false);
    const composed = project(SERVICE, { "src/api/api.contract.ts": SERVICE_CONTRACT });
    expect(runScaffold(composed).code).toBe(0);
    expect(existsSync(join(composed, "src/api/service-runtime.ts"))).toBe(true);
  });
});

describe("erased router types follow ts-service composition", () => {
  const files = {
    "src/api/api.contract.ts":
      'import type { AnyRouter } from "@trpc/server";\nexport type ServiceRouter = AnyRouter;\n',
  };
  test("refused only with ts-service", async () => {
    const bare = await runContractPurity(project(TS_ONLY, files));
    expect(bare.lines.join("\n")).not.toContain("no-erased-router");
    const composed = await runContractPurity(project(SERVICE, files));
    expect(composed.lines.join("\n")).toContain("bounded-ts-service/no-erased-router");
  });
});
