// Runs code the way pi does: under node, with the jiti that pi loads
// extensions with. pi's runtime differs from bun's (realpathSync keeps the
// typed case under node), so behaviour pi depends on is checked here too.
import { test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const PACKAGE = "@earendil-works/pi-coding-agent";

const isPi = (dir: string): boolean => {
  try {
    return (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown }).name === PACKAGE;
  } catch {
    return false;
  }
};

/** The installed pi package: $PI_CODING_AGENT_DIR, else where the `pi` on PATH lives, else the global npm root. */
function findPi(): string | undefined {
  const fromEnv = process.env.PI_CODING_AGENT_DIR;
  if (fromEnv !== undefined && fromEnv !== "") return isPi(fromEnv) ? fromEnv : undefined;
  const binary = Bun.which("pi");
  if (binary !== null) {
    for (let dir = dirname(realpathSync(binary)); dir !== dirname(dir); dir = dirname(dir)) if (isPi(dir)) return dir;
  }
  const npm = Bun.which("npm");
  const root = npm === null ? "" : Bun.spawnSync([npm, "root", "-g"]).stdout.toString().trim();
  return root !== "" && isPi(join(root, PACKAGE)) ? join(root, PACKAGE) : undefined;
}

const node = Bun.which("node");
const pi = findPi();

/** Whether pi's runtime can be used here: node on PATH and pi installed. */
export const piRuntimeAvailable = node !== null && pi !== undefined;

/** Registers a visibly skipped case naming why, when pi's runtime cannot be used here. Call inside each pi-runtime describe. */
export function reportPiRuntime(): void {
  if (piRuntimeAvailable) return;
  const why = node === null ? "node is not on PATH" : "pi not found; set PI_CODING_AGENT_DIR to its package directory";
  test.skip(`skipped: ${why}`, () => {});
}

/**
 * Runs `body` as an ES module under node, after `const load = (path, options?) => ...`
 * imports a module through pi's jiti with pi's own options, as pi imports an
 * extension. `body` prints its result as JSON on stdout, which is parsed and returned.
 */
export function underPi(body: string, ...args: string[]): unknown {
  if (node === null || pi === undefined) throw new Error("pi's runtime is not available");
  const script = join(mkdtempSync(join(tmpdir(), "bounded-pi-runtime-")), "run.mjs");
  writeFileSync(
    script,
    [
      'import { createRequire } from "node:module";',
      `const required = createRequire(${JSON.stringify(join(pi, "package.json"))})("jiti");`,
      "const createJiti = required.createJiti ?? required;",
      "const jiti = createJiti(import.meta.url, { moduleCache: false, tryNative: false });",
      "const load = (path, options) => jiti.import(path, options);",
      body,
    ].join("\n"),
  );
  const run = Bun.spawnSync([node, script, ...args]);
  if (run.exitCode !== 0) throw new Error(`node exited ${run.exitCode}: ${run.stderr.toString()}`);
  return JSON.parse(run.stdout.toString());
}
