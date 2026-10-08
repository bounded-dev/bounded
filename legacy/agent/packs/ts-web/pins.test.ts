import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// The web app's stack is exact-pinned by its workspace template (ADR 2026-029).
// There are two places a version can be written down: the harness's own
// package.json, which is what the harness's suites compile emitted code
// against, and the template manifest a generated web app is born with. Two
// copies of a version number drift, so this file holds them together: bumping
// a pin means editing both and watching this pass.

const root = join(import.meta.dirname, "..", "..");

interface Manifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

const read = (path: string): Manifest => JSON.parse(readFileSync(path, "utf8")) as Manifest;

describe("the web app template's pins", () => {
  const template = read(join(import.meta.dirname, "templates", "web", "package.json"));
  const all = { ...template.dependencies, ...template.devDependencies };
  const installed = read(join(root, "package.json")).devDependencies ?? {};

  test("name the whole client stack, and nothing of the retired build stack", () => {
    expect(Object.keys(all).sort()).toEqual(["@trpc/client", "@trpc/server", "@types/react", "@types/react-dom", "react", "react-dom"]);
  });

  test("are exact — a range is a different app on a different day", () => {
    for (const [name, version] of Object.entries(all)) expect(version, name).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
  });

  test("match the versions the harness itself runs", () => {
    const drifted = Object.entries(all)
      .filter(([name, version]) => installed[name] !== version)
      .map(([name, version]) => `${name}: template ${version}, package.json ${installed[name]}`);
    expect(drifted).toEqual([]);
  });

  test("split runtime dependencies from type-only ones, and one tRPC version for both halves of the wire", () => {
    expect(Object.keys(template.dependencies ?? {})).toEqual(["@trpc/client", "@trpc/server", "react", "react-dom"]);
    expect(Object.keys(template.devDependencies ?? {})).toEqual(["@types/react", "@types/react-dom"]);
    expect(all["@trpc/client"]).toBe(all["@trpc/server"]);
  });
});
