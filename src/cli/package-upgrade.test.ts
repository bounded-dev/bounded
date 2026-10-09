import { describe, expect, test } from "bun:test";
import { installCommand, packageManagerFor, packageManagerOf, tarballFor, withBoundedOverride, withUpgradedSpecs } from "./package-upgrade.ts";

describe("bounded-cli — packageManagerOf: the lockfile first, then package.json's packageManager, then the running npx or bunx, then npm", () => {
  test("prefers each source in turn", () => {
    expect(packageManagerOf(["pnpm-lock.yaml"], { packageManager: "bun@1.3.14" }, "bun/1.3.14")).toBe("pnpm");
    expect(packageManagerOf([], { packageManager: "bun@1.3.14" }, "npm/11.0.0 node/v24")).toBe("bun");
    expect(packageManagerOf([], { packageManager: "yarn@4.0.0" }, undefined)).toBe("yarn");
    expect(packageManagerOf([], {}, "bun/1.3.14 npm/? node/v24")).toBe("bun");
    expect(packageManagerOf([], {}, "pnpm/9.0.0 npm/? node/v24")).toBe("pnpm");
    expect(packageManagerOf([], { packageManager: "deno@2" }, undefined)).toBe("npm");
    expect(packageManagerOf([], {}, undefined)).toBe("npm");
  });
});

describe("bounded-cli — packageManagerFor: the project's package manager, from its lockfile", () => {
  test("names the manager whose lockfile is present, npm when none is", () => {
    expect(packageManagerFor(["package.json", "bun.lock"])).toBe("bun");
    expect(packageManagerFor(["bun.lockb"])).toBe("bun");
    expect(packageManagerFor(["pnpm-lock.yaml"])).toBe("pnpm");
    expect(packageManagerFor(["yarn.lock"])).toBe("yarn");
    expect(packageManagerFor(["package-lock.json"])).toBe("npm");
    expect(packageManagerFor(["package.json"])).toBe("npm");
  });
});

describe("bounded-cli — tarballFor: the packed tarball of a package in an upgrade directory", () => {
  test("picks <name>-<version>.tgz, not another package's tarball that shares the prefix", () => {
    const files = ["bounded-0.2.0.tgz", "bounded-claude-code-0.2.0.tgz", "notes.txt"];
    expect(tarballFor("bounded", files)).toEqual({ ok: true, value: "bounded-0.2.0.tgz" });
    expect(tarballFor("bounded-claude-code", files)).toEqual({ ok: true, value: "bounded-claude-code-0.2.0.tgz" });
  });

  test("refuses a package with no tarball, or more than one, naming them", () => {
    expect(tarballFor("bounded-pi", ["bounded-0.2.0.tgz"]).ok).toBe(false);
    const two = tarballFor("bounded", ["bounded-0.2.0.tgz", "bounded-0.3.0.tgz"]);
    expect(!two.ok && two.error.includes("bounded-0.2.0.tgz") && two.error.includes("bounded-0.3.0.tgz")).toBe(true);
  });
});

describe("bounded-cli — installCommand: every package manager installs from the rewritten manifest", () => {
  // The specs and the override are written into package.json first (withUpgradedSpecs, withBoundedOverride):
  // an `add` would meet npm's override check before the direct dependency it refers to exists (EOVERRIDE).
  test("runs each manager's own plain install", () => {
    expect(installCommand("bun")).toEqual(["bun", "install"]);
    expect(installCommand("npm")).toEqual(["npm", "install"]);
    expect(installCommand("pnpm")).toEqual(["pnpm", "install"]);
    expect(installCommand("yarn")).toEqual(["yarn", "install"]);
  });
});

describe("bounded-cli — withBoundedOverride: each package manager's own override of bounded, while npm's bounded is the legacy 2.x", () => {
  const manifest = { name: "demo", devDependencies: { bounded: "/t/bounded-0.2.0.tgz" }, overrides: { other: "1" }, resolutions: { other: "1" }, pnpm: { overrides: { other: "1" } } };

  test("npm and pnpm refer to the direct dependency's own spec ($bounded), which they require to match", () => {
    expect(withBoundedOverride(manifest, "npm", "/t/bounded-0.2.0.tgz").overrides).toEqual({ other: "1", bounded: "$bounded" });
    expect(withBoundedOverride(manifest, "pnpm", "/t/bounded-0.2.0.tgz").pnpm).toEqual({ overrides: { other: "1", bounded: "$bounded" } });
  });

  test("bun overrides with the tarball, yarn resolves to it; nothing else changes", () => {
    const bun = withBoundedOverride(manifest, "bun", "/t/bounded-0.2.0.tgz");
    expect(bun.overrides).toEqual({ other: "1", bounded: "file:/t/bounded-0.2.0.tgz" });
    expect(bun.resolutions).toEqual({ other: "1" });
    const yarn = withBoundedOverride(manifest, "yarn", "/t/bounded-0.2.0.tgz");
    expect(yarn.resolutions).toEqual({ other: "1", bounded: "file:/t/bounded-0.2.0.tgz" });
    expect(yarn.overrides).toEqual({ other: "1" });
    expect(manifest.overrides).toEqual({ other: "1" });
  });
});

describe("bounded-cli — withUpgradedSpecs: the manifest bun installs the upgrade from", () => {
  test("replaces each package's spec in its own group, keeping everything else", () => {
    const manifest = { name: "demo", dependencies: { bounded: "/old/bounded-0.1.0.tgz", zod: "4" }, devDependencies: { "bounded-claude-code": "/old/c.tgz" }, overrides: { x: "1" } };
    expect(
      withUpgradedSpecs(manifest, [
        { name: "bounded", dev: false, spec: "/new/bounded-0.2.0.tgz" },
        { name: "bounded-claude-code", dev: true, spec: "/new/c.tgz" },
      ]),
    ).toEqual({ name: "demo", dependencies: { bounded: "/new/bounded-0.2.0.tgz", zod: "4" }, devDependencies: { "bounded-claude-code": "/new/c.tgz" }, overrides: { x: "1" } });
    expect(manifest.dependencies.bounded).toBe("/old/bounded-0.1.0.tgz");
  });
});
