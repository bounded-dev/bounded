import { describe, expect, test } from "bun:test";
import { packageManagerFor, tarballFor, upgradeCommands, withUpgradedSpecs } from "./package-upgrade.ts";

describe("packageManagerFor: the project's package manager, from its lockfile", () => {
  test("names the manager whose lockfile is present, npm when none is", () => {
    expect(packageManagerFor(["package.json", "bun.lock"])).toBe("bun");
    expect(packageManagerFor(["bun.lockb"])).toBe("bun");
    expect(packageManagerFor(["pnpm-lock.yaml"])).toBe("pnpm");
    expect(packageManagerFor(["yarn.lock"])).toBe("yarn");
    expect(packageManagerFor(["package-lock.json"])).toBe("npm");
    expect(packageManagerFor(["package.json"])).toBe("npm");
  });
});

describe("tarballFor: the packed tarball of a package in an upgrade directory", () => {
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

describe("upgradeCommands: the package manager commands that upgrade the bounded packages", () => {
  const packages = [
    { name: "bounded", dev: false, spec: "bounded@latest" },
    { name: "bounded-claude-code", dev: true, spec: "/t/bounded-claude-code-0.2.0.tgz" },
  ];

  test("adds dependencies and devDependencies each where they were", () => {
    expect(upgradeCommands("bun", packages)).toEqual([
      ["bun", "add", "bounded@latest"],
      ["bun", "add", "--dev", "/t/bounded-claude-code-0.2.0.tgz"],
    ]);
    expect(upgradeCommands("npm", packages)).toEqual([
      ["npm", "install", "bounded@latest"],
      ["npm", "install", "--save-dev", "/t/bounded-claude-code-0.2.0.tgz"],
    ]);
    expect(upgradeCommands("pnpm", packages)[1]).toEqual(["pnpm", "add", "--save-dev", "/t/bounded-claude-code-0.2.0.tgz"]);
    expect(upgradeCommands("yarn", packages)[1]).toEqual(["yarn", "add", "--dev", "/t/bounded-claude-code-0.2.0.tgz"]);
  });

  test("runs no command for a group with no package", () => {
    expect(upgradeCommands("bun", [packages[0] ?? { name: "", dev: false, spec: "" }])).toEqual([["bun", "add", "bounded@latest"]]);
  });
});

describe("withUpgradedSpecs: the manifest bun installs the upgrade from", () => {
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
