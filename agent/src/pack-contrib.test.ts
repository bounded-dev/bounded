import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { fileNameGlobs, mergedContribution, projectCommandNames, projectConfigSources, projectDependencyDirs, projectIgnoreRules, specTechNouns } from "./pack-contrib.ts";
import { writeProjectPacks } from "./project-composition.ts";

const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function packsDir(packs: Record<string, string | undefined>): string {
  const dir = mkdtempSync(join(tmpdir(), "contrib-"));
  tmpDirs.push(dir);
  for (const [name, manifest] of Object.entries(packs)) {
    mkdirSync(join(dir, name), { recursive: true });
    if (manifest !== undefined) writeFileSync(join(dir, name, "contrib.json"), manifest);
  }
  return dir;
}

describe("selected data contributions", () => {
  test("merges selected packs, deduplicates, sorts, ignores installed peers", () => {
    const dir = packsDir({
      language: '{"nouns":["b","a"]}',
      stack: '{"nouns":["b","c"]}',
      unused: '{"nouns":["leak"]}',
    });
    expect(mergedContribution("nouns", ["language", "stack"], dir)).toEqual(["a", "b", "c"]);
    expect(mergedContribution("nouns", ["language"], dir)).toEqual(["a", "b"]);
  });
  test.each([undefined, "{bad json", "null", "[]", '{"nouns":"x"}', '{"nouns":["x",4]}', '{"nouns":[""]}'])(
    "refuses invalid selected manifest %s", (manifest) => {
      const dir = packsDir({ selected: manifest });
      expect(() => mergedContribution("nouns", ["selected"], dir)).toThrow(/Selected pack/);
    },
  );
  test("an absent optional field contributes nothing", () => {
    expect(mergedContribution("nouns", ["selected"], packsDir({ selected: "{}" }))).toEqual([]);
  });
  test("malformed unselected manifests have zero effect", () => {
    const dir = packsDir({ selected: '{"nouns":["x"]}', unused: "{bad json" });
    expect(mergedContribution("nouns", ["selected"], dir)).toEqual(["x"]);
  });
  test("rejects paths masquerading as names", () => {
    expect(() => mergedContribution("nouns", ["../outside"])).toThrow(/Invalid pack name/);
  });
  test("unknown selected pack cannot silently weaken policy", () => {
    expect(() => mergedContribution("nouns", ["missing"], packsDir({}))).toThrow(/missing/);
  });
  test("a selected data pack cannot leave its dependency uncomposed", () => {
    const dir = packsDir({ web: '{"dependsOnPacks":["language"],"nouns":["web"]}' });
    expect(() => mergedContribution("nouns", ["web"], dir)).toThrow(/dependsOnPacks/);
  });
});

describe("real pack content follows project composition", () => {
  test("intake nouns change with selection, without a process-wide cache", () => {
    const cwd = packsDir({});
    writeProjectPacks(cwd, ["ts"]);
    expect(specTechNouns(cwd)).toContain("graphql");
    expect(specTechNouns(cwd)).not.toContain("vue");
    writeProjectPacks(cwd, ["ts", "ts-web"]);
    expect(specTechNouns(cwd)).toContain("vue");
    expect(specTechNouns(cwd)).not.toContain("react");
  });
  test("component names exist only when web is selected", () => {
    expect(mergedContribution("componentReturnTypes", ["ts"])).toEqual([]);
    expect(mergedContribution("componentReturnTypes", ["ts", "ts-web"])).toContain("ReactElement");
  });
  test("missing selection refuses intake", () => {
    expect(() => specTechNouns(packsDir({}))).toThrow(/bounded compose/);
  });
  test("web declares its project-init script", () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "packs", "ts-web", "contrib.json"), "utf8"));
    expect(manifest.projectInitScripts).toEqual(["scripts/new-web-app.ts"]);
  });
});

