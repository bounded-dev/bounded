import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "bun:test";
import { TARGET_IDS } from "./native-release-fixture.test-support.ts";

const REPO = resolve(import.meta.dir, "../../..");
const version = (JSON.parse(readFileSync(resolve(REPO, "src/package.json"), "utf8")) as { version: string }).version;
const declarationPath = resolve(REPO, "src/release-targets.json");
const workflowPath = resolve(REPO, ".github/workflows/release.yml");

test("a checked-in target declaration is bound to this version and is a sorted nonempty candidate subset", () => {
  expect(existsSync(declarationPath)).toBe(true);
  if (!existsSync(declarationPath)) return;
  const declaration: unknown = JSON.parse(readFileSync(declarationPath, "utf8"));
  expect(declaration).toMatchObject({ schema: "bounded-release-targets/1", version });
  const targets = (declaration as { targets?: unknown }).targets;
  expect(Array.isArray(targets)).toBe(true);
  if (!Array.isArray(targets)) return;
  expect(targets.length).toBeGreaterThan(0);
  expect(targets).toEqual([...targets].sort());
  expect(new Set(targets).size).toBe(targets.length);
  expect(targets.every((target) => TARGET_IDS.includes(target))).toBe(true);
});

test("release workflow uses the version declaration for a fixed native matrix and checks the tagged main source", () => {
  expect(existsSync(workflowPath)).toBe(true);
  if (!existsSync(workflowPath)) return;
  const workflow = readFileSync(workflowPath, "utf8");
  expect(workflow).toContain("release-targets.json");
  expect(workflow).toMatch(/github\.ref|refs\/tags\/v/);
  expect(workflow).toMatch(/git.*fetch|fetch-depth/);
  expect(workflow).toMatch(/merge-base|ancestor/);
  expect(workflow).toMatch(/bun run check/);
  expect(workflow).toMatch(/macos-15-intel/);
  expect(workflow).toMatch(/macos-15/);
  expect(workflow).toMatch(/ubuntu-24\.04-arm/);
  expect(workflow).toMatch(/windows-11-arm/);
  expect(workflow).toMatch(/alpine|musl/);
  expect(workflow).toMatch(/attest/);
});

test("native Windows workflow executes install, launcher, hook and rollback without Node or Bun", () => {
  expect(existsSync(workflowPath)).toBe(true);
  if (!existsSync(workflowPath)) return;
  const workflow = readFileSync(workflowPath, "utf8");
  expect(workflow).toMatch(/windows-2025|windows-latest/);
  expect(workflow).toMatch(/windows-11-arm/);
  expect(workflow).toMatch(/install\.ps1/);
  expect(workflow).toMatch(/bounded\.cmd/);
  expect(workflow).toMatch(/hook.*claude-code/);
  expect(workflow).toMatch(/rollback|failed.install/i);
  expect(workflow).toMatch(/node.*bun.*npm|bun.*node.*npm|without.runtimes/i);
});

test("macOS workflow signs before packaging, notarizes the exact ZIP and attests after distribution checks", () => {
  expect(existsSync(workflowPath)).toBe(true);
  if (!existsSync(workflowPath)) return;
  const workflow = readFileSync(workflowPath, "utf8");
  const sign = workflow.indexOf("codesign");
  const packageSigned = workflow.indexOf("--package-signed");
  const notarize = workflow.indexOf("notarytool");
  const attest = workflow.indexOf("actions/attest");
  expect(sign).toBeGreaterThan(-1);
  expect(packageSigned).toBeGreaterThan(sign);
  expect(notarize).toBeGreaterThan(packageSigned);
  expect(attest).toBeGreaterThan(notarize);
  expect(workflow).toMatch(/--options(?:=|\s+)runtime/);
  expect(workflow).toMatch(/--timestamp/);
  expect(workflow).toMatch(/notarytool[^\n]*--wait|notarytool[\s\S]*?--wait/);
  expect(workflow).toMatch(/Accepted/);
  expect(workflow).toMatch(/sha256|shasum/);
  expect(workflow).toMatch(/spctl/);
  expect(workflow).toMatch(/quarantine/);
});

test("assembly verifies each archive attestation from the current run and leaves a private draft for approval", () => {
  expect(existsSync(workflowPath)).toBe(true);
  if (!existsSync(workflowPath)) return;
  const workflow = readFileSync(workflowPath, "utf8");
  expect(workflow).toMatch(/gh attestation verify/);
  expect(workflow).toMatch(/GITHUB_RUN_ID/);
  expect(workflow).toMatch(/GITHUB_RUN_ATTEMPT/);
  expect(workflow).toMatch(/--verify-tag/);
  expect(workflow).toMatch(/--draft/);
  expect(workflow).not.toMatch(/gh release upload[^\n]*--clobber/);
  expect(workflow).toMatch(/assets.*digest|digest.*assets|release.*verify/i);
});
