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

// ADR 2026-056: in the monorepo the targets must lie under a source root the
// composition names, not under a literal src/.
describe("contract support targets stay inside the source roots", () => {
  const ROOTS = ["contexts/*/src", "apps/*/src"];
  function monorepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "support-roots-"));
    dirs.push(dir);
    mkdirSync(join(dir, "contexts", "pm", "src", "api"), { recursive: true });
    return dir;
  }

  test("a target under any concrete root is accepted", () => {
    const dir = monorepo();
    mkdirSync(join(dir, "apps", "web", "src"), { recursive: true });
    const target = join(dir, "contexts/pm/src/api/runtime.ts");
    const other = join(dir, "apps/web/src/runtime.ts");
    const r = containedSupportTargets(pointing(target, other), "", "contexts/pm/src/api/a.contract.ts", dir, ROOTS);
    expect(r).toEqual({ ok: true, targets: [target, other] });
  });

  test.each([
    ["the context directory itself", "contexts/pm/runtime.ts"],
    ["a root directory itself", "contexts/pm/src"],
    ["a flat src/", "src/runtime.ts"],
    ["a deeper non-root", "contexts/pm/lib/runtime.ts"],
    ["outside the project", "../runtime.ts"],
  ])("%s is refused, naming the roots", (_, rel) => {
    const dir = monorepo();
    const r = containedSupportTargets(pointing(join(dir, rel)), "", "contexts/pm/src/api/a.contract.ts", dir, ROOTS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("which resolves outside the project's contexts/*/src/, apps/*/src/");
  });

  test("a link under a root that leads outside is refused", () => {
    const dir = monorepo();
    const outside = mkdtempSync(join(tmpdir(), "support-outside-"));
    dirs.push(outside);
    symlinkSync(outside, join(dir, "contexts", "pm", "src", "linked"), "dir");
    const r = containedSupportTargets(pointing(join(dir, "contexts/pm/src/linked/runtime.ts")), "", "contexts/pm/src/api/a.contract.ts", dir, ROOTS);
    expect(r.ok).toBe(false);
  });
});
