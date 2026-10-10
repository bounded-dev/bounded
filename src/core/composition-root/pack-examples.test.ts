// Every shipped pack's examples (src/packs/<name>/examples/<slug>.config.ts,
// ADRs 2026-009 and 2026-013) are complete project configurations. Nothing
// imports an example: each is read as text and opened as a project's
// bounded.config.ts, as a project would open it, so an example cannot drift
// from the API.
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prereqsPortProvisions } from "bounded/prereqs/adapters";
import { protectedPathsPortProvisions } from "bounded/protected-paths/adapters";
import * as ts from "typescript";
import { openProject } from "./open-project.ts";

/** bounded's directory, src/: what a project's node_modules/bounded links to. */
const BOUNDED = resolve(import.meta.dir, "../..");
const PACKS = join(BOUNDED, "packs");
process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "bounded-state-"));

/** Every shipped pack's directory name under src/packs/. */
const shippedPackNames = readdirSync(PACKS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
/** Every example of a shipped pack, from src/: packs/<name>/examples/<slug>.config.ts. */
const examplePaths = [...new Glob("packs/*/examples/*.config.ts").scanSync({ cwd: BOUNDED })].sort();

/** A git project whose bounded.config.ts is `config`, with bounded installed as a link to src/. */
function projectWithConfig(config: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bounded-example-")));
  mkdirSync(join(root, "node_modules"));
  symlinkSync(BOUNDED, join(root, "node_modules", "bounded"), "dir");
  writeFileSync(join(root, ".gitignore"), "node_modules/\n.bounded/\n");
  writeFileSync(join(root, "bounded.config.ts"), config);
  spawnSync("git", ["init", "--quiet"], { cwd: root });
  return root;
}

/** The text of the TSDoc on a file's `export default`, or undefined when it has none. */
function defaultExportTsDoc(path: string, text: string): string | undefined {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const exportDefault = source.statements.find((statement): statement is ts.ExportAssignment => ts.isExportAssignment(statement) && statement.isExportEquals !== true);
  if (exportDefault === undefined) return undefined;
  const docs = ts.getJSDocCommentsAndTags(exportDefault).filter((doc): doc is ts.JSDoc => ts.isJSDoc(doc));
  const doc = docs.at(-1);
  return doc === undefined ? undefined : (ts.getTextOfJSDocComment(doc.comment) ?? "");
}

describe("shipped packs' examples", () => {
  test("each shipped pack has at least one example", () => {
    expect(shippedPackNames.length).toBeGreaterThan(0);
    for (const name of shippedPackNames) {
      expect({ pack: name, examples: examplePaths.filter((path) => path.startsWith(`packs/${name}/examples/`)).length > 0 }).toEqual({ pack: name, examples: true });
    }
  });

  test("every shipped pack's example opens as a project's configuration with no problem", async () => {
    expect(examplePaths.length).toBeGreaterThan(0);
    for (const examplePath of examplePaths) {
      const root = projectWithConfig(readFileSync(join(BOUNDED, examplePath), "utf8"));
      const { judge, problem } = await openProject(root, { ports: [...protectedPathsPortProvisions(), ...prereqsPortProvisions()] });
      expect({ example: examplePath, problem }).toEqual({ example: examplePath, problem: null });
      const verdict = await judge({ kind: "tool-use", role: null, tool: "read", effects: [{ kind: "read", path: "README.md" }] });
      expect({ example: examplePath, verdict: verdict.kind }).toEqual({ example: examplePath, verdict: "allow" });
    }
  });

  test("every example's default export carries a TSDoc title", () => {
    expect(examplePaths.length).toBeGreaterThan(0);
    for (const examplePath of examplePaths) {
      const tsDoc = defaultExportTsDoc(examplePath, readFileSync(join(BOUNDED, examplePath), "utf8"));
      const title = tsDoc?.split("\n")[0]?.trim() ?? "";
      expect({ example: examplePath, hasTitle: title !== "" }).toEqual({ example: examplePath, hasTitle: true });
    }
  });
});
