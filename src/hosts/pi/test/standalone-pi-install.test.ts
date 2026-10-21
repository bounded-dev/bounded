import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { standalonePiLoader } from "../standalone-install.ts";

interface Prepared {
  readonly ok: boolean;
  readonly error?: string;
  readonly value?: {
    install(): Promise<{ readonly ok: boolean; readonly error?: string; readonly value?: { readonly changedPaths: readonly string[] } }>;
    restore(): Promise<void>;
  };
}

// The module is introduced by this slice; the red commit deliberately has no installer yet.
async function prepare(projectRoot: string): Promise<Prepared> {
  const module: unknown = await import("../standalone-install.ts");
  if (typeof module !== "object" || module === null || !("prepareStandalonePiExtension" in module)) throw new Error("Pi installer is absent");
  const installer = module as { prepareStandalonePiExtension(root: string, executable: string): Promise<Prepared> };
  return installer.prepareStandalonePiExtension(projectRoot, "/verified/bounded");
}

test("Pi installer refuses an intervening user edit after preparation", async () => {
  const root = mkdtempSync(join(tmpdir(), "bounded-pi-install-race-"));
  try {
    mkdirSync(join(root, ".pi"));
    const prepared = await prepare(root);
    expect(prepared.ok).toBe(true);
    const loader = join(root, ".pi", "extensions", "bounded", "index.ts");
    mkdirSync(join(root, ".pi", "extensions", "bounded"), { recursive: true });
    const userBytes = "// user extension written after Bounded inspected the path\n";
    writeFileSync(loader, userBytes);
    const installed = await prepared.value?.install();
    expect(installed?.ok).toBe(false);
    expect(installed?.error).toMatch(/changed|edited|recheck|inspect|retry/i);
    expect(readFileSync(loader, "utf8")).toBe(userBytes);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Pi installer refuses an intervening link before creating its loader", async () => {
  const root = mkdtempSync(join(tmpdir(), "bounded-pi-install-link-"));
  try {
    mkdirSync(join(root, ".pi"));
    const prepared = await prepare(root);
    expect(prepared.ok).toBe(true);
    const outside = join(root, "outside");
    mkdirSync(outside);
    mkdirSync(join(root, ".pi", "extensions"));
    symlinkSync(outside, join(root, ".pi", "extensions", "bounded"), "dir");
    const installed = await prepared.value?.install();
    expect(installed?.ok).toBe(false);
    expect(installed?.error).toMatch(/linked|directory|changed|inspect|retry/i);
    expect(existsSync(join(outside, "index.ts"))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Pi no-op install rechecks an existing loader before reporting success", async () => {
  const root = mkdtempSync(join(tmpdir(), "bounded-pi-noop-race-"));
  try {
    const loader = join(root, ".pi", "extensions", "bounded", "index.ts");
    mkdirSync(join(root, ".pi", "extensions", "bounded"), { recursive: true });
    writeFileSync(loader, standalonePiLoader("/verified/bounded"));
    const prepared = await prepare(root);
    expect(prepared.ok).toBe(true);
    const userBytes = "// user edit after preparation\n";
    writeFileSync(loader, userBytes);
    const installed = await prepared.value?.install();
    expect(installed?.ok).toBe(false);
    expect(installed?.error).toMatch(/changed|edited|recheck|inspect|retry/i);
    expect(readFileSync(loader, "utf8")).toBe(userBytes);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Pi no-op rollback does not touch a loader it did not install", async () => {
  const root = mkdtempSync(join(tmpdir(), "bounded-pi-noop-restore-"));
  try {
    const loader = join(root, ".pi", "extensions", "bounded", "index.ts");
    mkdirSync(join(root, ".pi", "extensions", "bounded"), { recursive: true });
    writeFileSync(loader, standalonePiLoader("/verified/bounded"), { mode: 0o600 });
    const prepared = await prepare(root);
    expect(prepared.ok).toBe(true);
    const installed = await prepared.value?.install();
    expect(installed?.ok).toBe(true);
    expect(installed?.value?.changedPaths).toEqual([]);
    const before = statSync(loader);
    await prepared.value?.restore();
    const after = statSync(loader);
    expect(after.ino).toBe(before.ino);
    expect(after.mode & 0o777).toBe(before.mode & 0o777);
    const userBytes = "// user edit after no-op install\n";
    writeFileSync(loader, userBytes);
    await expect(prepared.value?.restore()).resolves.toBeUndefined();
    expect(readFileSync(loader, "utf8")).toBe(userBytes);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
