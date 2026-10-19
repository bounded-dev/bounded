import { expect, test } from "bun:test";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

test("typecheck succeeds in a clean checkout before dist is built", () => {
  const checkout = mkdtempSync(join(tmpdir(), "bounded-clean-typecheck-"));
  try {
    const tracked = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    if (tracked.exitCode !== 0) throw new Error(`cannot list tracked files: ${tracked.stderr.toString()}`);
    for (const path of tracked.stdout.toString().split("\0").filter(Boolean)) {
      const destination = join(checkout, path);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(ROOT, path), destination);
    }
    expect(existsSync(join(checkout, "src", "dist"))).toBe(false);

    // Recreate workspace links inside the checkout; share only installed third-party dependencies.
    const installedModules = join(ROOT, "node_modules");
    const checkoutModules = join(checkout, "node_modules");
    mkdirSync(checkoutModules);
    for (const name of readdirSync(installedModules)) {
      const source = join(installedModules, name);
      const destination = join(checkoutModules, name);
      const entry = lstatSync(source);
      if (entry.isSymbolicLink()) symlinkSync(readlinkSync(source), destination);
      else if (entry.isDirectory()) symlinkSync(source, destination, "dir");
      else copyFileSync(source, destination);
    }
    expect(existsSync(join(checkout, "src", "dist"))).toBe(false);

    const checked = Bun.spawnSync([process.execPath, "run", "typecheck"], { cwd: checkout, stdout: "pipe", stderr: "pipe" });
    if (checked.exitCode !== 0) throw new Error(`clean checkout typecheck failed:\n${checked.stdout.toString()}${checked.stderr.toString()}`);
    expect(checked.exitCode).toBe(0);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});
