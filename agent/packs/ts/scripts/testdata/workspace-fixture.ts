// Test support for the generated monorepo config (project-package.test.ts,
// project-config.test.ts). Not a test file: it builds fixtures.
//
// A fixture HARNESS is a temporary directory with a `packs/` holding:
//   · the real ts pack (a symlink), or `base`, a minimal stand-in whose
//     package template pins nothing, so real `bun install --lockfile-only`
//     runs without the registry;
//   · `hex`, a stand-in for the layout and adapter packs (WI-5, WI-6, WI-7):
//     source roots, the context and app workspace templates, and adapter
//     technologies. With pins, its templates reproduce the worked example's
//     workspace manifests (copied inline below, never read from elsewhere),
//     each version range replaced by an exact pin.
// A fixture PROJECT is the example's tree in miniature: one context with
// every adapter folder's generated index, and a TN declaring the four apps.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { writeProjectPacks } from "../../../../src/project-composition.ts";
import type { LockfileMaker, Manifest } from "../project-package.ts";

const REAL_TS_PACK = join(import.meta.dirname, "..", "..");

const write = (root: string, path: string, content: string): void => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
};
const json = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";

/** The worked example's workspace manifests, verbatim apart from formatting
 *  (their version ranges are what the harness replaces with exact pins). */
export const EXAMPLE_MANIFESTS: Readonly<Record<string, Manifest>> = {
  "": {
    name: "example-project",
    private: true,
    type: "module",
    workspaces: ["contexts/*", "apps/*"],
    scripts: { "db:up": "docker compose up -d", "db:migrate": "bun run --filter @example/project-management db:migrate" },
    devDependencies: { "@types/bun": "latest", typescript: "^5" },
  },
  "apps/desktop": {
    name: "@example/desktop",
    private: true,
    main: "dist/main/main.js",
    scripts: {
      build: "bun build src/main/main.ts --outdir dist/main --target node --format cjs --external electron && bun build src/renderer/index.html --outdir dist/renderer",
      dev: "bun run build && electron .",
    },
    dependencies: { "@example/project-management": "workspace:*", react: "^19", "react-dom": "^19" },
    devDependencies: { "@types/react": "^19", "@types/react-dom": "^19", electron: "^38" },
  },
  "apps/lambdas": {
    name: "@example/lambdas",
    private: true,
    type: "module",
    scripts: { build: "bun build src/export-projects.ts --outdir dist --target node" },
    dependencies: { "@example/project-management": "workspace:*" },
  },
  "apps/mcp": {
    name: "@example/mcp",
    private: true,
    type: "module",
    scripts: { start: "bun src/main.ts" },
    dependencies: { "@example/project-management": "workspace:*", "@modelcontextprotocol/sdk": "^1" },
  },
  "apps/web": {
    name: "@example/web",
    private: true,
    type: "module",
    scripts: { dev: "bun --hot src/server/main.ts" },
    dependencies: {
      "@example/project-management": "workspace:*",
      "@trpc/client": "^11",
      "@trpc/server": "^11",
      react: "^19",
      "react-dom": "^19",
    },
    devDependencies: { "@types/react": "^19", "@types/react-dom": "^19" },
  },
  "contexts/project-management": {
    name: "@example/project-management",
    private: true,
    type: "module",
    scripts: { "db:generate": "drizzle-kit generate", "db:migrate": "bun --env-file=../../.env run drizzle-kit migrate" },
    exports: {
      "./domain": "./src/domain/index.ts",
      "./application": "./src/application/index.ts",
      "./adapters/trpc": "./src/adapters/in/trpc/index.ts",
      "./adapters/lambda": "./src/adapters/in/lambda/index.ts",
      "./adapters/mcp": "./src/adapters/in/mcp/index.ts",
      "./adapters/in-memory": "./src/adapters/out/in-memory/index.ts",
      "./adapters/console": "./src/adapters/out/console/index.ts",
    },
    dependencies: { "@modelcontextprotocol/sdk": "^1", "@trpc/server": "^11", "drizzle-orm": "^0.45.3", pg: "^8.23.1", zod: "^4" },
    devDependencies: { "@types/pg": "^8.23.1", "drizzle-kit": "^0.31.11" },
  },
};

