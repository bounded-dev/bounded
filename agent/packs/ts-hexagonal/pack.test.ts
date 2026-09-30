// The ts-hexagonal pack as the harness reads it: its data through the core's
// validators, its code through the ts pack's sockets, and its shipped files.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  generatedFileGlobsFor,
  hasTestFileSuffix,
  pathGlobMatcher,
  sourceRootOf,
  sourceRootsFor,
  testFileSuffixesFor,
} from "../../src/pack-contrib.ts";
import { composePacks, contribute, definePack } from "../../src/socket-registry.ts";
import { INSTALLED_PACKS } from "../installed.ts";
import { adapterTechnologies, lintSrcRules, lintSrcRuleId, skeletonEmitters, TS_PACK, tsPack, workspaceTemplates } from "../ts/pack.ts";
import { shippedFiles } from "../ts/scripts/project-package.ts";
import { TS_HEXAGONAL_LINT_RULES, TS_HEXAGONAL_PACK, TS_HEXAGONAL_PLUGIN, tsHexagonalPack } from "./pack.ts";
import { TS_HEXAGONAL_EMITTERS } from "./scripts/emitters.ts";

const here = dirname(fileURLToPath(import.meta.url));
const packsDir = join(here, "..");
const PACKS = [TS_PACK, TS_HEXAGONAL_PACK];

describe("contrib.json through the core's validators", () => {
  test("source roots are the context and app src folders", () => {
    const roots = sourceRootsFor(PACKS, packsDir);
    expect(roots).toEqual(["apps/*/src", "contexts/*/src"]);
    expect(sourceRootOf("contexts/project-management/src/domain/notes/note.ts", roots)).toBe("contexts/project-management/src");
    expect(sourceRootOf("apps/web/src/server/main.ts", roots)).toBe("apps/web/src");
    expect(sourceRootOf("architecture.test.ts", roots)).toBeUndefined();
    expect(sourceRootOf("contexts/project-management/package.json", roots)).toBeUndefined();
  });

  test("test-side files are the colocated suffixes", () => {
    const suffixes = testFileSuffixesFor(PACKS, packsDir);
    expect(suffixes).toEqual([".test-support.ts", ".test.ts", ".test.tsx"]);
    expect(hasTestFileSuffix("x/create-note.store.test-support.ts", suffixes)).toBe(true);
    expect(hasTestFileSuffix("x/create-note.handler.ts", suffixes)).toBe(false);
  });

  test("generated globs protect exactly TN-26-012's ts-hexagonal rows and nothing a role writes", () => {
    const generated = pathGlobMatcher(generatedFileGlobsFor(PACKS, packsDir));
    const C = "contexts/project-management/src";
    for (const path of [
      "architecture.test.ts", "docs/architecture/readme.md", `${C}/domain/index.ts`, `${C}/domain/shared/result.ts`,
      `${C}/domain/shared/errors.ts`, `${C}/application/index.ts`, `${C}/application/notes/create-note/create-note.command.ts`,
      `${C}/application/notes/create-note/create-note.command.laws.test.ts`, `${C}/adapters/out/in-memory/index.ts`,
      `${C}/adapters/out/drizzle/index.ts`,
    ]) expect(generated(path), path).toBe(true);
    for (const path of [
      `${C}/domain/notes/note.ts`, `${C}/domain/notes/note.contract.ts`, `${C}/domain/notes/note.test.ts`,
      `${C}/domain/shared/other.ts`, `${C}/application/notes/create-note/create-note.handler.ts`,
      `${C}/application/notes/create-note/create-note.contract.ts`, `${C}/application/notes/create-note/create-note.test.ts`,
      `${C}/application/notes/create-note/create-note.store.test-support.ts`,
      `${C}/adapters/out/in-memory/in-memory-database.ts`, `${C}/adapters/out/in-memory/notes/create-note.store.ts`,
      `${C}/adapters/out/in-memory/notes/index.ts`, "apps/web/src/server/composition-root.ts", "docs/tn/TN-1.md",
    ]) expect(generated(path), path).toBe(false);
  });

  test("the in-memory and console technologies, and the context template", () => {
    expect(adapterTechnologies(PACKS, packsDir).map((t) => [t.id, t.direction, t.storage])).toEqual([
      ["console", "out", false],
      ["in-memory", "out", true],
    ]);
    const [context] = workspaceTemplates(PACKS, packsDir);
    expect(context).toMatchObject({ pack: TS_HEXAGONAL_PACK, kind: "context", root: "contexts", files: [] });
    const manifest = JSON.parse(readFileSync(join(here, context!.manifest), "utf8")) as Record<string, unknown>;
    expect(manifest).toEqual({ type: "module", dependencies: { zod: "4.6.4" } });
    const harness = JSON.parse(readFileSync(join(packsDir, "..", "package.json"), "utf8")) as { devDependencies: Record<string, string> };
    expect(harness.devDependencies.zod).toBe("4.6.4");
  });

  test("the shipped files are the architecture test and the whole rulebook, each a generated path", () => {
    const shipped = shippedFiles(PACKS, packsDir).filter((f) => f.source.startsWith(here));
    const docs = readdirSync(join(here, "reference", "docs", "architecture")).sort();
    expect(shipped.map((f) => f.path).sort()).toEqual(["architecture.test.ts", ...docs.map((d) => `docs/architecture/${d}`)].sort());
    const generated = pathGlobMatcher(generatedFileGlobsFor(PACKS, packsDir));
    for (const file of shipped) {
      expect(existsSync(file.source), file.source).toBe(true);
      expect(generated(file.path), file.path).toBe(true);
    }
  });

  test("no shipped source is one the published package leaves out", () => {
    const manifest = JSON.parse(readFileSync(join(packsDir, "..", "package.json"), "utf8")) as { files: string[] };
    const excluded = pathGlobMatcher(manifest.files.filter((f) => f.startsWith("!")).map((f) => f.slice(1).replace(/\/$/, "/**")));
    const agentRoot = join(packsDir, "..");
    for (const file of shippedFiles(PACKS, packsDir)) {
      const relative = file.source.slice(agentRoot.length + 1);
      expect(excluded(relative), `${relative} would be missing from the npm package`).toBe(false);
    }
    expect(excluded("packs/ts-hexagonal/reference/architecture.test.ts")).toBe(true);
  });
});

