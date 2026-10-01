import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, test } from "vitest";
import {
  computeManifest,
  diffManifests,
  findContractFiles,
  hashContract,
  serializeManifest,
} from "./checksum-gate.ts";
import { readGuardLog } from "../../../src/guard-log.ts";
import { writeProjectPacks } from "../../../src/project-composition.ts";

const S = "contexts/shop/src";

// --- pure core ----------------------------------------------------------------

describe("hashContract", () => {
  test("newline normalization: CRLF and LF hash identically", () => {
    expect(hashContract("a\r\nb\r\n")).toBe(hashContract("a\nb\n"));
  });
  test("content changes change the hash", () => {
    expect(hashContract("export interface A {}")).not.toBe(hashContract("export interface B {}"));
  });
});

describe("diffManifests", () => {
  test("reports changed / added / removed contracts", () => {
    const stored = { files: { "a.contract.ts": "h1", "b.contract.ts": "h2" } };
    const current = { files: { "a.contract.ts": "h1x", "c.contract.ts": "h3" } };
    expect(diffManifests(stored, current)).toEqual({
      changed: ["a.contract.ts"],
      added: ["c.contract.ts"],
      removed: ["b.contract.ts"],
    });
  });
  test("no drift when manifests match", () => {
    const m = { files: { "a.contract.ts": "h1" } };
    expect(diffManifests(m, m)).toEqual({ changed: [], added: [], removed: [] });
  });
});

// --- filesystem walk ----------------------------------------------------------

const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A hexagonal project (ADR 2026-056): contracts live under a context's
 *  source root, `contexts/<context>/src`; `S` below is that root. */
function project(files: Record<string, string>, packs: readonly string[] | null = ["ts", "ts-hexagonal"]): string {
  const dir = mkdtempSync(join(tmpdir(), "checksum-"));
  tmpDirs.push(dir);
  if (packs !== null) writeProjectPacks(dir, packs);
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

describe("findContractFiles", () => {
  test("finds *.contract.ts under the source roots only, sorted, ignoring node_modules/.git/.bounded/scratch", () => {
    const dir = project({
      [`${S}/orders/orders.contract.ts`]: "export interface O {}",
      [`${S}/pay/pay.contract.ts`]: "export interface P {}",
      [`${S}/orders/orders.ts`]: "// impl, not a contract",
      // Outside every source root: not a contract (ADR 2026-056).
      "src/stray.contract.ts": "export interface Stray {}",
      "contexts/shop/other/x.contract.ts": "export interface Outside {}",
      [`${S}/node_modules/pkg/y.contract.ts`]: "export interface Ignored {}",
      "node_modules/pkg/x.contract.ts": "export interface Ignored {}",
      ".bounded/y.contract.ts": "export interface Ignored {}",
      ".agent-state/snapshot.contract.ts": "export interface Ignored {}",
      // The architect's scratch zone (Fix 4): a probe that happens to be named
      // like a contract must never be frozen. The walk skips scratch/ by name.
      "scratch/probe.contract.ts": "export interface Probe {}",
    });
    const found = findContractFiles(dir).map((p) => p.slice(dir.length + 1).split("\\").join("/"));
    expect(found).toEqual([`${S}/orders/orders.contract.ts`, `${S}/pay/pay.contract.ts`]);
  });

  test("a scratch/*.contract.ts is absent from the frozen manifest", () => {
    const dir = project({
      [`${S}/a.contract.ts`]: "export interface A { x: number }\n",
      "scratch/probe.contract.ts": "export interface Probe {}\n",
    });
    const manifest = computeManifest(dir);
    expect(Object.keys(manifest.files)).toEqual([`${S}/a.contract.ts`]);
  });

  test("an unreadable composition throws: a gate must not guess which files are the design", () => {
    const dir = project({ [`${S}/a.contract.ts`]: "export interface A {}\n" }, null);
    expect(() => findContractFiles(dir)).toThrow(/composition/);
  });

  test("a composition with no source roots has no contracts", () => {
    const dir = project({ [`${S}/a.contract.ts`]: "export interface A {}\n" }, ["ts"]);
    expect(findContractFiles(dir)).toEqual([]);
  });
});

// --- CLI (fixture-repo): record, verify, drift --------------------------------

const SCRIPT = join(import.meta.dirname, "checksum-gate.ts");

function runGate(dir: string, args: string[] = []) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: "utf8" });
}

