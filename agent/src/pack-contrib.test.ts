import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  fileNameGlobs, generatedFileGlobs, generatedFileGlobsFor, generatedFileGlobsOrUnreadable, hasTestFileSuffix,
  mergedContribution, pathGlobMatcher, projectCommandNames, projectConfigSources, projectDependencyDirs,
  projectIgnoreRules, sourceRootOf, sourceRoots, sourceRootsFor, sourceRootsOrUnreadable, specTechNouns,
  testFileSuffixes, testFileSuffixesFor, testFileSuffixesOrUnreadable,
} from "./pack-contrib.ts";
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
    writeProjectPacks(cwd, ["ts", "ts-hexagonal", "ts-trpc", "ts-web"]);
    expect(specTechNouns(cwd)).toContain("vue");
    expect(specTechNouns(cwd)).not.toContain("react");
  });
  test("component names exist only when web is selected", () => {
    expect(mergedContribution("componentReturnTypes", ["ts"])).toEqual([]);
    expect(mergedContribution("componentReturnTypes", ["ts", "ts-hexagonal", "ts-trpc", "ts-web"])).toContain("ReactElement");
  });
  test("missing selection refuses intake", () => {
    expect(() => specTechNouns(packsDir({}))).toThrow(/bounded compose/);
  });
  test("web declares its project-init script", () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "packs", "ts-web", "contrib.json"), "utf8"));
    expect(manifest.projectInitScripts).toEqual(["scripts/seed-apps.ts"]);
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
    expect(mergedContribution("architectWriteFiles", ["ts", "ts-hexagonal", "ts-trpc", "ts-web"])).toEqual([]);
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

