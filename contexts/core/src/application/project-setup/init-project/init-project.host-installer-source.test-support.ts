import { describe, expect, test } from "bun:test";
import type { HostInstallerSource } from "./init-project.contract.ts";

/**
 * The project kinds every HostInstallerSource is tested on:
 * - "one-installer": a dependency whose installer has host "fake" and, when run, reports changing "fake.txt";
 * - "no-installers": dependencies, none of which offers an installer;
 * - "broken-installer": a dependency named "broken-host" offering an installer that is not one;
 * - "no-package-json": a directory with no package.json.
 */
export type HostInstallerProject = "one-installer" | "no-installers" | "broken-installer" | "no-package-json";

/** The behaviour every HostInstallerSource must have. */
export function hostInstallerSourceConformance(name: string, fixture: (project: HostInstallerProject) => Promise<{ readonly source: HostInstallerSource; readonly root: string }>): void {
  describe(`${name} conforms to HostInstallerSource`, () => {
    test("loads the installer a dependency offers, ready to run", async () => {
      const { source, root } = await fixture("one-installer");
      const loaded = await source.load(root);
      if (!loaded.ok) throw new Error(loaded.error);
      expect(loaded.value.map((installer) => installer.host)).toEqual(["fake"]);
      expect(await loaded.value[0]?.install(root)).toEqual({ ok: true, value: { host: "fake", changedPaths: ["fake.txt"], skippedBecause: null } });
    });

    test("finds no installer when no dependency offers one", async () => {
      const { source, root } = await fixture("no-installers");
      expect(await source.load(root)).toEqual({ ok: true, value: [] });
    });

    test("refuses an installer that is not one, naming its package", async () => {
      const { source, root } = await fixture("broken-installer");
      const loaded = await source.load(root);
      expect(!loaded.ok && loaded.error.includes("broken-host")).toBe(true);
    });

    test("refuses a project with no package.json, saying to install the packages first", async () => {
      const { source, root } = await fixture("no-package-json");
      const loaded = await source.load(root);
      expect(!loaded.ok && loaded.error.includes("package.json")).toBe(true);
    });
  });
}
