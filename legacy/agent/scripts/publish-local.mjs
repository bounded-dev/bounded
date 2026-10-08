// Install an immutable local build using npm's global package layout.
// The post-install resolution check catches another `bounded` earlier on PATH.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.argv.length > 2) throw new Error("publish:local takes no arguments");
const root = resolve(import.meta.dirname, "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const target = mkdtempSync(join(tmpdir(), "bounded-local-publish-"));
try {
  const packed = execFileSync(npm, ["pack", "--pack-destination", target, "--loglevel=error"], {
    cwd: root, encoding: "utf8", stdio: ["inherit", "pipe", "inherit"],
  }).trim().split("\n").at(-1);
  if (!packed?.endsWith(".tgz")) throw new Error("npm pack did not produce a tarball");
  execFileSync(npm, ["install", "--global", "--no-audit", "--no-fund", join(target, packed)], {
    cwd: root, stdio: "inherit",
  });
  const info = JSON.parse(readFileSync(join(root, "build-info.json"), "utf8"));
  const expected = `${info.commit}${info.dirty ? "+working-tree" : ""}`;
  const actual = execFileSync("bounded", ["--version"], { encoding: "utf8" }).trim();
  if (!actual.includes(expected)) {
    const resolved = execFileSync("which", ["bounded"], { encoding: "utf8" }).trim();
    throw new Error(`Installed the build, but PATH resolves ${resolved}: ${actual}. Put npm's global bin before the stale command on PATH.`);
  }
  console.log(`Local publish OK: ${actual}`);
} finally {
  rmSync(target, { recursive: true, force: true });
}
