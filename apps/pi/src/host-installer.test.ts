import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostInstaller } from "./host-installer.ts";
import { piLoader } from "./install.ts";

function project(withPi: boolean): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bounded-pi-host-install-")));
  if (withPi) mkdirSync(join(root, ".pi"));
  return root;
}

const LOADER = piLoader();

describe("the pi host installer", () => {
  test("names its host", () => {
    expect(hostInstaller.host).toBe("pi");
  });

  test("with .pi/ present, writes the loader where pi discovers it", async () => {
    const root = project(true);
    expect(await hostInstaller.install(root)).toEqual({ ok: true, value: { host: "pi", changedPaths: [LOADER.path], skippedBecause: null } });
    expect(readFileSync(join(root, LOADER.path), "utf8")).toBe(LOADER.content);
  });

  test("without .pi/, skips pi and writes nothing", async () => {
    const root = project(false);
    const done = await hostInstaller.install(root);
    expect(done.ok && done.value.changedPaths).toEqual([]);
    expect(done.ok && done.value.skippedBecause).toContain(".pi/");
    expect(existsSync(join(root, ".pi"))).toBe(false);
  });

  test("is idempotent, and replaces an out-of-date loader", async () => {
    const root = project(true);
    await hostInstaller.install(root);
    expect(await hostInstaller.install(root)).toEqual({ ok: true, value: { host: "pi", changedPaths: [], skippedBecause: null } });
    writeFileSync(join(root, LOADER.path), "// an older loader\n");
    expect(await hostInstaller.install(root)).toEqual({ ok: true, value: { host: "pi", changedPaths: [LOADER.path], skippedBecause: null } });
    expect(readFileSync(join(root, LOADER.path), "utf8")).toBe(LOADER.content);
  });

  test("says whether bounded is installed for pi: its loader exists", async () => {
    const root = project(true);
    expect(await hostInstaller.isInstalled?.(root)).toBe(false);
    await hostInstaller.install(root);
    expect(await hostInstaller.isInstalled?.(root)).toBe(true);
    expect(await hostInstaller.isInstalled?.(project(false))).toBe(false);
  });
});
