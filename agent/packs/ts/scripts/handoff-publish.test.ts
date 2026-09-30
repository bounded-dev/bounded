import { writeProjectPacks } from "../../../src/project-composition.ts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { checkReceipt } from "../../../src/handoff.ts";
import { computeManifest, serializeManifest } from "./checksum-gate.ts";
import { readReviewed } from "./design-review.ts";
import { runHandoffPublish } from "./handoff-publish.ts";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
// A source root of the composed hexagonal layout: contracts live under one.
const SRC = "contexts/shapes/src";
const PACKS = ["ts", "ts-hexagonal"];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "bounded-publish-"));
  roots.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@example.invalid");
  const project = join(root, "producer");
  mkdirSync(join(project, SRC), { recursive: true });
  writeProjectPacks(project, PACKS);
  writeFileSync(join(project, "spec.md"), "Frozen intent\n");
  writeFileSync(join(project, SRC, "shape.contract.ts"), "export interface Shape {}\n");
  mkdirSync(join(project, ".bounded"), { recursive: true });
  writeFileSync(join(project, ".bounded", "contract-checksums.json"), serializeManifest(computeManifest(project)));
  const reviewed = readReviewed(project);
  if (!reviewed.ok) throw new Error(reviewed.error);
  writeFileSync(join(project, ".bounded", "guard-log.jsonl"), JSON.stringify({
    ts: "2026-09-24T00:00:00.000Z", guard: "design-gate", verdict: "pass",
    summary: "OK", detail: { frozenDesign: reviewed.reviewed },
  }) + "\n");
  writeFileSync(join(root, ".gitignore"), ".bounded/\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "frozen producer design");
  git(root, "branch", "producer");
  return project;
}

describe("handoff-publish", () => {
  test("publishes the ticket TN and only its owned contract", () => {
    const cwd = fixture();
    mkdirSync(join(cwd, "docs/tn"), { recursive: true });
    writeFileSync(join(cwd, "docs/tn/README.md"), "# Technical Notes\n");
    writeFileSync(join(cwd, "docs/tn/TN-24.md"),
      `---\nissue: 24\nstatus: active\ncontracts:\n  - ${SRC}/shape.contract.ts\n---\n\n# Shape\n`);
    writeFileSync(join(cwd, SRC, "unrelated.contract.ts"), "export interface Other {}\n");
    vi.stubEnv("BOUNDED_TICKET", "24");
    mkdirSync(join(cwd, ".bounded/tickets/24"), { recursive: true });
    writeFileSync(join(cwd, ".bounded/tickets/24/contract-checksums.json"), serializeManifest(computeManifest(cwd)));
    const reviewed = readReviewed(cwd);
    if (!reviewed.ok) throw new Error(reviewed.error);
    writeFileSync(join(cwd, ".bounded/guard-log.jsonl"), JSON.stringify({
      ts: "2026-09-24T00:00:00.000Z", guard: "design-gate", verdict: "pass", summary: "OK",
      detail: { ticket: "24", frozenDesign: reviewed.reviewed },
    }) + "\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "ticket design");
    expect(runHandoffPublish(cwd, "25")).toMatchObject({ code: 2 });
    const result = runHandoffPublish(cwd, "24");
    expect(result.code).toBe(0);
    const receipt = result.detail.receipt as Parameters<typeof checkReceipt>[1];
    expect(Object.keys(receipt.files).sort()).toEqual([`producer/${SRC}/shape.contract.ts`, "producer/docs/tn/TN-24.md"]);
    expect(checkReceipt(cwd, receipt, "HEAD").ok).toBe(true);
  });
  test("publishes a committed, unchanged design from a passing freeze", () => {
    const cwd = fixture();
    const result = runHandoffPublish(cwd, "ticket-1");
    expect(result.code).toBe(0);
    const receipt = result.detail.receipt as Parameters<typeof checkReceipt>[1];
    expect(Object.keys(receipt.files).sort()).toEqual([`producer/${SRC}/shape.contract.ts`, "producer/spec.md"]);
    expect(checkReceipt(cwd, receipt, "producer").ok).toBe(true);
  });

  test("refuses a spec edited after freeze", () => {
    const cwd = fixture();
    writeFileSync(join(cwd, "spec.md"), "Changed intent\n");
    expect(runHandoffPublish(cwd, "ticket-1")).toMatchObject({ code: 1, summary: "spec.md changed since freeze" });
  });

  test("refuses an uncommitted contract even when local freeze data was rewritten", () => {
    const cwd = fixture();
    writeFileSync(join(cwd, SRC, "shape.contract.ts"), "export interface Shape { value: string }\n");
    writeFileSync(join(cwd, ".bounded", "contract-checksums.json"), serializeManifest(computeManifest(cwd)));
    const reviewed = readReviewed(cwd);
    if (!reviewed.ok) throw new Error(reviewed.error);
    const events = readFileSync(join(cwd, ".bounded", "guard-log.jsonl"), "utf8").trim().split("\n");
    events.push(JSON.stringify({ ts: "2026-09-24T00:01:00.000Z", guard: "design-gate", verdict: "pass", summary: "OK", detail: { frozenDesign: reviewed.reviewed } }));
    writeFileSync(join(cwd, ".bounded", "guard-log.jsonl"), events.join("\n") + "\n");
    expect(runHandoffPublish(cwd, "ticket-1")).toMatchObject({ code: 1, summary: `${SRC}/shape.contract.ts differs from the committed revision` });
  });

  test("refuses to publish without a standing design-gate pass", () => {
    const cwd = fixture();
    writeFileSync(join(cwd, ".bounded", "guard-log.jsonl"), "");
    expect(runHandoffPublish(cwd, "ticket-1")).toMatchObject({ code: 1, summary: "no standing design-gate freeze" });
  });
});
