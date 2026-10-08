import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const built = resolve(root, "build-info.json");
let detail;
if (existsSync(built) && root.includes("/node_modules/")) {
  const info = JSON.parse(readFileSync(built, "utf8"));
  detail = `${info.commit}${info.dirty ? "+working-tree" : ""}`;
} else {
  try {
    const repo = resolve(root, "..");
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--", "agent"], { cwd: repo, encoding: "utf8" }).trim();
    detail = `${commit}${dirty ? "+working-tree" : ""}`;
  } catch {
    detail = "unknown source";
  }
}
console.log(`bounded ${pkg.version} (${detail})`);
