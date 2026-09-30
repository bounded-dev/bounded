// The gate-verified reference (TN-26-008), now the worked example's domain
// (ADR 2026-059): packs/ts/reference/contexts/project-management/src/domain.
//
// Its whole value is that the checks the harness enforces run over it on
// every `npm run check`, so the example an agent copies can never show a
// shape the gates would refuse. This file is that wiring:
//
//   * every contract passes contract-purity;
//   * every implementation passes impl-tail and zod-backed-parse, and its
//     tail is exactly the emitter's;
//   * the committed laws are exactly what the domain emitter emits today;
//   * with `bun`: the context typechecks under `bunx tsc`, its suite (laws
//     and hand-written tests) passes, and against the emitted skeletons the
//     same suite fails only with NotImplementedError — a valid red.
//
// The flat-layout red/green/mutation gate runs that used to live here return
// when those gates move to the monorepo layout (WI-8); until then this file
// drives the same evidence through the toolchain directly.

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { ESLint } from "eslint";
import parser from "@typescript-eslint/parser";
import plugin from "../eslint/index.ts";
import { lintContractSource } from "./contract-purity.ts";
import { lawsPathOf } from "./domain-concept.ts";
import { emitDomain, NOT_IMPLEMENTED_MODULE_SOURCE } from "./domain-emitter.ts";
import type { WorkspaceFacts } from "../pack.ts";

const REFERENCE_DIR = join(import.meta.dirname, "..", "reference");
const CONTEXT = "contexts/project-management";
const DOMAIN = `${CONTEXT}/src/domain`;
const HARNESS_MODULES = join(import.meta.dirname, "..", "..", "..", "node_modules");

function contracts(): { path: string; source: string }[] {
  const out: { path: string; source: string }[] = [];
  for (const area of readdirSync(join(REFERENCE_DIR, DOMAIN)).sort()) {
    if (area === "shared" || area.endsWith(".ts")) continue;
    for (const file of readdirSync(join(REFERENCE_DIR, DOMAIN, area)).sort()) {
      if (file.endsWith(".contract.ts")) {
        const path = `${DOMAIN}/${area}/${file}`;
        out.push({ path, source: readFileSync(join(REFERENCE_DIR, path), "utf8") });
      }
    }
  }
  return out;
}

const CONTRACTS = contracts();
const WORKSPACE: WorkspaceFacts = {
  dir: CONTEXT,
  name: "project-management",
  kind: "context",
  packageName: "@example/project-management",
  sourceRoot: `${CONTEXT}/src`,
  contracts: CONTRACTS,
};
const EMITTED = emitDomain(WORKSPACE);

test("the reference holds the worked example's six concepts", () => {
  expect(CONTRACTS.map((c) => c.path.split("/").slice(-2).join("/"))).toEqual([
    "notes/note-id.contract.ts",
    "notes/note-text.contract.ts",
    "notes/note.contract.ts",
    "projects/project-id.contract.ts",
    "projects/project-name.contract.ts",
    "projects/project.contract.ts",
  ]);
});

describe("every reference contract passes contract-purity", () => {
  test.each(CONTRACTS.map((c) => [c.path, c.source] as const))("%s", async (path, source) => {
    expect(await lintContractSource(source, path)).toEqual([]);
  });
});

describe("every reference implementation keeps the generated tail and parses over zod", () => {
  const linter = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.ts"],
        languageOptions: { parser },
        plugins: { "bounded-ts": plugin as unknown as ESLint.Plugin },
        rules: { "bounded-ts/impl-tail": "error", "bounded-ts/zod-backed-parse": "error" },
      },
    ],
  });
  test.each(CONTRACTS.map((c) => [c.path.replace(".contract.ts", ".ts")] as const))("%s", async (path) => {
    const source = readFileSync(join(REFERENCE_DIR, path), "utf8");
    const [result] = await linter.lintText(source, { filePath: join(REFERENCE_DIR, path) });
    expect(result!.messages).toEqual([]);
    const skeleton = EMITTED.find((f) => f.path === path)!;
    const tail = (text: string): string => text.trimEnd().split("\n").slice(-2).join("\n");
    expect(tail(source)).toBe(tail(skeleton.content));
  });
});

