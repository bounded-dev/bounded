import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Prepared {
  readonly ok: boolean;
  readonly error?: string;
  readonly value?: { install(): Promise<{ readonly ok: boolean; readonly error?: string }> };
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