describe("layout sockets (ADRs 2026-056, 2026-057, 2026-058)", () => {
  const field = (key: string, values: unknown[], extra: Record<string, unknown> = {}) =>
    packsDir({ p: JSON.stringify({ [key]: values, ...extra }) });

  describe("sourceRoots", () => {
    test.each([["contexts/*/src"], ["apps/*/src"], ["src"], ["packages/core/lib"], ["a_b/*/*/src"]])("accepts %s", (root) => {
      expect(sourceRootsFor(["p"], field("sourceRoots", [root]))).toEqual([root]);
    });
    test("merges and sorts disjoint roots from several packs", () => {
      const dir = packsDir({
        a: JSON.stringify({ sourceRoots: ["contexts/*/src"] }),
        b: JSON.stringify({ sourceRoots: ["apps/*/src", "contexts/*/src"] }),
      });
      expect(sourceRootsFor(["a", "b"], dir)).toEqual(["apps/*/src", "contexts/*/src"]);
    });
    test.each([
      "*/src", "**/src", "contexts/**", "contexts/x*/src", "/src", "src/", "contexts//src", "./src", "contexts/../src",
      ".git/src", "a/.BOUNDED/src", "src?", "src[x]", "{a,b}/src", "!src", "a\\b", "",
    ])("refuses %j", (root) => {
      expect(() => sourceRootsFor(["p"], field("sourceRoots", [root]))).toThrow(/sourceRoots entry|nonempty strings/);
    });
    test.each([
      ["contexts/*/src", "contexts/billing"],
      ["contexts/*/src", "contexts/billing/src/domain"],
      ["contexts/*/src", "CONTEXTS/*/src/x"],
      ["src", "src/app"],
    ])("refuses overlapping roots %s and %s", (a, b) => {
      expect(() => sourceRootsFor(["p"], field("sourceRoots", [a, b]))).toThrow(/overlap/);
    });
    test("sourceRootOf returns the concrete root, only strictly below it, ignoring case", () => {
      const roots = ["apps/*/src", "contexts/*/src"];
      expect(sourceRootOf("contexts/billing/src/domain/x.ts", roots)).toBe("contexts/billing/src");
      expect(sourceRootOf("Contexts/Billing/SRC/x.ts", roots)).toBe("Contexts/Billing/SRC");
      expect(sourceRootOf("apps/web/src/server/main.ts", roots)).toBe("apps/web/src");
      expect(sourceRootOf("contexts/billing/src", roots)).toBeUndefined();
      expect(sourceRootOf("contexts/billing/package.json", roots)).toBeUndefined();
      expect(sourceRootOf("architecture.test.ts", roots)).toBeUndefined();
      expect(sourceRootOf("src/x.ts", [])).toBeUndefined();
    });
  });

  describe("testFileSuffixes", () => {
    test("accepts dotted multi-part suffixes, dashes inside a part", () => {
      const dir = field("testFileSuffixes", [".test.ts", ".test.tsx", ".test-support.ts"], { contractFileSuffixes: [".contract.ts"] });
      expect(testFileSuffixesFor(["p"], dir)).toEqual([".test-support.ts", ".test.ts", ".test.tsx"]);
    });
    test.each([".ts", "test.ts", ".Test.ts", ".test.", ".test..ts", ".test.ts/", "*.test.ts", ".-x.ts", ".x-.ts", ""])(
      "refuses %j", (suffix) => {
        expect(() => testFileSuffixesFor(["p"], field("testFileSuffixes", [suffix]))).toThrow(/testFileSuffixes entry|nonempty strings/);
      });
    test.each([".contract.ts", ".x.contract.ts"])("refuses %s, which a contract suffix collides with", (suffix) => {
      const dir = field("testFileSuffixes", [suffix], { contractFileSuffixes: [".contract.ts"] });
      expect(() => testFileSuffixesFor(["p"], dir)).toThrow(/overlaps the contract suffix/);
    });
    test("a contract suffix from another composed pack is checked too", () => {
      const dir = packsDir({
        a: JSON.stringify({ contractFileSuffixes: [".spec.test.ts"] }),
        b: JSON.stringify({ testFileSuffixes: [".test.ts"] }),
      });
      expect(() => testFileSuffixesFor(["a", "b"], dir)).toThrow(/overlaps/);
      expect(testFileSuffixesFor(["b"], dir)).toEqual([".test.ts"]);
    });
    test("hasTestFileSuffix ignores case", () => {
      expect(hasTestFileSuffix("a/B.TEST.TS", [".test.ts"])).toBe(true);
      expect(hasTestFileSuffix("a/b.contest.ts", [".test.ts"])).toBe(false);
      expect(hasTestFileSuffix("a/b.test.ts", [])).toBe(false);
    });
  });

  describe("generatedFileGlobs", () => {
    test.each([
      "**/*.laws.test.ts", "contexts/*/src/domain/index.ts", "contexts/*/src/adapters/in/trpc/**", "docs/architecture/**",
      "architecture.test.ts", "contexts/*/src/adapters/out/drizzle/schema/*.schema.ts", "contexts/*/src/**/*.command.ts",
    ])("accepts %s", (glob) => {
      expect(generatedFileGlobsFor(["p"], field("generatedFileGlobs", [glob]))).toEqual([glob]);
    });
    test.each([
      "**", "**/*", "*/**", "*", "/abs.ts", "dir/", "a//b.ts", "./a.ts", "a/../b.ts", "a/***/b.ts", "a/x**.ts",
      "a?.ts", "a[b].ts", "{a,b}.ts", "!a.ts", "a\\b.ts", ".git/x", "x/.Bounded/y", "",
    ])("refuses %j", (glob) => {
      expect(() => generatedFileGlobsFor(["p"], field("generatedFileGlobs", [glob]))).toThrow(/generatedFileGlobs entry|nonempty strings/);
    });
    test("pathGlobMatcher: * inside one segment, ** across segments, case-insensitive", () => {
      const match = pathGlobMatcher([
        "**/*.laws.test.ts", "contexts/*/src/domain/index.ts", "contexts/*/src/adapters/in/trpc/**", "docs/architecture/**",
        "contexts/*/src/**/*.command.ts",
      ]);
      expect(match("contexts/pm/src/domain/notes/note-id.laws.test.ts")).toBe(true);
      expect(match("x.laws.test.ts")).toBe(true);
      expect(match("contexts/pm/src/domain/index.ts")).toBe(true);
      expect(match("CONTEXTS/pm/SRC/domain/INDEX.TS")).toBe(true);
      expect(match("contexts/pm/src/domain/notes/index.ts")).toBe(false);
      expect(match("contexts/pm/src/adapters/in/trpc/notes/create-note.procedure.ts")).toBe(true);
      expect(match("contexts/pm/src/adapters/in/trpc")).toBe(false);
      expect(match("contexts/pm/src/adapters/in/mcp/server.ts")).toBe(false);
      expect(match("docs/architecture/domain.md")).toBe(true);
      expect(match("docs/architecture")).toBe(false);
      expect(match("contexts/pm/src/application/notes/create-note/create-note.command.ts")).toBe(true);
      expect(match("contexts/pm/src/application/notes/create-note/create-note.handler.ts")).toBe(false);
      expect(match("contexts/a/b/src/domain/index.ts")).toBe(false);
      expect(pathGlobMatcher([])("anything")).toBe(false);
    });
  });

  describe("an unreadable composition fails closed", () => {
    test("each reader throws and each OrUnreadable variant says so", () => {
      const cwd = packsDir({});
      for (const read of [sourceRoots, testFileSuffixes, generatedFileGlobs]) {
        expect(() => read(cwd)).toThrow(/bounded compose/);
      }
      expect(sourceRootsOrUnreadable(cwd)).toBe("unreadable");
      expect(testFileSuffixesOrUnreadable(cwd)).toBe("unreadable");
      expect(generatedFileGlobsOrUnreadable(cwd)).toBe("unreadable");
    });
    test("an invalid contribution is unreadable too, never an empty list", () => {
      const cwd = packsDir({});
      writeProjectPacks(cwd, ["p"]);
      const dir = packsDir({ p: JSON.stringify({ sourceRoots: ["**"], testFileSuffixes: [".ts"], generatedFileGlobs: ["**"] }) });
      expect(sourceRootsOrUnreadable(cwd, dir)).toBe("unreadable");
      expect(testFileSuffixesOrUnreadable(cwd, dir)).toBe("unreadable");
      expect(generatedFileGlobsOrUnreadable(cwd, dir)).toBe("unreadable");
    });
    test("a readable composition with no contributor yields empty lists", () => {
      const cwd = packsDir({});
      writeProjectPacks(cwd, ["p"]);
      const dir = packsDir({ p: "{}" });
      expect(sourceRootsOrUnreadable(cwd, dir)).toEqual([]);
      expect(testFileSuffixesOrUnreadable(cwd, dir)).toEqual([]);
      expect(generatedFileGlobsOrUnreadable(cwd, dir)).toEqual([]);
    });
    test("a readable composition returns the validated lists", () => {
      const cwd = packsDir({});
      writeProjectPacks(cwd, ["p"]);
      const dir = packsDir({ p: JSON.stringify({
        sourceRoots: ["contexts/*/src"], testFileSuffixes: [".test.ts"], generatedFileGlobs: ["**/*.laws.test.ts"],
      }) });
      expect(sourceRootsOrUnreadable(cwd, dir)).toEqual(["contexts/*/src"]);
      expect(testFileSuffixesOrUnreadable(cwd, dir)).toEqual([".test.ts"]);
      expect(generatedFileGlobsOrUnreadable(cwd, dir)).toEqual(["**/*.laws.test.ts"]);
    });
  });
});
