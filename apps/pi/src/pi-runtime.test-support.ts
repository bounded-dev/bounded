// Runs code the way pi does: under node, with the jiti that pi loads
// extensions with. pi's runtime differs from bun's (realpathSync keeps the
// typed case under node), so behaviour pi depends on is checked here too.
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The jiti inside the installed pi, if pi is installed where Homebrew puts it. */
export const PI_JITI = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
const node = Bun.which("node");

/** Whether pi's runtime can be used here: node on PATH and pi's jiti installed. */
export const piRuntimeAvailable = node !== null && existsSync(PI_JITI);

/**
 * Runs `body` as an ES module under node, after `const load = (path, options?) => ...`
 * imports a module through pi's jiti, as pi imports an extension. `body`
 * prints its result as JSON on stdout, which is parsed and returned.
 */
export function underPi(body: string, ...args: string[]): unknown {
  if (node === null) throw new Error("node is not on PATH");
  const script = join(mkdtempSync(join(tmpdir(), "bounded-pi-runtime-")), "run.mjs");
  writeFileSync(
    script,
    [
      'import { pathToFileURL } from "node:url";',
      `const { createJiti } = await import(pathToFileURL(${JSON.stringify(PI_JITI)}).href);`,
      "const jiti = createJiti(import.meta.url, { moduleCache: false });",
      "const load = (path, options) => jiti.import(path, options);",
      body,
    ].join("\n"),
  );
  const run = Bun.spawnSync([node, script, ...args]);
  if (run.exitCode !== 0) throw new Error(`node exited ${run.exitCode}: ${run.stderr.toString()}`);
  return JSON.parse(run.stdout.toString());
}