/** The example's root tsconfig.json. */
export const EXAMPLE_TSCONFIG = {
  extends: "./tsconfig.base.json",
  compilerOptions: { lib: ["ESNext", "DOM"] },
  include: ["contexts/*/src", "architecture.test.ts", "apps/*/src"],
};

/** Exact pins standing in for the example's ranges. */
const PIN: Readonly<Record<string, string>> = {
  "@modelcontextprotocol/sdk": "1.20.0",
  "@trpc/client": "11.18.0",
  "@trpc/server": "11.18.0",
  "@types/pg": "8.23.1",
  "@types/react": "19.2.2",
  "@types/react-dom": "19.2.2",
  "drizzle-kit": "0.31.11",
  "drizzle-orm": "0.45.3",
  electron: "38.2.0",
  pg: "8.23.1",
  react: "19.2.0",
  "react-dom": "19.2.0",
  zod: "4.1.12",
};

/** Dependencies and scripts an adapter technology brings into a context. The
 *  example's context lists Drizzle's pins and scripts without a drizzle
 *  folder (its persistence is unfinished); here they come, as in a real
 *  composition, from the drizzle technology and its folder. */
const TECH_PINNED = new Set(["@trpc/server", "@modelcontextprotocol/sdk", "drizzle-orm", "pg", "@types/pg", "drizzle-kit"]);
const DRIZZLE_SCRIPTS = EXAMPLE_MANIFESTS["contexts/project-management"]!["scripts"] as Record<string, string>;

/** A template: the example manifest minus what the generator owns (name,
 *  private, exports, workspace dependencies, and in a context the
 *  technologies' pins), each remaining range an exact pin; with `pins`
 *  false, no dependencies at all. */
function templateOf(dir: string, pins: boolean): Manifest {
  const { name: _name, private: _private, exports: _exports, ...rest } = EXAMPLE_MANIFESTS[dir]!;
  const out: Manifest = { ...rest };
  const isContext = dir.startsWith("contexts/");
  if (isContext) delete out["scripts"];
  for (const section of ["dependencies", "devDependencies"] as const) {
    const deps = Object.keys((rest[section] ?? {}) as Record<string, string>)
      .filter((dep) => pins && !dep.startsWith("@example/") && !(isContext && TECH_PINNED.has(dep)));
    if (deps.length > 0) out[section] = Object.fromEntries(deps.map((dep) => [dep, PIN[dep]!]));
    else delete out[section];
  }
  return out;
}

export interface FixtureOptions {
  /** Use the real ts pack (default) or the pin-free `base` stand-in. */
  readonly base?: "ts" | "base";
  /** Templates and technologies carry the example's pins (default true). */
  readonly pins?: boolean;
}

export interface Fixture {
  /** The fixture harness root (its `packs/` is the packs directory). */
  readonly harness: string;
  readonly packsDir: string;
  /** The composition a fixture project uses. */
  readonly packs: readonly string[];
  cleanup(): void;
}

