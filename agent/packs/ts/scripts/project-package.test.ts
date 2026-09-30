import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { writeProjectPacks } from "../../../src/project-composition.ts";
import { EXAMPLE_PACKS } from "../../example-suite/example-facts.ts";
import {
  bunLockProblems,
  bunVersionProblem,
  lockFingerprint,
  checkedProjectName,
  pinnedBunVersion,
  configFiles,
  renderConfigFile,
  declaredWorkspaces,
  generatedManifests,
  layoutFor,
  lockfileFor,
  type Manifest,
  mergeProjectFields,
  packageFor,
  parseBunLock,
  projectNameFromDirectory,
  projectWorkspaces,
  readProjectName,
  tnWorkspaces,
  tsconfigFor,
  workspaceGlobs,
  writeProjectPackage,
} from "./project-package.ts";
import {
  EXAMPLE_MANIFESTS,
  EXAMPLE_TSCONFIG,
  exampleProject,
  fakeBunLock,
  fakeLockfileMaker,
  type Fixture,
  featureContract,
  fixtureHarness,
} from "./testdata/workspace-fixture.ts";

const agentRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const cleanups: (() => void)[] = [];
afterAll(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function fixture(options: Parameters<typeof fixtureHarness>[0] = {}): Fixture {
  const f = fixtureHarness(options);
  cleanups.push(f.cleanup);
  return f;
}
function example(f: Fixture, name?: string): string {
  const p = exampleProject(f, name === undefined ? {} : { name });
  cleanups.push(p.cleanup);
  return p.project;
}
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Normalise a manifest for comparison with the example: every version
 *  becomes `<pin>` (the harness pins exactly, the example uses ranges) and
 *  the scope becomes `@<scope>`. `exports` compares as a map (TN-26-012,
 *  changes from the plan, 8). */
function modPinsAndScope(manifest: Manifest, scope: string): Manifest {
  const text = JSON.stringify(manifest).split(`${scope}/`).join("@<scope>/");
  const out = JSON.parse(text) as Manifest;
  for (const section of ["dependencies", "devDependencies"]) {
    const deps = out[section] as Record<string, string> | undefined;
    if (deps !== undefined) for (const dep of Object.keys(deps)) if (deps[dep] !== "workspace:*") deps[dep] = "<pin>";
  }
  return out;
}

describe("the root manifest (ADR 2026-051, ADR 2026-062)", () => {
  test("capability scripts and pins cannot silently replace earlier values", () => {
    const fields = { check: "tsc" };
    mergeProjectFields(fields, { check: "tsc" }, "Project script", "same");
    expect(() => mergeProjectFields(fields, { check: "echo skipped" }, "Project script", "other")).toThrow(/conflicts/);
    expect(() => mergeProjectFields({ a: "1.0.0" }, { a: "2.0.0" }, "Dependency", "other")).toThrow(/conflicts/);
  });

  test("the ts pack alone: Bun scripts, exact pins, the surface check folded in with bun run", () => {
    const pkg = packageFor(["ts"], join(agentRoot, "packs"), { name: "demo" });
    expect(pkg).toEqual({
      name: "demo",
      private: true,
      type: "module",
      scripts: {
        check: "tsc -p tsconfig.json && bun test && bun run check:surface",
        test: "bun test",
        "check:surface": "bun scripts/surface-check.ts",
      },
      devDependencies: { "@types/bun": "1.3.14", "ts-morph": "28.0.0", typescript: "5.9.3" },
    });
    const harness = JSON.parse(readFileSync(join(agentRoot, "package.json"), "utf8")) as { devDependencies: Record<string, string> };
    expect(pkg.devDependencies?.["ts-morph"]).toBe(harness.devDependencies["ts-morph"]);
  });

  test("no composition provides a template: refused", () => {
    expect(() => packageFor([], join(agentRoot, "packs"))).toThrow(/exactly one project package template/);
  });

  test("workspaces: the context template's root first, then the others sorted", () => {
    const t = (kind: string, root: string) => ({ pack: "p", kind, root, manifest: "m.json", files: [], description: "d" });
    expect(workspaceGlobs([t("web", "apps"), t("context", "contexts"), t("tool", "tools"), t("mcp", "apps")]))
      .toEqual(["contexts/*", "apps/*", "tools/*"]);
    expect(workspaceGlobs([])).toEqual([]);
  });
});

describe("the pinned bun release is a precondition (ADR 2026-062)", () => {
  test("pinned by the ts pack's @types/bun; major and minor must match, the patch may differ", () => {
    expect(pinnedBunVersion()).toBe("1.3.14");
    expect(bunVersionProblem("1.3.14", "1.3.14")).toBeUndefined();
    expect(bunVersionProblem("1.3.2", "1.3.14")).toBeUndefined();
    expect(bunVersionProblem("1.4.0", "1.3.14")).toMatch(/bun 1\.4\.0 is on PATH, but this project's toolchain is pinned to bun 1\.3\.x/);
    expect(bunVersionProblem("2.3.14", "1.3.14")).toMatch(/pinned to bun 1\.3\.x/);
    expect(bunVersionProblem(null, "1.3.14")).toMatch(/bun is not on PATH/);
  });
});

describe("the project's name and scope", () => {
  test("a name is lowercase letters, digits and dashes", () => {
    expect(checkedProjectName("example-project")).toBe("example-project");
    for (const bad of ["Example", "@example", "a/b", "-a", "", "a_b"]) expect(() => checkedProjectName(bad)).toThrow(/project name/);
  });

  test("from a directory name, sanitised, else the default", () => {
    expect(projectNameFromDirectory("/work/Example Project")).toBe("example-project");
    expect(projectNameFromDirectory("/work/___")).toBe("bounded-project");
  });

  test("read back from the root manifest (the directory's name without one); an unreadable or invalid one is refused", () => {
    const parent = tempDir("project-name-");
    const dir = join(parent, "My_App");
    mkdirSync(dir);
    expect(readProjectName(dir)).toBe("my-app");
    writeFileSync(join(dir, "package.json"), "{");
    expect(() => readProjectName(dir)).toThrow(/package\.json is unreadable/);
    writeFileSync(join(dir, "package.json"), "{}");
    expect(() => readProjectName(dir)).toThrow(/has no name/);
    writeFileSync(join(dir, "package.json"), '{"name":"@scoped/x"}');
    expect(() => readProjectName(dir)).toThrow(/project name/);
    writeFileSync(join(dir, "package.json"), '{"name":"example"}');
    expect(readProjectName(dir)).toBe("example");
  });
});

describe("TN workspaces: front matter (TN-26-012 §9)", () => {
  test("the block form, ended by the first unindented line", () => {
    expect([...tnWorkspaces("---\nissue: 1\nworkspaces:\n  apps/web: web\n  apps/mcp: mcp\nstatus: active\n---\n", "TN")!])
      .toEqual([["apps/web", "web"], ["apps/mcp", "mcp"]]);
    expect(tnWorkspaces("---\nworkspaces:\n---\n", "TN")?.size).toBe(0);
    expect(tnWorkspaces("---\nissue: 1\n---\n", "TN")).toBeUndefined();
    expect(tnWorkspaces("no front matter", "TN")).toBeUndefined();
  });

  test("anything else is refused, never guessed", () => {
    for (const bad of [
      "---\nworkspaces: {apps/web: web}\n---\n",
      "---\nworkspaces:\n   apps/web: web\n---\n",
      "---\nworkspaces:\n  apps/Web: web\n---\n",
      "---\nworkspaces:\n  apps/web: Web\n---\n",
      "---\nworkspaces:\n  apps/web: web\n  apps/web: web\n---\n",
      "---\nworkspaces:\n  - apps/web\n---\n",
    ]) expect(() => tnWorkspaces(bad, "TN-9"), bad).toThrow(/TN-9/);
  });

  test("maps merge across TNs; one directory with two kinds is refused", () => {
    const dir = tempDir("tn-merge-");
    mkdirSync(join(dir, "docs", "tn"), { recursive: true });
    writeFileSync(join(dir, "docs", "tn", "TN-1.md"), "---\nworkspaces:\n  apps/web: web\n---\n");
    writeFileSync(join(dir, "docs", "tn", "TN-2.md"), "---\nworkspaces:\n  apps/web: web\n  apps/mcp: mcp\n---\n");
    expect([...declaredWorkspaces(dir)]).toEqual([["apps/web", "web"], ["apps/mcp", "mcp"]]);
    writeFileSync(join(dir, "docs", "tn", "TN-3.md"), "---\nworkspaces:\n  apps/web: mcp\n---\n");
    expect(() => declaredWorkspaces(dir)).toThrow(/declared as 'web' and as 'mcp'/);
  });
});

describe("workspaces from the design (ADR 2026-061)", () => {
  test("contexts from contract paths, apps from the TN, sorted by directory", () => {
    const f = fixture();
    const project = example(f);
    const workspaces = projectWorkspaces(project, layoutFor(f.packs, f.packsDir), "@example");
    expect(workspaces.map((w) => [w.dir, w.kind, w.packageName, w.sourceRoot])).toEqual([
      ["apps/desktop", "desktop", "@example/desktop", "apps/desktop/src"],
      ["apps/lambdas", "lambdas", "@example/lambdas", "apps/lambdas/src"],
      ["apps/mcp", "mcp", "@example/mcp", "apps/mcp/src"],
      ["apps/web", "web", "@example/web", "apps/web/src"],
      ["contexts/project-management", "context", "@example/project-management", "contexts/project-management/src"],
    ]);
  });

  test("a context directory without a contract is not a workspace; node_modules and dot-directories are never searched", () => {
    const f = fixture();
    const project = example(f);
    mkdirSync(join(project, "contexts", "empty", "src"), { recursive: true });
    mkdirSync(join(project, "contexts", "hidden", "src", "node_modules", "x"), { recursive: true });
    writeFileSync(join(project, "contexts", "hidden", "src", "node_modules", "x", "a.contract.ts"), "");
    mkdirSync(join(project, "contexts", ".cache", "src"), { recursive: true });
    writeFileSync(join(project, "contexts", ".cache", "src", "b.contract.ts"), "");
    const dirs = projectWorkspaces(project, layoutFor(f.packs, f.packsDir), "@example").map((w) => w.dir);
    expect(dirs).not.toContain("contexts/empty");
    expect(dirs).not.toContain("contexts/hidden");
    expect(dirs).not.toContain("contexts/.cache");
  });

  test("refusals name the file and the fix", () => {
    const f = fixture();
    const layout = layoutFor(f.packs, f.packsDir);
    const cases: [string, string, RegExp][] = [
      ["docs/tn/TN-2.md", "---\nworkspaces:\n  apps/api: service\n---\n", /no composed pack's workspace template provides/],
      ["docs/tn/TN-2.md", "---\nworkspaces:\n  tools/web: web\n---\n", /must be 'apps\/<name>'/],
      ["docs/tn/TN-2.md", "---\nworkspaces:\n  contexts/x: context\n---\n", /contexts come from contract paths/],
      ["apps/undeclared/src/x.contract.ts", "", /neither a context \(contexts\/<name>\) nor a workspace a TN declares/],
      ["docs/tn/TN-2.md", "---\nworkspaces:\n  apps/project-management: web\n---\n", /would both be the package '@example\/project-management'/],
    ];
    for (const [path, content, expected] of cases) {
      const project = example(f);
      mkdirSync(dirname(join(project, path)), { recursive: true });
      writeFileSync(join(project, path), content);
      expect(() => projectWorkspaces(project, layout, "@example"), path).toThrow(expected);
    }
  });

  test("a composition with no workspace templates has no workspaces (the flat layout)", () => {
    const project = tempDir("flat-");
    writeProjectPacks(project, ["ts"]);
    expect(projectWorkspaces(project, layoutFor(["ts"], join(agentRoot, "packs")), "@x")).toEqual([]);
  });
});

describe("the generated manifests equal the example's, modulo exact pins and scope", () => {
  const f = fixtureHarness();
  cleanups.push(f.cleanup);
  const project = exampleProject(f, { name: "example" });
  cleanups.push(project.cleanup);
  const generated = generatedManifests(project.project, f.packs, f.packsDir, "example");

  test("the same workspaces as the example", () => {
    expect([...generated.manifests.keys()].sort()).toEqual(Object.keys(EXAMPLE_MANIFESTS).sort());
  });

  test.each(Object.keys(EXAMPLE_MANIFESTS).filter((dir) => dir !== ""))("%s", (dir) => {
    const ours = { ...generated.manifests.get(dir)! };
    const theirs = EXAMPLE_MANIFESTS[dir]!;
    if (ours["exports"] !== undefined) {
      // The example's context has Drizzle's pins and scripts but no drizzle
      // folder yet (its persistence is unfinished), so it exports no
      // `./adapters/drizzle`. With the folder, the generator exports it.
      const { "./adapters/drizzle": drizzle, ...exported } = ours["exports"] as Record<string, string>;
      expect(drizzle).toBe("./src/adapters/out/drizzle/index.ts");
      ours["exports"] = exported;
    }
    expect(modPinsAndScope(ours, "@example")).toEqual(modPinsAndScope(theirs, "@example"));
    // Field order too, except `exports` entries, which the generator sorts.
    expect(Object.keys(ours)).toEqual(Object.keys(theirs));
    for (const section of ["dependencies", "devDependencies"]) {
      expect(Object.keys((ours[section] ?? {}) as object)).toEqual(Object.keys((theirs[section] ?? {}) as object).sort());
    }
  });

  test("the context's exports: layers, then in adapters sorted, then out adapters sorted; absent folders none", () => {
    expect(generated.manifests.get("contexts/project-management")!["exports"]).toEqual({
      "./domain": "./src/domain/index.ts",
      "./application": "./src/application/index.ts",
      "./adapters/lambda": "./src/adapters/in/lambda/index.ts",
      "./adapters/mcp": "./src/adapters/in/mcp/index.ts",
      "./adapters/trpc": "./src/adapters/in/trpc/index.ts",
      "./adapters/console": "./src/adapters/out/console/index.ts",
      "./adapters/drizzle": "./src/adapters/out/drizzle/index.ts",
      "./adapters/in-memory": "./src/adapters/out/in-memory/index.ts",
    });
    expect(Object.keys(generated.manifests.get("contexts/project-management")!["exports"] as object)).toEqual([
      "./domain", "./application", "./adapters/lambda", "./adapters/mcp", "./adapters/trpc",
      "./adapters/console", "./adapters/drizzle", "./adapters/in-memory",
    ]);
  });

  test("a technology's workspaceScripts arrive with its folder, as the example's db:generate and db:migrate", () => {
    expect(generated.manifests.get("contexts/project-management")!["scripts"]).toEqual({
      "db:generate": "drizzle-kit generate",
      "db:migrate": "bun --env-file=../../.env run drizzle-kit migrate",
    });
    // No app takes them: only a context's tree has adapter folders.
    expect(generated.manifests.get("apps/web")!["scripts"]).toEqual({ dev: "bun --hot src/server/main.ts" });
  });

  test("the root: the example's, plus the harness's own check scripts and ts-morph pin", () => {
    const root = { ...generated.manifests.get("")! } as Manifest & { scripts: Record<string, string>; devDependencies: Record<string, string> };
    expect(root["name"]).toBe("example");
    const { check, test: testScript, "check:surface": surface, ...scripts } = root.scripts;
    expect([check, testScript, surface]).toEqual(["tsc -p tsconfig.json && bun test && bun run check:surface", "bun test", "bun scripts/surface-check.ts"]);
    const { "ts-morph": _tsMorph, ...devDependencies } = root.devDependencies;
    const comparable = { ...root, name: "example-project", scripts, devDependencies };
    expect(modPinsAndScope(comparable, "@example")).toEqual(modPinsAndScope(EXAMPLE_MANIFESTS[""]!, "@example"));
    expect(Object.keys(root)).toEqual(Object.keys(EXAMPLE_MANIFESTS[""]!));
  });

  test("tsconfig.json: the example's, with its include as a set", () => {
    const ours = JSON.parse(tsconfigFor(f.packs, f.packsDir)) as typeof EXAMPLE_TSCONFIG;
    expect({ ...ours, include: [...ours.include].sort() }).toEqual({ ...EXAMPLE_TSCONFIG, include: [...EXAMPLE_TSCONFIG.include].sort() });
  });

  test("the shipped tsconfig.base.json is the example's", () => {
    const base = readFileSync(join(agentRoot, "packs", "ts", "reference", "tsconfig.base.json"), "utf8");
    expect(base).toContain('"moduleResolution": "bundler"');
    expect(base).toContain('"types": ["bun"]');
    expect(base).toContain('"noEmit": true');
    expect(base).toContain('"allowImportingTsExtensions": true');
  });

  test("technologies follow the design: an untagged feature and a store-less context drop them", () => {
    const p = exampleProject(f, { name: "example" });
    cleanups.push(p.cleanup);
    const app = join(p.project, "contexts/project-management/src/application");
    // No feature exposed through MCP any more, and no store port anywhere.
    for (const [path, inPort, exposedVia] of [
      ["projects/create-project/create-project.contract.ts", "CreateProject", "trpc"],
      ["projects/list-projects/list-projects.contract.ts", "ListProjects", "trpc"],
      ["notes/create-note/create-note.contract.ts", "CreateNote", "trpc"],
      ["notes/list-notes/list-notes.contract.ts", "ListNotes", "trpc"],
      ["projects/export-projects/export-projects.contract.ts", "ExportProjects", "lambda"],
    ] as const) writeFileSync(join(app, path), featureContract(inPort, { exposedVia, store: false }));
    const context = generatedManifests(p.project, f.packs, f.packsDir, "example").manifests.get("contexts/project-management")!;
    expect(Object.keys(context["exports"] as object)).toEqual(["./domain", "./application", "./adapters/lambda", "./adapters/trpc"]);
    expect(Object.keys(context["dependencies"] as object)).toEqual(["@trpc/server", "zod"]);
    expect(context["scripts"]).toBeUndefined();
    expect(context["devDependencies"]).toBeUndefined();
  });

  test("review repro: a stray folder or file under adapters/ changes no manifest", () => {
    const p = exampleProject(f, { name: "example" });
    cleanups.push(p.cleanup);
    const before = generatedManifests(p.project, f.packs, f.packsDir, "example").manifests;
    for (const tech of ["mailer", "drizzle", "trpc", "unknown"]) {
      const dir = join(p.project, "contexts/project-management/src/adapters/out", tech);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "x.test.ts"), "export {};\n");
      writeFileSync(join(dir, "index.ts"), "export {};\n");
    }
    rmSync(join(p.project, "contexts/project-management/src/adapters/out/drizzle"), { recursive: true });
    expect(generatedManifests(p.project, f.packs, f.packsDir, "example").manifests).toEqual(before);
  });

  test("a tag naming a technology no composed pack provides is refused", () => {
    const p = exampleProject(f, { name: "example" });
    cleanups.push(p.cleanup);
    writeFileSync(join(p.project, "contexts/project-management/src/application/notes/create-note/create-note.contract.ts"),
      featureContract("CreateNote", { exposedVia: "graphql" }));
    expect(() => generatedManifests(p.project, f.packs, f.packsDir, "example"))
      .toThrow(/create-note\.contract\.ts: @exposedVia names 'graphql', which no composed pack provides as an in adapter technology/);
  });

  test("a template script a technology also contributes is refused", () => {
    const g = fixture();
    writeFileSync(join(g.packsDir, "hex", "templates", "context.json"), JSON.stringify({ type: "module", scripts: { "db:generate": "mine" } }));
    expect(() => generatedManifests(example(g), g.packs, g.packsDir, "example"))
      .toThrow(/adapter technology 'drizzle'\): script 'db:generate' is also the workspace template's/);
  });
});

describe("{{entries}}: the composed emitters' entry files (TN-26-012 §10)", () => {
  test("the real composition renders the Lambda app's build exactly as the example's", () => {
    const EXAMPLE = join(agentRoot, "packs", "example-suite", "reference", "example");
    const project = join(tempDir("entries-"), "example");
    mkdirSync(project);
    writeProjectPacks(project, EXAMPLE_PACKS);
    writeFileSync(join(project, "package.json"), '{"name":"example"}\n');
    const context = "contexts/project-management/src";
    const walk = (dir: string): string[] => readdirSync(join(EXAMPLE, dir), { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith(".contract.ts") ? [`${dir}/${e.name}`] : []));
    for (const path of walk(context)) {
      mkdirSync(dirname(join(project, path)), { recursive: true });
      writeFileSync(join(project, path), readFileSync(join(EXAMPLE, path), "utf8"));
    }
    mkdirSync(join(project, "docs", "tn"), { recursive: true });
    writeFileSync(join(project, "docs", "tn", "TN-1.md"),
      "---\nissue: 1\nworkspaces:\n  apps/desktop: desktop\n  apps/lambdas: lambdas\n  apps/mcp: mcp\n  apps/web: web\n---\n");
    const manifests = generatedManifests(project, EXAMPLE_PACKS, join(agentRoot, "packs"), "example").manifests;
    const example = JSON.parse(readFileSync(join(EXAMPLE, "apps", "lambdas", "package.json"), "utf8")) as Manifest;
    expect((manifests.get("apps/lambdas")!["scripts"] as Record<string, string>)["build"])
      .toBe("bun build src/export-projects.ts --outdir dist --target node");
    expect(manifests.get("apps/lambdas")!["scripts"]).toEqual(example["scripts"]);
  });
});

describe("root config files take {{project}} (TN-26-012 §10)", () => {
  const POSTGRES = ["ts", "ts-hexagonal", "ts-drizzle-postgres"];

  test("filled with the project's name; any other placeholder is refused", () => {
    expect(renderConfigFile("db: {{project}}\nurl: /{{project}}\n", "example", "f")).toBe("db: example\nurl: /example\n");
    expect(() => renderConfigFile("{{name}}", "example", "docker-compose.yml")).toThrow(/docker-compose\.yml uses '\{\{name\}\}'; a root config file may use only \{\{project\}\}/);
  });

  test("the Postgres pack's docker-compose.yml and .env.example name the database after the project", () => {
    const files = configFiles(POSTGRES, join(agentRoot, "packs"), "example");
    expect(files.get("docker-compose.yml")).toContain("POSTGRES_DB: example\n");
    expect(files.get(".env.example")).toBe("DATABASE_URL=postgres://postgres:postgres@localhost:5432/example\n");
    expect([...files.values()].join("\n")).not.toContain("{{");
    expect([...files.keys()].sort()).toEqual([".env.example", "docker-compose.yml", "tsconfig.base.json"]);
  });

  test("the check folds every pack's check script with bun run", () => {
    const pkg = packageFor(POSTGRES, join(agentRoot, "packs"), { name: "example" });
    expect(pkg.scripts["check"]).toBe("tsc -p tsconfig.json && bun test && bun run check:surface && bun run check:db");
    expect(pkg.scripts["check"]).not.toMatch(/\bnpm\b/);
  });
});

describe("manifest refusals", () => {
  test("a template that declares what the generator owns, a range, or an unknown placeholder", () => {
    const cases: [Manifest, RegExp][] = [
      [{ name: "x" }, /may not declare 'name'/],
      [{ exports: {} }, /may not declare 'exports'/],
      [{ dependencies: { react: "^19" } }, /not an exact version/],
      [{ scripts: { dev: "{{project}}" } }, /only \{\{scope\}\}, \{\{name\}\}, \{\{package\}\} and \{\{entries\}\} exist/],
    ];
    for (const [manifest, expected] of cases) {
      const f = fixture();
      writeFileSync(join(f.packsDir, "hex", "templates", "web.json"), JSON.stringify(manifest));
      expect(() => generatedManifests(example(f), f.packs, f.packsDir, "example"), JSON.stringify(manifest)).toThrow(expected);
    }
  });

  test("placeholders are filled", () => {
    const f = fixture();
    writeFileSync(join(f.packsDir, "hex", "templates", "web.json"), JSON.stringify({ scripts: { dev: "{{scope}} {{name}} {{package}}" } }));
    const web = generatedManifests(example(f), f.packs, f.packsDir, "example").manifests.get("apps/web")!;
    expect(web["scripts"]).toEqual({ dev: "@example web @example/web" });
  });

  test("one package at two versions across the project is refused", () => {
    const f = fixture();
    writeFileSync(join(f.packsDir, "hex", "templates", "mcp.json"), JSON.stringify({ dependencies: { react: "18.0.0" } }));
    expect(() => generatedManifests(example(f), f.packs, f.packsDir, "example")).toThrow(/'react' is pinned to/);
  });
});

describe("bun.lock verification, without the network (ADR 2026-062)", () => {
  const PROBE = readFileSync(join(import.meta.dirname, "testdata", "bun-lock", "probe.lock.txt"), "utf8");
  const probeManifests = new Map<string, Manifest>([
    ["", { name: "probe", private: true, workspaces: ["contexts/*", "apps/*"], devDependencies: { typescript: "5.9.3" } }],
    ["apps/web", { name: "@probe/web", private: true, dependencies: { "@probe/pm": "workspace:*" } }],
    ["contexts/pm", { name: "@probe/pm", private: true, dependencies: { zod: "4.1.12" } }],
  ]);

  test("a real bun.lock (captured from bun 1.3.14) parses, trailing commas and all, and verifies", () => {
    expect(parseBunLock(PROBE)["lockfileVersion"]).toBe(1);
    expect(bunLockProblems(PROBE, probeManifests)).toEqual([]);
  });

  test("every mismatch is named", () => {
    const edit = (from: string, to: string) => {
      expect(PROBE).toContain(from);
      return bunLockProblems(PROBE.replace(from, to), probeManifests);
    };
    expect(edit('"zod": ["zod@4.1.12"', '"zod": ["zod@4.1.13"')).toEqual(["'zod' resolves to zod@4.1.13, not zod@4.1.12"]);
    expect(edit('"zod": "4.1.12"', '"zod": "^4"')).toEqual(["workspace 'contexts/pm' dependencies differ from its manifest"]);
    expect(edit('"name": "@probe/pm"', '"name": "@probe/other"')).toContain('workspace \'contexts/pm\' is named "@probe/other", not "@probe/pm"');
    expect(edit('"@probe/pm": ["@probe/pm@workspace:contexts/pm"]', '"@probe/pm": ["@probe/pm@workspace:apps/pm"]'))
      .toContain("'@probe/pm' resolves to @probe/pm@workspace:apps/pm, not @probe/pm@workspace:contexts/pm");
    expect(edit('"lockfileVersion": 1', '"lockfileVersion": 0')).toContain("lockfileVersion is 0, not 1");
    expect(edit('"packages": {', '"overrides": { "zod": "4.0.0" },\n  "packages": {')).toContain("it declares 'overrides', which no generated manifest does");
    expect(edit('    "apps/web": {', '    "apps/extra": { "name": "@probe/extra" },\n    "apps/web": {')).toContain("workspace 'apps/extra' is not generated");
    expect(bunLockProblems("{", probeManifests)[0]).toMatch(/cannot be parsed/);
  });

  test("a manifest the lockfile does not know, or a pin it does not resolve, is named", () => {
    const more = new Map(probeManifests).set("apps/mcp", { name: "@probe/mcp", private: true });
    expect(bunLockProblems(PROBE, more)).toEqual(["workspace 'apps/mcp' is missing"]);
    const pinned = new Map(probeManifests).set("", { name: "probe", devDependencies: { typescript: "5.9.3", "ts-morph": "28.0.0" } });
    expect(bunLockProblems(PROBE, pinned)).toContain("'ts-morph' is not resolved");
  });

  test("review repro: a tampered registry URL, a fake integrity and an injected transitive dependency are all caught", () => {
    const tampered = PROBE
      .replace('"zod@4.1.12", "", {}, "sha512-JIn', '"zod@4.1.12", "https://evil.example/zod.tgz", { "dependencies": { "evil": "1.0.0" } }, "sha512-AAA')
      .replace('"zod": ["zod', '"evil": ["evil@1.0.0", "https://evil.example/e.tgz", {}, "sha512-x"],\n    "zod": ["zod');
    expect(tampered).not.toBe(PROBE);
    const problems = bunLockProblems(tampered, probeManifests, lockFingerprint(PROBE));
    expect(problems).toEqual(expect.arrayContaining([
      "package 'zod' comes from \"https://evil.example/zod.tgz\", not the default registry",
      "package 'evil' comes from \"https://evil.example/e.tgz\", not the default registry",
      "package 'zod' differs from the clean resolution (its version, registry URL, dependencies or integrity)",
      "package 'evil' is not in the clean resolution",
    ]));
    // Each alone: a changed integrity, and an injection consistent on its own.
    const integrityOnly = PROBE.replace('"sha512-JIn', '"sha512-AAA');
    expect(bunLockProblems(integrityOnly, probeManifests, lockFingerprint(PROBE)))
      .toEqual(["package 'zod' differs from the clean resolution (its version, registry URL, dependencies or integrity)"]);
    const injected = PROBE
      .replace('"zod@4.1.12", "", {}', '"zod@4.1.12", "", { "dependencies": { "evil": "1.0.0" } }')
      .replace('"zod": ["zod', '"evil": ["evil@1.0.0", "", {}, "sha512-eHg="],\n    "zod": ["zod');
    expect(bunLockProblems(injected, probeManifests)).toEqual([]); // consistent on its own: only the fingerprint knows
    expect(bunLockProblems(injected, probeManifests, lockFingerprint(PROBE))).toEqual([
      "package 'zod' differs from the clean resolution (its version, registry URL, dependencies or integrity)",
      "package 'evil' is not in the clean resolution",
    ]);
  });

  test("the closure: a real lock with nested and optional platform packages is consistent; an orphan or a dangling dependency is not", () => {
    const DRIZZLE = readFileSync(join(import.meta.dirname, "testdata", "bun-lock", "drizzle.lock.txt"), "utf8");
    const manifests = new Map<string, Manifest>([
      ["", { name: "big", workspaces: ["contexts/*"], devDependencies: { typescript: "5.9.3", "@types/bun": "1.3.14", "ts-morph": "28.0.0" } }],
      ["contexts/pm", { name: "@big/pm", dependencies: { zod: "4.1.12", "drizzle-orm": "0.45.3", pg: "8.23.1" }, devDependencies: { "drizzle-kit": "0.31.11", "@types/pg": "8.23.1" } }],
    ]);
    expect(bunLockProblems(DRIZZLE, manifests, lockFingerprint(DRIZZLE))).toEqual([]);
    const orphan = DRIZZLE.replace('"packages": {', '"packages": {\n    "left-pad": ["left-pad@1.3.0", "", {}, "sha512-eHg="],');
    expect(bunLockProblems(orphan, manifests)).toEqual(["package 'left-pad' is reachable from no generated manifest"]);
    const dangling = DRIZZLE.replace(/\n\s*"tsx": \["tsx@[^\n]*/, "");
    expect(bunLockProblems(dangling, manifests)).toContain("'tsx', a dependency of 'drizzle-kit', resolves to no entry");
  });

  test("lockfileFor keeps a lockfile that verifies against its fingerprint, and never calls bun for it", () => {
    const kept = lockfileFor(probeManifests, { lock: PROBE, fingerprint: lockFingerprint(PROBE) }, () => { throw new Error("bun was called"); });
    expect(kept.lock).toBe(PROBE);
  });

  test("a lockfile with no fingerprint, or a tampered one, is never kept or used as a seed", () => {
    const seeds: (string | undefined)[] = [];
    const maker = (dir: string) => {
      seeds.push(existsSync(join(dir, "bun.lock")) ? readFileSync(join(dir, "bun.lock"), "utf8") : undefined);
      writeFileSync(join(dir, "bun.lock"), PROBE);
    };
    expect(lockfileFor(probeManifests, { lock: PROBE }, maker).lock).toBe(PROBE);
    const tampered = PROBE.replace('"zod@4.1.12", ""', '"zod@4.1.12", "https://evil.example/zod.tgz"');
    lockfileFor(probeManifests, { lock: tampered, fingerprint: lockFingerprint(PROBE) }, maker);
    expect(seeds).toEqual([undefined, undefined]);
    // A lockfile that matches its fingerprint but not new manifests IS a seed.
    const more = new Map(probeManifests).set("apps/mcp", { name: "@probe/mcp" });
    try { lockfileFor(more, { lock: PROBE, fingerprint: lockFingerprint(PROBE) }, maker); } catch { /* PROBE lacks apps/mcp */ }
    expect(seeds[2]).toBe(PROBE);
  });

  test("lockfileFor refuses a produced lockfile that does not verify, or a maker that fails", () => {
    expect(() => lockfileFor(probeManifests, undefined, (dir) => writeFileSync(join(dir, "bun.lock"), PROBE.replace('"zod@4.1.12"', '"zod@9.9.9"'))))
      .toThrow(/does not verify: 'zod' resolves to zod@9\.9\.9/);
    expect(() => lockfileFor(probeManifests, undefined, () => { throw new Error("offline"); }))
      .toThrow(/bun\.lock cannot be produced: .*offline.*needs bun on PATH/);
    expect(() => lockfileFor(probeManifests, undefined, () => {})).toThrow(/bun wrote no lockfile/);
  });

  test("the fake lockfile the other tests use verifies against its manifests", () => {
    expect(bunLockProblems(fakeBunLock(probeManifests), probeManifests)).toEqual([]);
  });
});

describe("writeProjectPackage (init)", () => {
  test("writes the root manifest, tsconfig.json, bun.lock and the shipped checker; refuses an earlier writer's file", () => {
    const dir = tempDir("init-");
    writeProjectPacks(dir, ["ts"]);
    writeProjectPackage(dir, agentRoot, "demo", fakeLockfileMaker);
    for (const path of ["package.json", "tsconfig.json", "bun.lock", "scripts/surface-check.ts"]) expect(existsSync(join(dir, path)), path).toBe(true);
    expect(existsSync(join(dir, "package-lock.json"))).toBe(false);
    expect(readProjectName(dir)).toBe("demo");
    const again = tempDir("init-again-");
    writeProjectPacks(again, ["ts"]);
    writeFileSync(join(again, "tsconfig.json"), "{}\n");
    expect(() => writeProjectPackage(again, agentRoot, "demo", fakeLockfileMaker)).toThrow(/A project initializer wrote tsconfig\.json/);
    expect(existsSync(join(again, "package.json"))).toBe(false);
  });

  test("rewrites the root config files the core copied verbatim, with {{project}} filled", () => {
    const dir = tempDir("init-pg-");
    writeProjectPacks(dir, ["ts", "ts-hexagonal", "ts-drizzle-postgres"]);
    writeFileSync(join(dir, "docker-compose.yml"), "POSTGRES_DB: {{project}}\n");
    writeProjectPackage(dir, agentRoot, "shop", fakeLockfileMaker);
    expect(readFileSync(join(dir, "docker-compose.yml"), "utf8")).toContain("POSTGRES_DB: shop\n");
    expect(readFileSync(join(dir, ".env.example"), "utf8")).toContain("/shop\n");
  });

  test("a lockfile that cannot be produced writes nothing", () => {
    const dir = tempDir("init-offline-");
    writeProjectPacks(dir, ["ts"]);
    expect(() => writeProjectPackage(dir, agentRoot, "demo", () => { throw new Error("offline"); })).toThrow(/cannot be produced/);
    expect(existsSync(join(dir, "package.json"))).toBe(false);
  });
});

// --- real bun (skipped, with the reason logged, where bun is absent) ----------

const HAS_BUN = spawnSync("bun", ["--version"]).status === 0;
if (!HAS_BUN) console.warn("project-package.test.ts: skipping the real-bun lockfile tests — `bun` is not on PATH");

describe.skipIf(!HAS_BUN)("real bun: bun.lock from the generated manifests", () => {
  test("bun install --lockfile-only writes a lockfile the offline check accepts; a frozen install agrees", { timeout: 120_000 }, () => {
    // The pin-free stand-ins: no package leaves the workspace, so no registry.
    const f = fixture({ base: "base", pins: false });
    const project = example(f);
    const generated = generatedManifests(project, f.packs, f.packsDir, "example");
    const { lock, fingerprint } = lockfileFor(generated.manifests, undefined);
    expect(bunLockProblems(lock, generated.manifests, fingerprint)).toEqual([]);
    expect(lock).toContain('"@example/project-management": ["@example/project-management@workspace:contexts/project-management"]');
    // And bun's own frozen install accepts exactly these manifests with it.
    const scratch = tempDir("frozen-");
    for (const [dir, manifest] of generated.manifests) {
      mkdirSync(join(scratch, dir), { recursive: true });
      writeFileSync(join(scratch, dir, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
    }
    writeFileSync(join(scratch, "bun.lock"), lock);
    const frozen = spawnSync("bun", ["install", "--frozen-lockfile", "--ignore-scripts"], { cwd: scratch, encoding: "utf8" });
    expect(frozen.status, frozen.stderr).toBe(0);
    // The setup probe: bun's isolated store, created by the install.
    expect(existsSync(join(scratch, "node_modules", ".bun"))).toBe(true);
    // An added dependency: bun refuses the frozen install, and so does the offline check.
    const added = { name: "@example/web", private: true, dependencies: { "@example/project-management": "workspace:*", zod: "4.1.12" } };
    writeFileSync(join(scratch, "apps/web/package.json"), JSON.stringify(added) + "\n");
    const refused = spawnSync("bun", ["install", "--frozen-lockfile", "--ignore-scripts"], { cwd: scratch, encoding: "utf8" });
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("lockfile is frozen");
    expect(bunLockProblems(lock, new Map(generated.manifests).set("apps/web", added)))
      .toEqual(["workspace 'apps/web' dependencies differ from its manifest", "'zod' is not resolved", "'zod', a dependency of apps/web, resolves to no entry"]);
    // A removed dependency: bun 1.3.14's frozen install lets it through (checked
    // here so a bun that tightens this is noticed); the offline check does not.
    const removed = { name: "@example/web", private: true };
    writeFileSync(join(scratch, "apps/web/package.json"), JSON.stringify(removed) + "\n");
    const tolerated = spawnSync("bun", ["install", "--frozen-lockfile", "--ignore-scripts"], { cwd: scratch, encoding: "utf8" });
    expect(tolerated.status).toBe(0);
    expect(bunLockProblems(lock, new Map(generated.manifests).set("apps/web", removed)))
      .toEqual(["workspace 'apps/web' dependencies differ from its manifest"]);
  });
});
