import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as standaloneRuntime from "../../standalone-runtime.ts";

test("multi-host init rolls back only completed host writes after a later user edit", async () => {
  const root = mkdtempSync(join(tmpdir(), "bounded-host-rollback-"));
  try {
    const firstPath = join(root, "first-host.json");
    const secondPath = join(root, "second-host.ts");
    let failedHostRestoreCalls = 0;
    const userBytes = "// user changed this host while setup was running\n";
    const helper: unknown = Reflect.get(standaloneRuntime, "installPreparedStandaloneHosts");
    if (typeof helper !== "function") throw new Error("standalone host install transaction is missing");
    const installPreparedStandaloneHosts = helper as (steps: readonly {
      readonly host: string;
      readonly install: () => Promise<{ readonly ok: true; readonly value: { readonly host: string; readonly changedPaths: readonly string[]; readonly skippedBecause: null } } | { readonly ok: false; readonly error: string }>;
      readonly restore: () => Promise<void>;
    }[]) => Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string }>;
    const installed = await installPreparedStandaloneHosts([
      { host: "claude-code", async install() {
        writeFileSync(firstPath, "installed\n");
        return { ok: true as const, value: { host: "claude-code", changedPaths: [firstPath], skippedBecause: null } };
      }, async restore() { rmSync(firstPath, { force: true }); } },
      { host: "pi", async install() {
        writeFileSync(secondPath, userBytes);
        return { ok: false as const, error: "Pi loader changed after preparation; preserve the user edit" };
      }, async restore() { failedHostRestoreCalls++; throw new Error("failed host does not own the user edit"); } },
    ]);
    expect(installed.ok).toBe(false);
    if (!installed.ok) expect(installed.error).toContain("Pi loader changed after preparation");
    expect(existsSync(firstPath)).toBe(false);
    expect(readFileSync(secondPath, "utf8")).toBe(userBytes);
    expect(failedHostRestoreCalls).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("multi-host rollback restores every safe completed host after a later host refuses restoration", async () => {
  const root = mkdtempSync(join(tmpdir(), "bounded-host-rollback-all-"));
  try {
    const firstPath = join(root, "first-host.json");
    const secondPath = join(root, "second-host.ts");
    const userBytes = "// edited after both host installers succeeded\n";
    const install: unknown = Reflect.get(standaloneRuntime, "installPreparedStandaloneHosts");
    const rollback: unknown = Reflect.get(standaloneRuntime, "restoreInstalledStandaloneHosts");
    if (typeof install !== "function" || typeof rollback !== "function") throw new Error("standalone host rollback transaction is missing");
    const installHosts = install as (steps: readonly {
      readonly host: string;
      readonly install: () => Promise<{ readonly ok: true; readonly value: { readonly host: string; readonly changedPaths: readonly string[]; readonly skippedBecause: null } }>;
      readonly restore: () => Promise<void>;
    }[]) => Promise<{ readonly ok: true; readonly value: readonly { readonly host: string; readonly restore: () => Promise<void> }[] } | { readonly ok: false; readonly error: string }>;
    const rollbackHosts = rollback as (steps: readonly { readonly host: string; readonly restore: () => Promise<void> }[]) => Promise<readonly string[]>;
    const installed = await installHosts([
      { host: "claude-code", async install() {
        writeFileSync(firstPath, "installed\n");
        return { ok: true as const, value: { host: "claude-code", changedPaths: [firstPath], skippedBecause: null } };
      }, async restore() { rmSync(firstPath, { force: true }); } },
      { host: "pi", async install() {
        writeFileSync(secondPath, "installed\n");
        return { ok: true as const, value: { host: "pi", changedPaths: [secondPath], skippedBecause: null } };
      }, async restore() { throw new Error("Pi loader was edited by the user"); } },
    ]);
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    writeFileSync(secondPath, userBytes);
    const failures = await rollbackHosts(installed.value);
    expect(failures).toEqual(["pi: Pi loader was edited by the user"]);
    expect(existsSync(firstPath)).toBe(false);
    expect(readFileSync(secondPath, "utf8")).toBe(userBytes);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