test("the committed laws are exactly what the domain emitter emits today", () => {
  for (const c of CONTRACTS) {
    const path = lawsPathOf(c.path);
    const emitted = EMITTED.find((f) => f.path === path)!;
    expect(emitted.mode).toBe("generated");
    expect(readFileSync(join(REFERENCE_DIR, path), "utf8"), `${path} is stale — regenerate it from the domain emitter`).toBe(
      emitted.content,
    );
  }
});

test("every value object documents two @accepts examples, so no law is skipped", () => {
  for (const c of CONTRACTS) {
    const laws = EMITTED.find((f) => f.path === lawsPathOf(c.path))!.content;
    expect(laws, c.path).not.toContain("test.skip");
  }
});

// --- the running project ----------------------------------------------------------

const HAS_BUN = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;
if (!HAS_BUN) console.warn("reference-component.test: bun is not on PATH — skipping the typecheck and suite runs");

const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A throwaway copy of the reference context with a typecheck config and the
 *  harness's node_modules (zod, typescript). */
function freshCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-reference-"));
  tmpDirs.push(dir);
  cpSync(join(REFERENCE_DIR, "contexts"), join(dir, "contexts"), { recursive: true });
  writeFileSync(join(dir, "bun-test.d.ts"), 'declare module "bun:test" {\n  export { describe, expect, test } from "vitest";\n}\n');
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        lib: ["ESNext", "DOM"],
        target: "ESNext",
        module: "Preserve",
        moduleDetection: "force",
        moduleResolution: "bundler",
        allowImportingTsExtensions: true,
        verbatimModuleSyntax: true,
        noEmit: true,
        strict: true,
        skipLibCheck: true,
        noUncheckedIndexedAccess: true,
        noImplicitOverride: true,
        types: [],
      },
      include: ["contexts/*/src", "bun-test.d.ts"],
    }),
  );
  symlinkSync(HARNESS_MODULES, join(dir, "node_modules"), "dir");
  return dir;
}

describe.skipIf(!HAS_BUN)("the reference runs", () => {
  test("it typechecks under bunx tsc", () => {
    const dir = freshCopy();
    const tsc = spawnSync("bunx", ["tsc", "-p", "tsconfig.json"], { cwd: dir, encoding: "utf8" });
    expect(tsc.stdout + tsc.stderr).toBe("");
    expect(tsc.status).toBe(0);
  }, 60_000);

  test("its suite — generated laws and hand-written tests — passes under bun test", () => {
    const run = spawnSync("bun", ["test"], { cwd: join(REFERENCE_DIR, CONTEXT), encoding: "utf8" });
    const output = run.stdout + run.stderr;
    expect(output).toMatch(/\b0 fail\b/);
    expect(output).not.toMatch(/\bskip\b/);
    expect(run.status).toBe(0);
  }, 60_000);

  test("against the emitted skeletons the same suite is a valid red: every failure a NotImplementedError", () => {
    const dir = freshCopy();
    writeFileSync(join(dir, DOMAIN, "shared", "errors.ts"), NOT_IMPLEMENTED_MODULE_SOURCE);
    for (const file of EMITTED) if (file.mode === "skeleton") writeFileSync(join(dir, file.path), file.content);
    const tsc = spawnSync("bunx", ["tsc", "-p", "tsconfig.json"], { cwd: dir, encoding: "utf8" });
    expect(tsc.stdout + tsc.stderr).toBe("");
    const run = spawnSync("bun", ["test"], { cwd: dir, encoding: "utf8" });
    const output = run.stdout + run.stderr;
    const failures = output.split("\n").filter((l) => /^\(fail\)/.test(l)).length;
    const notImplemented = output.split("\n").filter((l) => /NotImplementedError: Not implemented: /.test(l)).length;
    expect(output).toMatch(/\b0 pass\b/);
    expect(failures).toBeGreaterThan(0);
    expect(notImplemented).toBe(failures);
  }, 60_000);
});