describe("data socket validation", () => {
  const ignoring = (rule: string) => packsDir({ p: JSON.stringify({ projectIgnoreRules: [rule] }) });

  test.each(["/node_modules/", "/dist/", "/build/*.map", "/coverage"])("accepts the ignore rule %s", (rule) => {
    expect(projectIgnoreRules(["p"], ignoring(rule))).toEqual([rule]);
  });

  test.each([
    "!/.bounded/harness/", "!keep.txt", "\\!odd", "node_modules/", "*.log", "/*", "/**", "/.bounded/",
    "/.BOUNDED/x", "/.git/", "/a/../.bounded/", "/./x", "/[ab]", "/x?", "//x",
  ])("refuses the ignore rule %s", (rule) => {
    expect(() => projectIgnoreRules(["p"], ignoring(rule))).toThrow(/projectIgnoreRules entry/);
  });

  test("projectConfigSources lands each reference file at its root name, in composition order", () => {
    const dir = packsDir({
      a: JSON.stringify({ projectConfigFiles: ["reference/tsconfig.json"] }),
      b: JSON.stringify({ projectConfigFiles: ["reference/extra.config.ts"] }),
    });
    expect(projectConfigSources(["a", "b"], dir).map(({ pack, target }) => [pack, target]))
      .toEqual([["a", "tsconfig.json"], ["b", "extra.config.ts"]]);
    expect(projectConfigSources(["b"], dir).map(({ target }) => target)).toEqual(["extra.config.ts"]);
  });

  test.each([["../x.json"], ["/abs.json"], ["Upper.json"], [42]])("refuses the project config file %s", (file) => {
    const dir = packsDir({ p: JSON.stringify({ projectConfigFiles: [file] }) });
    expect(() => projectConfigSources(["p"], dir)).toThrow(/invalid projectConfigFiles/);
  });

  test("two packs landing on one root name is a collision", () => {
    const dir = packsDir({
      a: JSON.stringify({ projectConfigFiles: ["reference/tsconfig.json"] }),
      b: JSON.stringify({ projectConfigFiles: ["other/tsconfig.json"] }),
    });
    expect(() => projectConfigSources(["a", "b"], dir)).toThrow(/collision/);
  });

  test("no pack contributes an architect write zone any more (ADR 2026-054)", () => {
    expect(mergedContribution("architectWriteFiles", ["ts", "ts-service", "ts-web"])).toEqual([]);
  });
});

describe("launcher commands and protected names come from the selected packs", () => {
  test("projectCommandNames lists the selected packs' commands and refuses shadowing or duplicates", () => {
    const dir = packsDir({
      a: '{"projectCommands":{"sync":"s.ts","adopt":"a.ts"}}',
      b: '{"projectCommands":{"gates":"g.ts"}}',
      c: '{"projectCommands":{"sync":"t.ts"}}',
      d: "{}",
    });
    expect(projectCommandNames(["a", "d"], ["gates"], dir)).toEqual(["adopt", "sync"]);
    expect(projectCommandNames(["d"], ["gates"], dir)).toEqual([]);
    expect(() => projectCommandNames(["b"], ["gates"], dir)).toThrow(/no core subcommand/);
    expect(() => projectCommandNames(["a", "c"], [], dir)).toThrow(/unique/);
  });
  test("dependency directory names are literal and config names are file-name globs", () => {
    const dir = packsDir({ ok: '{"projectDependencyDirs":["deps"],"names":["x*.json"]}', glob: '{"projectDependencyDirs":["dep*"]}', path: '{"names":["a/b"]}' });
    expect(projectDependencyDirs(["ok"], dir)).toEqual(["deps"]);
    expect(fileNameGlobs("names", ["ok"], dir)).toEqual(["x*.json"]);
    expect(() => projectDependencyDirs(["glob"], dir)).toThrow(/literal directory name/);
    expect(() => fileNameGlobs("names", ["path"], dir)).toThrow(/file name/);
  });
});
