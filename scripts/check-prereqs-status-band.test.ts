// The prereqs status band's own check (ADR 2026-027): it needs Claude Code,
// so it is outside `bun run check`, and without Claude Code it stops at once.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts", "check-prereqs-status-band.ts");

describe("check-prereqs-status-band", () => {
  test("without Claude Code on PATH it stops at once, naming claude, and leaves nothing behind", () => {
    const path = mkdtempSync(join(tmpdir(), "band-check-path-"));
    const temporary = mkdtempSync(join(tmpdir(), "band-check-tmp-"));
    const ran = Bun.spawnSync([process.execPath, SCRIPT], { cwd: ROOT, env: { PATH: path, TMPDIR: temporary, HOME: mkdtempSync(join(tmpdir(), "band-check-home-")) }, stdout: "pipe", stderr: "pipe" });
    expect(ran.exitCode).toBe(2);
    expect(ran.stderr.toString()).toContain("claude");
    expect(readdirSync(temporary)).toEqual([]);
  });

  test("it is the workspace's check:prereqs-status-band script", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    expect(manifest.scripts?.["check:prereqs-status-band"]).toBe("bun scripts/check-prereqs-status-band.ts");
  });
});