describe("the shipped rulebook", () => {
  const docs = readdirSync(join(here, "reference", "docs", "architecture"));
  const text = (name: string): string => readFileSync(join(here, "reference", "docs", "architecture", name), "utf8");

  test("names no project: the scope is a placeholder", () => {
    for (const name of docs) expect(text(name), name).not.toMatch(/@example\b/);
  });

  test("has no open decisions left: the desktop shell and cross-context calls are decided", () => {
    const readme = text("readme.md");
    expect(readme).not.toMatch(/Open decisions/);
    expect(readme).toMatch(/Desktop shell:\*\* Electron/);
    expect(readme).toMatch(/Cross-context calls:\*\*/);
  });

  test("records the lead's decisions: generated commands and in adapters, adapter tests through fake in ports", () => {
    expect(text("application.md")).toMatch(/command file is \*\*generated\*\*/);
    expect(text("adapters.md")).toMatch(/In adapters are \*\*generated\*\*/);
    expect(text("testing.md")).toMatch(/adapter factories with fake in ports/);
    expect(text("testing.md")).toMatch(/composition-root\.test\.ts/);
  });

  test("every relative link resolves", () => {
    for (const name of docs) {
      for (const [, target] of text(name).matchAll(/\]\(([a-z-]+\.md)(?:#[a-z-]+)?\)/g)) {
        expect(docs, `${name} links ${target}`).toContain(target);
      }
    }
  });
});

describe("the code half through the ts pack's sockets", () => {
  test("the installed pack contributes every emitter, and they validate", () => {
    const registry = composePacks(INSTALLED_PACKS, PACKS);
    expect(registry.read(skeletonEmitters).map((e) => e.name)).toEqual(TS_HEXAGONAL_EMITTERS.map((e) => e.name));
    expect(new Set(TS_HEXAGONAL_EMITTERS.map((e) => e.name)).size).toBe(TS_HEXAGONAL_EMITTERS.length);
    expect(tsHexagonalPack.dependsOnPacks).toEqual([TS_PACK]);
  });

  test("the nine lint rules pass the lintSrcRules socket's validation under the pack's name", () => {
    const withRules = definePack({
      name: TS_HEXAGONAL_PACK,
      dependsOnPacks: [TS_PACK],
      contributes: [contribute(lintSrcRules, TS_HEXAGONAL_LINT_RULES)],
    });
    const ids = composePacks([tsPack, withRules], PACKS).read(lintSrcRules).map(lintSrcRuleId);
    expect(ids).toEqual([
      "layer-dependency", "no-cross-context-import", "file-role-suffix", "naming", "handler-shape",
      "composition-root-only-constructs", "entry-hosts-only", "client-type-only-server-imports", "in-adapter-uses-in-port",
    ].map((name) => `${TS_HEXAGONAL_PLUGIN}/${name}`));
  });
});

describe("the skill", () => {
  const skill = readFileSync(join(here, "skills", "ts-hexagonal", "SKILL.md"), "utf8");

  test("has a section for each role that writes files", () => {
    for (const role of ["Architect", "Test writer", "Builder"]) expect(skill).toMatch(new RegExp(`^## ${role}$`, "m"));
    expect(skill).toMatch(/^name: ts-hexagonal$/m);
  });

  test("names every rule that binds the builder, in the builder's section", () => {
    const builder = skill.slice(skill.indexOf("## Builder"));
    for (const rule of TS_HEXAGONAL_LINT_RULES) expect(builder).toContain(`\`${rule.name}\``);
  });
});