export function fixtureHarness(options: FixtureOptions = {}): Fixture {
  const base = options.base ?? "ts";
  const pins = options.pins ?? true;
  const harness = mkdtempSync(join(tmpdir(), "workspace-fixture-harness-"));
  const packsDir = join(harness, "packs");
  mkdirSync(packsDir);
  if (base === "ts") symlinkSync(REAL_TS_PACK, join(packsDir, "ts"), "dir");
  else {
    write(packsDir, "base/contrib.json", json({
      projectPackageTemplate: "reference/package.json",
      contractFileSuffixes: [".contract.ts"],
      testFileSuffixes: [".test.ts"],
      projectSetupCommands: [["bun", "install", "--frozen-lockfile", "--ignore-scripts"]],
      projectSetupProbes: ["node_modules/.bun"],
      projectNestedConfigNames: ["package.json", "tsconfig*.json", "bunfig.toml"],
      projectDependencyDirs: ["node_modules"],
      projectConfigNames: ["package.json", "bun.lock", "bun.lockb", "package-lock.json", "tsconfig*.json"],
    }));
    write(packsDir, "base/reference/package.json", json({ private: true, type: "module", scripts: { test: "bun test" }, dependencies: {}, devDependencies: {} }));
  }
  const kinds = ["web", "mcp", "lambdas", "desktop"];
  const templates: Record<string, unknown> = {
    context: { root: "contexts", manifest: "templates/context.json", description: "A bounded context." },
  };
  for (const kind of kinds) templates[kind] = { root: "apps", manifest: `templates/${kind}.json`, description: `The ${kind} app.` };
  write(packsDir, "hex/contrib.json", json({
    dependsOnPacks: [base],
    sourceRoots: ["contexts/*/src", "apps/*/src"],
    testFileSuffixes: [".test-support.ts"],
    generatedFileGlobs: [
      "architecture.test.ts",
      "contexts/*/drizzle.config.ts",
      "contexts/*/src/adapters/in/trpc/**",
      "contexts/*/src/adapters/out/*/index.ts",
    ],
    projectNestedConfigNames: ["drizzle.config.*"],
    ...(pins ? { projectScripts: EXAMPLE_MANIFESTS[""]!["scripts"] } : {}),
    workspaceTemplates: templates,
    adapterTechnologies: [
      { id: "trpc", direction: "in", featureRole: "procedure", description: "tRPC.", ...(pins ? { pins: { dependencies: { "@trpc/server": PIN["@trpc/server"] } } } : {}) },
      { id: "mcp", direction: "in", featureRole: "tool", description: "MCP.", ...(pins ? { pins: { dependencies: { "@modelcontextprotocol/sdk": PIN["@modelcontextprotocol/sdk"] } } } : {}) },
      { id: "lambda", direction: "in", featureRole: "lambda", description: "Lambda." },
      { id: "in-memory", direction: "out", storage: true, database: "value", description: "In memory." },
      { id: "console", direction: "out", storage: false, description: "Console." },
      {
        id: "drizzle", direction: "out", storage: true, database: "type", description: "Drizzle.", workspaceScripts: DRIZZLE_SCRIPTS,
        ...(pins ? { pins: {
          dependencies: { "drizzle-orm": PIN["drizzle-orm"], pg: PIN["pg"] },
          devDependencies: { "@types/pg": PIN["@types/pg"], "drizzle-kit": PIN["drizzle-kit"] },
        } } : {}),
      },
      { id: "mailer", direction: "out", storage: false, description: "Named by no @implementedBy.", workspaceScripts: { "mail:up": "echo up" } },
    ],
  }));
  write(packsDir, "hex/templates/context.json", json(templateOf("contexts/project-management", pins)));
  for (const kind of kinds) write(packsDir, `hex/templates/${kind}.json`, json(templateOf(`apps/${kind}`, pins)));
  return { harness, packsDir, packs: [base, "hex"], cleanup: () => rmSync(harness, { recursive: true, force: true }) };
}

/** The TN declaring the example's four apps. */
export const EXAMPLE_TN = [
  "---",
  "issue: 1",
  "status: active",
  "workspaces:",
  "  apps/web: web",
  "  apps/mcp: mcp",
  "  apps/lambdas: lambdas",
  "  apps/desktop: desktop",
  "contracts:",
  "  - contexts/project-management/src/domain/projects/project-name.contract.ts",
  "---",
  "",
  "# TN-1",
  "",
].join("\n");

/** A feature contract in the example's shape, with its tags (TN-26-012 §3, §4). */
export function featureContract(inPort: string, tags: { exposedVia?: string; store?: boolean; exporter?: string } = {}): string {
  return [
    'import type { Result } from "@example/project-management/domain";',
    "",
    "/**",
    ` * ${inPort}`,
    ...(tags.exposedVia === undefined ? [] : [` * @exposedVia ${tags.exposedVia}`]),
    " */",
    `export interface ${inPort} {`,
    "  execute(): Promise<Result<void>>;",
    "}",
    ...(tags.store === false ? [] : ["", `export interface ${inPort}Store {`, "  all(): Promise<void>;", "}"]),
    ...(tags.exporter === undefined ? [] : ["", "/**", ` * @implementedBy ${tags.exporter}`, " */", "export interface ProjectExporter {", "  export(): Promise<void>;", "}"]),
    "",
  ].join("\n");
}

