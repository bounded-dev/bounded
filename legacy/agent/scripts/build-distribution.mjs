// Compile each module separately for npm. Node cannot type-strip TypeScript
// under node_modules, and module boundaries preserve isMainModule() guards.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Harness tests and their fixtures: never runtime assets. A pack's
 *  reference/ tree is the exception for tests — init ships it whole, tests
 *  included — but not for its testdata or installed node_modules. */
function excluded(rel) {
  const parts = rel.split("/");
  if (parts.includes("node_modules") || parts.includes("testdata")) return true;
  if (parts.includes("reference")) return false;
  return /\.test\.tsx?$|\.test-support\.ts$/.test(rel);
}

function walk(root, base) {
  const out = [];
  for (const entry of readdirSync(join(root, base), { withFileTypes: true })) {
    const rel = `${base}/${entry.name}`;
    if (excluded(rel)) continue;
    if (entry.isDirectory()) out.push(...walk(root, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/** The trees the distribution compiles, read from tsconfig.dist.json. */
export function compiledTrees(root) {
  const { include } = JSON.parse(readFileSync(join(root, "tsconfig.dist.json"), "utf8"));
  return [...new Set(include.map((pattern) => pattern.split("/")[0]))];
}

/** Every runtime file of the compiled trees the compiler did not emit:
 *  contrib.json and default-stack.json, reference projects, templates,
 *  skills, package.json files, READMEs — and any source tsc excluded. */
export function distributionAssets(root, outDir) {
  return compiledTrees(root).flatMap((tree) => walk(root, tree))
    .filter((rel) => !(rel.endsWith(".ts") && existsSync(join(outDir, rel.slice(0, -3) + ".js"))));
}

/** Build the harness at `root` into `outDir` (default `<root>/dist`): the
 *  compiled modules, and every runtime asset beside them at its source-
 *  relative path, since a compiled pack script resolves its data (its
 *  reference/package.json, say) relative to itself. */
export function buildDistribution(root, outDir = join(root, "dist")) {
  rmSync(outDir, { recursive: true, force: true });
  execFileSync(process.execPath, [
    join(root, "node_modules", "typescript", "bin", "tsc"), "-p", join(root, "tsconfig.dist.json"), "--outDir", outDir,
  ], { cwd: root, stdio: "inherit" });
  for (const rel of distributionAssets(root, outDir)) {
    mkdirSync(dirname(join(outDir, rel)), { recursive: true });
    copyFileSync(join(root, rel), join(outDir, rel));
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const root = resolve(import.meta.dirname, "..");
  const repository = resolve(root, "..");
  const git = (args) => execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
  const commit = git(["rev-parse", "HEAD"]);
  const dirty = git(["status", "--porcelain", "--", "agent"]) !== "";
  writeFileSync(join(root, "build-info.json"), JSON.stringify({ commit, dirty }) + "\n");
  // npm intentionally excludes package-lock.json from tarballs. This generated
  // data copy lets the installed CLI reproduce pinned project lockfiles.
  copyFileSync(join(root, "package-lock.json"), join(root, "installer-lock.json"));
  buildDistribution(root);
}
