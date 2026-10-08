import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { checkReceipt, makeReceipt, parseReceipt } from "./handoff.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "bounded-handoff-"));
  roots.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@example.invalid");
  mkdirSync(join(root, "producer", "src"), { recursive: true });
  writeFileSync(join(root, "producer", "spec.md"), "first design\n");
  writeFileSync(join(root, "producer", "src", "shape.contract.ts"), "export interface Shape {}\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "first design");
  git(root, "branch", "producer");
  return root;
}

describe("portable handoff", () => {
  test("accepts an unchanged producer, including a new revision with the same design", () => {
    const root = fixture();
    const selectors = ["producer/spec.md", "producer/**/*.contract.ts"];
    const receipt = makeReceipt(root, "ticket-1", "design-gate", selectors);
    expect(checkReceipt(root, receipt, "producer").ok).toBe(true);
    writeFileSync(join(root, "producer", "src", "implementation.ts"), "export const answer = 1;\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "implement without changing design");
    git(root, "branch", "-f", "producer", "HEAD");
    expect(checkReceipt(root, receipt, "producer").ok).toBe(true);
  });

  test("blocks changed and added handed-off files on the producer ref", () => {
    const root = fixture();
    const receipt = makeReceipt(root, "ticket-1", "design-gate", ["producer/spec.md", "producer/**/*.contract.ts"]);
    writeFileSync(join(root, "producer", "spec.md"), "revised design\n");
    writeFileSync(join(root, "producer", "src", "extra.contract.ts"), "export interface Extra {}\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "revise design");
    git(root, "branch", "-f", "producer", "HEAD");
    expect(checkReceipt(root, receipt, "producer")).toMatchObject({
      ok: false,
      changed: ["producer/spec.md"],
      added: ["producer/src/extra.contract.ts"],
    });
  });

  test("refuses a receipt whose hashes do not match its pinned revision", () => {
    const root = fixture();
    const receipt = makeReceipt(root, "ticket-1", "design-gate", ["producer/spec.md"]);
    const forged = parseReceipt({ ...receipt, files: { "producer/spec.md": "0".repeat(64) } });
    expect(checkReceipt(root, forged, "producer")).toMatchObject({
      ok: false,
      reason: "receipt does not match its pinned revision",
    });
  });

  test("includes committed paths containing newlines", () => {
    const root = fixture();
    const path = "producer/src/odd\nshape.contract.ts";
    writeFileSync(join(root, path), "export interface Odd {}\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "add unusual path");
    const receipt = makeReceipt(root, "ticket-1", "design-gate", ["producer/**/*.contract.ts"]);
    expect(receipt.files).toHaveProperty(path);
  });
});
