// bounded-example's end-to-end tests (ADR 2026-030): its examples are opened
// as projects' configurations, and its pack judges a project's tool uses, as
// src/core/composition-root/pack-examples.test.ts does for the shipped packs,
// which may not reach a published pack. A project installs bounded and
// bounded-example side by side: here node_modules/bounded links to src/ and
// node_modules/bounded-example to this package.
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openProject } from "bounded/open-project";
import * as ts from "typescript";

/** This package's directory, src/published-packs/example. */
const PACKAGE = resolve(import.meta.dir, "..");
/** bounded's directory, src/: what a project's node_modules/bounded links to. */
const BOUNDED = resolve(PACKAGE, "../..");
/** Every example of the package's packs: packs/<pack>/examples/<slug>.config.ts. */
const examplePaths = [...new Glob("packs/*/examples/*.config.ts").scanSync({ cwd: PACKAGE })].sort();

/** A git project whose bounded.config.ts is `config`, with bounded and bounded-example installed as links. */
function projectWithConfig(config: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bounded-example-e2e-")));
  mkdirSync(join(root, "node_modules"));
  symlinkSync(BOUNDED, join(root, "node_modules", "bounded"), "dir");
  symlinkSync(PACKAGE, join(root, "node_modules", "bounded-example"), "dir");
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
  const doc = ts
    .getJSDocCommentsAndTags(exportDefault)
    .filter((node): node is ts.JSDoc => ts.isJSDoc(node))
    .at(-1);
  return doc === undefined ? undefined : (ts.getTextOfJSDocComment(doc.comment) ?? "");
}

const log = (root: string): { verdict: { kind: string } }[] =>
  readFileSync(join(root, ".bounded", "log.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));

describe("bounded-example, a published pack's package, end to end", () => {
  test("every example of bounded-example opens as a project's configuration with no problem, and its default export carries a TSDoc title", async () => {
    expect(examplePaths.length).toBeGreaterThan(0);
    for (const examplePath of examplePaths) {
      const text = readFileSync(join(PACKAGE, examplePath), "utf8");
      const { judge, problem } = await openProject(projectWithConfig(text));
      expect({ example: examplePath, problem }).toEqual({ example: examplePath, problem: null });
      const verdict = await judge({ kind: "tool-use", role: null, tool: "read", effects: [{ kind: "read", path: "README.md" }] });
      expect({ example: examplePath, verdict: verdict.kind }).toEqual({ example: examplePath, verdict: "allow" });
      const title = defaultExportTsDoc(examplePath, text)?.split("\n")[0]?.trim() ?? "";
      expect({ example: examplePath, hasTitle: title !== "" }).toEqual({ example: examplePath, hasTitle: true });
    }
  });

  test("a tool use of a listed tool is refused with the rule's redirect, another is allowed, and both are recorded", async () => {
    const config = [
      'import { contribution, defineConfig } from "bounded/domain";',
      'import { refusedToolsPack } from "bounded-example";',
      "export default defineConfig({",
      "  packs: [refusedToolsPack],",
      '  contributes: [contribution(refusedToolsPack.points.refusedTools, [{ tool: "web", redirect: "Read docs/ instead" }])],',
      "});",
      "",
    ].join("\n");
    const root = projectWithConfig(config);
    const { judge, problem } = await openProject(root);
    expect(problem).toBeNull();
    const refused = await judge({ kind: "tool-use", role: null, tool: "web", effects: [{ kind: "fetch", url: "https://example.com" }] });
    expect(refused.kind).toBe("refuse");
    if (refused.kind !== "refuse") return;
    expect(refused.reason).toContain("bounded-example/refused-tools");
    expect(refused.reason).toContain("tool kind 'web'");
    expect(refused.redirect).toBe("Read docs/ instead");
    const allowed = await judge({ kind: "tool-use", role: null, tool: "read", effects: [{ kind: "read", path: "README.md" }] });
    expect(allowed.kind).toBe("allow");
    expect(log(root).map((line) => line.verdict.kind)).toEqual(["refuse", "allow"]);
  });
});
