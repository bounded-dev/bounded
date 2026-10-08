// The behaviour every HostInstaller must have. Host adapter packages run it
// from their own tests through `bounded/testing/host-installer-conformance`.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { HostInstaller } from "./init-project.contract.ts";

/**
 * The projects an installer is tested in:
 * - "fresh": a project the installer installs into (its host in use, its package installed), nothing installed yet;
 * - "unreadable": the same, except the file the installer must read before writing it cannot be read (it is a directory).
 * `snapshot` gives the project's files and their contents, to show what a refusal left alone.
 */
export interface HostInstallerFixture {
  readonly root: string;
  snapshot(): Record<string, string>;
}

/** Every file under `root` with its content, and every directory as "<directory>": what a fixture's snapshot can return. */
export function snapshotFiles(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const key = relative(root, path);
      if (entry.isDirectory()) {
        out[key] = "<directory>";
        walk(path);
      } else out[key] = readFileSync(path, "utf8");
    }
  };
  walk(root);
  return out;
}

export function hostInstallerConformance(name: string, installer: HostInstaller, fixture: (project: "fresh" | "unreadable") => Promise<HostInstallerFixture>): void {
  describe(`${name} conforms to HostInstaller`, () => {
    test("reports under its own host name, and only project-relative paths", async () => {
      const { root } = await fixture("fresh");
      const installed = await installer.install(root);
      if (!installed.ok) throw new Error(installed.error);
      expect(installed.value.host).toBe(installer.host);
      expect(installed.value.changedPaths.length).toBeGreaterThan(0);
      for (const path of installed.value.changedPaths) {
        expect(path.startsWith("/")).toBe(false);
        expect(path.split("/")).not.toContain("..");
      }
    });

    test("is idempotent: a second install changes nothing", async () => {
      const project = await fixture("fresh");
      await installer.install(project.root);
      const before = project.snapshot();
      expect(await installer.install(project.root)).toEqual({ ok: true, value: { host: installer.host, changedPaths: [], skippedBecause: null } });
      expect(project.snapshot()).toEqual(before);
    });

    test("refuses when what it must read cannot be read, and changes nothing", async () => {
      const project = await fixture("unreadable");
      const before = project.snapshot();
      const installed = await installer.install(project.root);
      expect(installed.ok).toBe(false);
      expect(project.snapshot()).toEqual(before);
    });
  });
}