/** A fresh fixture project: composition, installation marker, the example's
 *  context (a domain contract and its features' contracts, tagged as the
 *  example's are) and the TN declaring its apps. No adapter folder exists:
 *  the manifests follow the design, not the disk. */
export function exampleProject(fixture: Fixture, options: { readonly name?: string } = {}): { project: string; cleanup(): void } {
  const parent = mkdtempSync(join(tmpdir(), "workspace-fixture-project-"));
  const project = join(parent, options.name ?? "example");
  mkdirSync(project);
  writeProjectPacks(project, fixture.packs);
  write(project, ".bounded/installation.json", "{}\n");
  const src = "contexts/project-management/src";
  write(project, `${src}/domain/projects/project-name.contract.ts`, "export interface ProjectName { readonly value: string }\n");
  const app = `${src}/application`;
  write(project, `${app}/notes/create-note/create-note.contract.ts`, featureContract("CreateNote", { exposedVia: "trpc" }));
  write(project, `${app}/notes/list-notes/list-notes.contract.ts`, featureContract("ListNotes", { exposedVia: "trpc" }));
  write(project, `${app}/projects/create-project/create-project.contract.ts`, featureContract("CreateProject", { exposedVia: "trpc mcp" }));
  write(project, `${app}/projects/list-projects/list-projects.contract.ts`, featureContract("ListProjects", { exposedVia: "trpc mcp" }));
  write(project, `${app}/projects/export-projects/export-projects.contract.ts`,
    featureContract("ExportProjects", { exposedVia: "lambda", exporter: "console" }));
  for (const app of ["web", "mcp", "lambdas", "desktop"]) write(project, `apps/${app}/src/main.ts`, "export {};\n");
  write(project, "docs/tn/TN-1.md", EXAMPLE_TN);
  return { project, cleanup: () => rmSync(parent, { recursive: true, force: true }) };
}

/** The manifests in a directory, by workspace directory, as bun would see them. */
function manifestsIn(dir: string): Map<string, Manifest> {
  const root = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest;
  const out = new Map<string, Manifest>([["", root]]);
  for (const glob of (root["workspaces"] ?? []) as string[]) {
    const parent = glob.replace(/\/\*$/, "");
    let entries: string[] = [];
    try {
      entries = readdirSync(join(dir, parent)).sort();
    } catch {
      entries = [];
    }
    for (const name of entries) {
      try {
        out.set(`${parent}/${name}`, JSON.parse(readFileSync(join(dir, parent, name, "package.json"), "utf8")) as Manifest);
      } catch {
        // not a workspace
      }
    }
  }
  return out;
}

/**
 * A bun-shaped lockfile resolving every pin exactly and every workspace to
 * its directory — what `bun install --lockfile-only` writes, minus
 * integrity hashes. For tests that must not reach the registry.
 */
export function fakeBunLock(manifests: ReadonlyMap<string, Manifest>): string {
  const workspaces: Record<string, Manifest> = {};
  const packages: Record<string, unknown[]> = {};
  for (const [dir, manifest] of [...manifests].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const entry: Manifest = { name: manifest["name"] };
    for (const section of ["dependencies", "devDependencies"] as const) {
      const deps = manifest[section] as Record<string, string> | undefined;
      if (deps !== undefined && Object.keys(deps).length > 0) entry[section] = deps;
      for (const [dep, version] of Object.entries(deps ?? {})) {
        if (version !== "workspace:*") packages[dep] = [`${dep}@${version}`, "", {}, "sha512-fake"];
      }
    }
    workspaces[dir] = entry;
    if (dir !== "") packages[manifest["name"] as string] = [`${manifest["name"] as string}@workspace:${dir}`];
  }
  return JSON.stringify({ lockfileVersion: 1, configVersion: 1, workspaces, packages }, null, 2) + "\n";
}

/** A LockfileMaker that writes {@link fakeBunLock} for the manifests in its directory. */
export const fakeLockfileMaker: LockfileMaker = (dir) => {
  writeFileSync(join(dir, "bun.lock"), fakeBunLock(manifestsIn(dir)));
};
