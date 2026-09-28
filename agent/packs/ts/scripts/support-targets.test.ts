import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { ContractSupportFile } from "../pack.ts";
import { containedSupportTargets } from "./support-targets.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "support-targets-"));
  dirs.push(dir);
  mkdirSync(join(dir, "src", "api"), { recursive: true });
  return dir;
}

/** A support file whose targets are whatever the test says, as a pack might. */
const pointing = (...targets: string[]): ContractSupportFile => ({
  label: "demo runtime", canonical: "packs/demo/runtime.ts", source: () => "", targets: () => targets,
});

describe("contract support targets stay inside src/", () => {
  test("a target under src/ is accepted", () => {
    const dir = root();
    const r = containedSupportTargets(pointing(join(dir, "src/api/runtime.ts")), "", "src/api/a.contract.ts", dir);
    expect(r).toEqual({ ok: true, targets: [join(dir, "src/api/runtime.ts")] });
  });

  test.each([
    ["outside the project", "../x/runtime.ts"],
    ["in the project but outside src/", "runtime.ts"],
    ["src/ itself", "src"],
    ["the harness state", ".bounded/runtime.ts"],
  ])("a target %s is refused with the path it resolved to", (_, rel) => {
    const dir = root();
    const r = containedSupportTargets(pointing(join(dir, rel)), "", "src/api/a.contract.ts", dir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(`src/api/a.contract.ts asks for the demo runtime at '${rel}', which resolves outside the project's src/`);
  });

  test("a link under src/ that leads outside is refused", () => {
    const dir = root();
    const outside = mkdtempSync(join(tmpdir(), "support-outside-"));
    dirs.push(outside);
    symlinkSync(outside, join(dir, "src", "linked"), "dir");
    const r = containedSupportTargets(pointing(join(dir, "src/linked/runtime.ts")), "", "src/api/a.contract.ts", dir);
    expect(r.ok).toBe(false);
  });

  // A dangling link does not "exist", so an existence walk would judge its
  // parent (src/) and let the scaffolder write through it to wherever it points.
  test.each([
    ["the target itself", "src/support.ts", "src/support.ts"],
    ["a directory on the way", "src/gen", "src/gen/support.ts"],
  ])("a dangling link as %s is refused", (_, link, target) => {
    const dir = root();
    const outside = mkdtempSync(join(tmpdir(), "support-outside-"));
    dirs.push(outside);
    symlinkSync(join(outside, "missing"), join(dir, link));
    const r = containedSupportTargets(pointing(join(dir, target)), "", "src/api/a.contract.ts", dir);
    expect(r.ok).toBe(false);
  });
});
