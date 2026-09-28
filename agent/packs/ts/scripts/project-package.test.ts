import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { writeProjectPacks } from "../../../src/project-composition.ts";
import { mergeProjectFields, packageFor, writeProjectPackage } from "./project-package.ts";

const agentRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const temporary: string[] = [];
function project(packs: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "project-package-"));
  temporary.push(dir);
  writeProjectPacks(dir, packs);
  return dir;
}
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("the ts pack's project manifest writer (ADR 2026-051)", () => {
  test("capability scripts and pins cannot silently replace earlier values", () => {
    const fields = { check: "tsc --noEmit" };
    mergeProjectFields(fields, { check: "tsc --noEmit" }, "Project script", "same");
    expect(fields.check).toBe("tsc --noEmit");
    expect(() => mergeProjectFields(fields, { check: "echo skipped" }, "Project script", "other")).toThrow(/conflicts/);
    expect(fields.check).toBe("tsc --noEmit");
    const pins = { package: "1.0.0" };
    expect(() => mergeProjectFields(pins, { package: "2.0.0" }, "Dependency", "other")).toThrow(/conflicts/);
  });

  test("merges the composed packs' template, scripts and pins, and locks them", () => {
    const dir = project(["ts", "ts-service"]);
    writeProjectPackage(dir, agentRoot);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { scripts: Record<string, string>; dependencies: Record<string, string> };
    expect(pkg.scripts["build:api"]).toBeDefined();
    expect(pkg.dependencies["@trpc/server"]).toBe("11.18.0");
    expect(existsSync(join(dir, "package-lock.json"))).toBe(true);
  });

  test("refuses when an initializer already wrote the package file", () => {
    const dir = project(["ts"]);
    writeFileSync(join(dir, "package.json"), "{}\n");
    expect(() => writeProjectPackage(dir, agentRoot)).toThrow(/package ownership belongs/);
  });

  test("a composition with no package template is refused", () => {
    expect(() => packageFor([], join(agentRoot, "packs"))).toThrow(/exactly one project package template/);
  });
});
