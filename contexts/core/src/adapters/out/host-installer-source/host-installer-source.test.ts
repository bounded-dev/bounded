import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostInstallerSourceConformance } from "../../../application/project-setup/init-project/init-project.host-installer-source.test-support.ts";
import { NodeModulesHostInstallerSource } from "./host-installer-source.ts";

const FAKE_INSTALLER = `export const hostInstaller = {
  host: "fake",
  install: async () => ({ ok: true, value: { host: "fake", changedPaths: ["fake.txt"], skippedBecause: null } }),
};
`;

/** A package installed under the project's node_modules, with `exports` and files. */
function installPackage(root: string, name: string, exports: Record<string, string> | undefined, files: Record<string, string> = {}): void {
  const dir = join(root, "node_modules", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, type: "module", ...(exports === undefined ? {} : { exports }) }));
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
}

function project(dependencies: Record<string, string> | undefined): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bounded-installers-")));
  if (dependencies !== undefined) writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demo", dependencies }));
  return root;
}

hostInstallerSourceConformance("NodeModulesHostInstallerSource", async (kind) => {
  const source = new NodeModulesHostInstallerSource();
  if (kind === "no-package-json") return { source, root: project(undefined) };
  if (kind === "no-installers") {
    const root = project({ "left-pad": "1.0.0" });
    installPackage(root, "left-pad", { ".": "./index.js" }, { "index.js": "export default 1;\n" });
    return { source, root };
  }
  if (kind === "broken-installer") {
    const root = project({ "broken-host": "1.0.0" });
    installPackage(root, "broken-host", { "./host-installer": "./host-installer.js" }, { "host-installer.js": "export const hostInstaller = 42;\n" });
    return { source, root };
  }
  const root = project({ "left-pad": "1.0.0", "fake-host": "1.0.0" });
  installPackage(root, "left-pad", undefined);
  installPackage(root, "fake-host", { "./host-installer": "./host-installer.js" }, { "host-installer.js": FAKE_INSTALLER });
  return { source, root };
});

describe("NodeModulesHostInstallerSource", () => {
  test("looks in devDependencies too, and in name order", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "bounded-installers-")));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demo", dependencies: { "z-host": "1" }, devDependencies: { "a-host": "1" } }));
    for (const name of ["z-host", "a-host"]) {
      installPackage(root, name, { "./host-installer": "./host-installer.js" }, { "host-installer.js": FAKE_INSTALLER.replace('host: "fake"', `host: "${name}"`) });
    }
    const loaded = await new NodeModulesHostInstallerSource().load(root);
    expect(loaded.ok && loaded.value.map((installer) => installer.host)).toEqual(["a-host", "z-host"]);
  });

  test("loads the installers a dependency bundles at ./hosts/<host>/host-installer, beside another package's ./host-installer, in package then export order", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "bounded-installers-")));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demo", devDependencies: { bundle: "1", "third-party": "1" } }));
    const installerFor = (host: string) => FAKE_INSTALLER.replace('host: "fake"', `host: "${host}"`);
    installPackage(
      root,
      "bundle",
      { "./domain": "./domain.js", "./hosts/zed/host-installer": "./zed.js", "./hosts/alpha/host-installer": "./alpha.js", "./hosts/alpha": "./alpha-extension.js" },
      { "zed.js": installerFor("zed"), "alpha.js": installerFor("alpha") },
    );
    installPackage(root, "third-party", { "./host-installer": "./host-installer.js" }, { "host-installer.js": installerFor("third") });
    const loaded = await new NodeModulesHostInstallerSource().load(root);
    expect(loaded.ok && loaded.value.map((installer) => installer.host)).toEqual(["alpha", "zed", "third"]);
  });

  test("refuses a bundled installer export that is not an installer, naming the package and the export", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "bounded-installers-")));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demo", dependencies: { bundle: "1" } }));
    installPackage(root, "bundle", { "./hosts/zed/host-installer": "./zed.js" }, { "zed.js": "export const hostInstaller = 42;\n" });
    const loaded = await new NodeModulesHostInstallerSource().load(root);
    expect(!loaded.ok && loaded.error.includes("bundle") && loaded.error.includes("./hosts/zed/host-installer")).toBe(true);
  });

  test("passes an installer's isInstalled through, answering only true or false, and refuses one that is not a function", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "bounded-installers-")));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demo", dependencies: { aware: "1", odd: "1" } }));
    const aware = `export const hostInstaller = { host: "aware", isInstalled: async (root) => root.length > 0, install: async () => ({ ok: true, value: { host: "aware", changedPaths: [], skippedBecause: null } }) };\n`;
    installPackage(root, "aware", { "./host-installer": "./host-installer.js" }, { "host-installer.js": aware });
    installPackage(root, "odd", { "./host-installer": "./host-installer.js" }, { "host-installer.js": aware.replace('"aware"', '"odd"').replace("isInstalled: async (root) => root.length > 0", "isInstalled: 42") });
    const loaded = await new NodeModulesHostInstallerSource().load(root);
    expect(!loaded.ok && loaded.error.includes("odd")).toBe(true);
    rmSync(join(root, "node_modules", "odd"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demo", dependencies: { aware: "1" } }));
    const only = await new NodeModulesHostInstallerSource().load(root);
    if (!only.ok) throw new Error(only.error);
    expect(await only.value[0]?.isInstalled?.(root)).toBe(true);
  });

  test("refuses a dependency that is declared but not installed, saying to install it", async () => {
    const root = project({ "fake-host": "1.0.0" });
    const loaded = await new NodeModulesHostInstallerSource().load(root);
    expect(!loaded.ok && loaded.error.includes("fake-host") && loaded.error.includes("install")).toBe(true);
  });
});