describe("checksum-gate CLI (fixture repos)", () => {
  test("--write records the manifest, then verify passes → exit 0", () => {
    const dir = project({ [`${S}/a.contract.ts`]: "export interface A { x: number }\n" });
    const w = runGate(dir, ["--write"]);
    expect(w.status).toBe(0);
    expect(w.stdout).toMatch(/wrote \.bounded\/contract-checksums\.json \(1 contract file\)/);

    const v = runGate(dir);
    expect(v.status).toBe(0);
    expect(v.stdout).toMatch(/checksum-gate: OK — 1 contract file, no drift/);
    const events = readGuardLog(dir);
    expect(events.map((e) => e.verdict)).toEqual(["pass", "pass"]);
  });

  test("a changed contract mid-loop is drift → exit 1, logs a block", () => {
    const dir = project({ [`${S}/a.contract.ts`]: "export interface A { x: number }\n" });
    runGate(dir, ["--write"]);
    writeFileSync(join(dir, S, "a.contract.ts"), "export interface A { x: string }\n");
    const v = runGate(dir);
    expect(v.status).toBe(1);
    expect(v.stdout).toMatch(/drift changed contexts\/shop\/src\/a\.contract\.ts/);
    expect(v.stdout).toMatch(/FAIL — 1 contract file moved/);
    expect(readGuardLog(dir).at(-1)).toMatchObject({ guard: "checksum-gate", verdict: "block" });
  });

  test("an added contract is drift → exit 1", () => {
    const dir = project({ [`${S}/a.contract.ts`]: "export interface A {}\n" });
    runGate(dir, ["--write"]);
    writeFileSync(join(dir, S, "b.contract.ts"), "export interface B {}\n");
    const v = runGate(dir);
    expect(v.status).toBe(1);
    expect(v.stdout).toMatch(/drift added contexts\/shop\/src\/b\.contract\.ts/);
  });

  test("a removed contract is drift → exit 1", () => {
    const dir = project({ [`${S}/a.contract.ts`]: "export interface A {}\n", [`${S}/b.contract.ts`]: "export interface B {}\n" });
    runGate(dir, ["--write"]);
    rmSync(join(dir, S, "b.contract.ts"));
    const v = runGate(dir);
    expect(v.status).toBe(1);
    expect(v.stdout).toMatch(/drift removed contexts\/shop\/src\/b\.contract\.ts/);
  });

  test("verify with no manifest → exit 2 (misuse)", () => {
    const dir = project({ [`${S}/a.contract.ts`]: "export interface A {}\n" });
    const v = runGate(dir);
    expect(v.status).toBe(2);
    expect(v.stderr).toMatch(/no manifest at \.bounded\/contract-checksums\.json/);
    expect(readGuardLog(dir).at(-1)).toMatchObject({ verdict: "error" });
  });

  test("no contract files → exit 2 (a gate that matches nothing is broken)", () => {
    const dir = project({ [`${S}/impl.ts`]: "export const x = 1;\n" });
    const v = runGate(dir, ["--write"]);
    expect(v.status).toBe(2);
    expect(v.stderr).toMatch(/no contract files found under the source roots/);
  });

  test("manifest is deterministic (sorted keys, trailing newline)", () => {
    const dir = project({ [`${S}/b.contract.ts`]: "export interface B {}\n", [`${S}/a.contract.ts`]: "export interface A {}\n" });
    runGate(dir, ["--write"]);
    const manifest = readFileSync(join(dir, ".bounded/contract-checksums.json"), "utf8");
    expect(manifest.endsWith("\n")).toBe(true);
    const keys = Object.keys((JSON.parse(manifest) as { files: Record<string, string> }).files);
    expect(keys).toEqual([`${S}/a.contract.ts`, `${S}/b.contract.ts`]);
    // serializeManifest matches what the CLI wrote.
    expect(serializeManifest(computeManifest(dir))).toBe(manifest);
  });
});
