import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { composePacks, contribute, definePack } from "../../src/socket-registry.ts";
import { adapterTechnologies, emittedFileProblem, type Emitter, skeletonEmitters, TS_PACK, tsPack, workspaceTemplates } from "./pack.ts";

const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A packs directory: pack name → contrib.json object, plus extra pack files. */
function packsDir(packs: Record<string, unknown>, files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "ts-pack-"));
  tmpDirs.push(dir);
  for (const [name, manifest] of Object.entries(packs)) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "contrib.json"), JSON.stringify(manifest));
  }
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

describe("skeletonEmitters (ADR LEG-2026-060)", () => {
  const emitter = (overrides: Partial<Emitter> = {}): Emitter => ({
    name: "domain-barrel",
    description: "The domain barrel.",
    emit: () => [{ path: "contexts/x/src/domain/index.ts", content: "export {};\n", mode: "generated" }],
    ...overrides,
  });
  const packWith = (value: Emitter) =>
    definePack({ name: "hex", dependsOnPacks: [TS_PACK], contributes: [contribute(skeletonEmitters, [value])] });

  test("a dependent pack's emitter composes and reads back typed", () => {
    const registry = composePacks([tsPack, packWith(emitter())]);
    const [read] = registry.read(skeletonEmitters);
    expect(read?.name).toBe("domain-barrel");
    expect(read?.emit({ scope: "@x", phase: "design", packs: [], workspaces: [], adapterTechnologies: [], workspaceTemplates: [] }))
      .toHaveLength(1);
  });

  test.each([
    [{ name: "Domain Barrel" }, /lowercase and dash-separated/],
    [{ description: " " }, /no description/],
    [{ emit: undefined as unknown as Emitter["emit"] }, /no emit/],
  ])("refuses a malformed emitter %#", (overrides, message) => {
    expect(() => composePacks([tsPack, packWith(emitter(overrides))])).toThrow(message);
  });

  test("emitted files must have safe paths, a known mode and a final newline", () => {
    const ok = { path: "contexts/x/src/domain/index.ts", content: "x\n", mode: "generated" as const };
    expect(emittedFileProblem(ok, "e")).toBeUndefined();
    expect(emittedFileProblem({ ...ok, mode: "skeleton" }, "e")).toBeUndefined();
    for (const path of ["/abs.ts", "a/../b.ts", "./a.ts", "a//b.ts", "a/", ".git/x", "x/.BOUNDED/y", "a\\b.ts", ""]) {
      expect(emittedFileProblem({ ...ok, path }, "e"), path).toMatch(/unsafe path/);
    }
    expect(emittedFileProblem({ ...ok, mode: "owned" as never }, "e")).toMatch(/mode/);
    expect(emittedFileProblem({ ...ok, content: "x" }, "e")).toMatch(/final newline/);
  });
});

describe("adapterTechnologies (ADR LEG-2026-061)", () => {
  const MCP = { id: "mcp", direction: "in", featureRole: "tool", description: "MCP tools.", pins: { dependencies: { "@modelcontextprotocol/sdk": "1.20.0" } } };
  const MEMORY = { id: "in-memory", direction: "out", storage: true, database: "value", description: "In-memory stores." };
  const CONSOLE = { id: "console", direction: "out", storage: false, description: "Console stand-ins." };
  const DB = {
    id: "db", direction: "out", storage: true, database: "type", description: "A database.",
    appPins: { bun: { dependencies: { orm: "1.0.0" } } },
    connect: { env: "DATABASE_URL", runtimes: { bun: { function: "connect", from: "orm/bun" } } },
  };

  test("reads, normalises and sorts the composed technologies", () => {
    const dir = packsDir({ hex: { adapterTechnologies: [MEMORY, CONSOLE] }, mcp: { adapterTechnologies: [MCP] }, other: {} });
    expect(adapterTechnologies(["hex", "mcp", "other"], dir)).toEqual([
      { pack: "hex", id: "console", direction: "out", storage: false, description: "Console stand-ins.", pins: { dependencies: {}, devDependencies: {} } },
      { pack: "hex", id: "in-memory", direction: "out", storage: true, database: "value", description: "In-memory stores.", pins: { dependencies: {}, devDependencies: {} } },
      { pack: "mcp", id: "mcp", direction: "in", featureRole: "tool", storage: false, description: "MCP tools.",
        pins: { dependencies: { "@modelcontextprotocol/sdk": "1.20.0" }, devDependencies: {} } },
    ]);
    expect(adapterTechnologies(["other"], dir)).toEqual([]);
  });

  test.each([
    ["not an array", MCP, /must be an array/],
    ["a bad id", [{ ...MCP, id: "Mcp" }], /kebab-case id/],
    ["no description", [{ ...MCP, description: "" }], /description/],
    ["an unknown direction", [{ ...MCP, direction: "sideways" }], /direction/],
    ["an in adapter without a role", [{ ...MCP, featureRole: undefined }], /featureRole/],
    ["an in adapter reusing a naming-table role", [{ ...MCP, featureRole: "handler" }], /featureRole/],
    ["an in adapter with storage", [{ ...MCP, storage: false }], /cannot declare storage/],
    ["an out adapter without storage", [{ ...CONSOLE, storage: undefined }], /must declare storage/],
    ["an out adapter with a role", [{ ...CONSOLE, featureRole: "store" }], /cannot declare a featureRole/],
    ["a storage technology without its database kind", [{ ...MEMORY, database: undefined }], /must declare database/],
    ["a storage technology with an unknown database kind", [{ ...MEMORY, database: "class" }], /must declare database/],
    ["a non-storage technology with a database", [{ ...CONSOLE, database: "value" }], /cannot declare one/],
    ["an in adapter with a database", [{ ...MCP, database: "type" }], /cannot declare a database/],
    ["an unknown field", [{ ...CONSOLE, exportPath: "./x" }], /unknown field 'exportPath'/],
    ["a range pin", [{ ...MCP, pins: { dependencies: { zod: "^4.0.0" } } }], /exact version/],
    ["a pin section typo", [{ ...MCP, pins: { deps: {} } }], /only dependencies and devDependencies/],
    ["a bad package name", [{ ...MCP, pins: { dependencies: { "Bad Name": "1.0.0" } } }], /exact version/],
    ["an entry that is not an object", ["mcp"], /must be an object/],
    ["workspace scripts that are not an object", [{ ...MEMORY, workspaceScripts: ["db:up"] }], /non-empty object/],
    ["empty workspace scripts", [{ ...MEMORY, workspaceScripts: {} }], /non-empty object/],
    ["a malformed script name", [{ ...MEMORY, workspaceScripts: { "DB Up": "x" } }], /script name|name 'DB Up'/],
    ["a script name with a trailing colon", [{ ...MEMORY, workspaceScripts: { "db:": "x" } }], /name 'db:'/],
    ["an empty command", [{ ...MEMORY, workspaceScripts: { "db:up": "" } }], /one-line command/],
    ["a multi-line command", [{ ...MEMORY, workspaceScripts: { "db:up": "a\nb" } }], /one-line command/],
    ["a padded command", [{ ...MEMORY, workspaceScripts: { "db:up": " a" } }], /one-line command/],
    ["a non-string command", [{ ...MEMORY, workspaceScripts: { "db:up": 1 } }], /one-line command/],
    ["appPins that are not an object", [{ ...MEMORY, appPins: ["bun"] }], /appPins must be a non-empty object/],
    ["empty appPins", [{ ...MEMORY, appPins: {} }], /appPins must be a non-empty object/],
    ["an appPins runtime that is not kebab-case", [{ ...MEMORY, appPins: { Bun: {} } }], /runtime 'Bun' must be kebab-case/],
    ["a range app pin", [{ ...MEMORY, appPins: { node: { dependencies: { pg: "^8" } } } }], /appPins\.node pins\.dependencies entry 'pg'/],
    ["an app pin section typo", [{ ...MEMORY, appPins: { node: { deps: {} } } }], /only dependencies and devDependencies/],
    ["connect on a technology without storage", [{ ...CONSOLE, connect: { env: "URL", runtimes: { bun: { function: "f", from: "x" } } } }],
      /not a storage technology and cannot declare connect/],
    ["a connect env that is not an environment variable", [{ ...DB, connect: { ...DB.connect, env: "database-url" } }], /connect\.env must be/],
    ["a connect env with a doubled underscore", [{ ...DB, connect: { ...DB.connect, env: "DATABASE__URL" } }], /plain upper-case identifier/],
    ["a connect env with a trailing underscore", [{ ...DB, connect: { ...DB.connect, env: "DATABASE_" } }], /plain upper-case identifier/],
    ["a connect env in mixed case", [{ ...DB, connect: { ...DB.connect, env: "Database_Url" } }], /plain upper-case identifier/],
    ["a connect with no runtimes", [{ ...DB, connect: { env: "DATABASE_URL", runtimes: {} } }], /at least one app runtime/],
    ["a connect field typo", [{ ...DB, connect: { ...DB.connect, url: "x" } }], /connect has an unknown field 'url'/],
    ["a connect driver that is not a function name", [{ ...DB, connect: { env: "DATABASE_URL", runtimes: { bun: { function: "a b", from: "orm/bun" } } } }],
      /connect\.runtimes\.bun needs a function name/],
    ["a connect module that is not bare", [{ ...DB, connect: { env: "DATABASE_URL", runtimes: { bun: { function: "connect", from: "./orm" } } } }],
      /bare module specifier/],
    ["a connect module whose package the runtime's appPins lack", [{ ...DB, connect: { env: "DATABASE_URL", runtimes: { node: { function: "connect", from: "orm/node" } } } }],
      /imports from 'orm\/node', but appPins\.node\.dependencies does not pin 'orm'/],
    ["one script from two technologies", [
      { ...MEMORY, workspaceScripts: { "db:up": "a" } }, { ...CONSOLE, workspaceScripts: { "db:up": "a" } },
    ], /workspace script 'db:up' is already contributed by 'in-memory'/],
  ])("refuses %s", (_label, value, message) => {
    expect(() => adapterTechnologies(["p"], packsDir({ p: { adapterTechnologies: value } }))).toThrow(message);
  });

  test("workspace scripts are read with sorted names, and absent when not declared", () => {
    const withScripts = { ...MEMORY, workspaceScripts: { "db:migrate": "tool migrate", "db:generate": "tool generate" } };
    const [read] = adapterTechnologies(["p"], packsDir({ p: { adapterTechnologies: [withScripts] } }));
    expect(read!.workspaceScripts).toEqual({ "db:generate": "tool generate", "db:migrate": "tool migrate" });
    expect(Object.keys(read!.workspaceScripts!)).toEqual(["db:generate", "db:migrate"]);
    const [plain] = adapterTechnologies(["p"], packsDir({ p: { adapterTechnologies: [MEMORY] } }));
    expect(plain).not.toHaveProperty("workspaceScripts");
  });

  test("appPins are read per runtime, sorted, each a full pin set; absent when not declared", () => {
    const withAppPins = { ...MEMORY, appPins: { node: { dependencies: { pg: "8.23.1" } }, bun: {} } };
    const [read] = adapterTechnologies(["p"], packsDir({ p: { adapterTechnologies: [withAppPins] } }));
    expect(read!.appPins).toEqual({
      bun: { dependencies: {}, devDependencies: {} },
      node: { dependencies: { pg: "8.23.1" }, devDependencies: {} },
    });
    expect(Object.keys(read!.appPins!)).toEqual(["bun", "node"]);
    const [plain] = adapterTechnologies(["p"], packsDir({ p: { adapterTechnologies: [MEMORY] } }));
    expect(plain).not.toHaveProperty("appPins");
  });

  test("connect is read with its runtimes sorted; absent when not declared (ADR LEG-2026-067)", () => {
    const both = { ...DB, appPins: { node: { dependencies: { orm: "1.0.0" } }, bun: { dependencies: { orm: "1.0.0" } } },
      connect: { env: "DATABASE_URL", runtimes: { node: { function: "connect", from: "orm/node" }, bun: { function: "connect", from: "orm/bun" } } } };
    const [read] = adapterTechnologies(["p"], packsDir({ p: { adapterTechnologies: [both] } }));
    expect(read!.connect).toEqual({
      env: "DATABASE_URL",
      runtimes: { bun: { function: "connect", from: "orm/bun" }, node: { function: "connect", from: "orm/node" } },
    });
    expect(Object.keys(read!.connect!.runtimes)).toEqual(["bun", "node"]);
    const [plain] = adapterTechnologies(["p"], packsDir({ p: { adapterTechnologies: [MEMORY] } }));
    expect(plain).not.toHaveProperty("connect");
  });

  test("one id contributed by two packs is refused", () => {
    const dir = packsDir({ a: { adapterTechnologies: [MCP] }, b: { adapterTechnologies: [MCP] } });
    expect(() => adapterTechnologies(["a", "b"], dir)).toThrow(/contributed twice/);
  });

  test("an unreadable selected manifest throws", () => {
    expect(() => adapterTechnologies(["missing"], packsDir({}))).toThrow(/missing or malformed/);
  });
});

describe("workspaceTemplates (ADR LEG-2026-061)", () => {
  const FILES = {
    "web/templates/web/package.json": "{}",
    "web/templates/web/main.ts": "x",
    "web/templates/web/composition-root.ts": "x",
    "hex/templates/context/package.json": "{}",
  };
  const WEB = {
    root: "apps",
    manifest: "templates/web/package.json",
    description: "A web app.",
    files: {
      "src/server/main.ts": { source: "templates/web/main.ts", mode: "generated" },
      "src/server/composition-root.ts": { source: "templates/web/composition-root.ts", mode: "skeleton" },
    },
  };
  const CONTEXT = { root: "contexts", manifest: "templates/context/package.json", description: "A bounded context." };

  test("reads, sorts kinds and files", () => {
    const dir = packsDir({ hex: { workspaceTemplates: { context: CONTEXT } }, web: { workspaceTemplates: { web: WEB } } }, FILES);
    expect(workspaceTemplates(["hex", "web"], dir)).toEqual([
      { pack: "hex", kind: "context", root: "contexts", manifest: "templates/context/package.json", description: "A bounded context.", files: [] },
      { pack: "web", kind: "web", root: "apps", manifest: "templates/web/package.json", description: "A web app.", files: [
        { path: "src/server/composition-root.ts", source: "templates/web/composition-root.ts", mode: "skeleton" },
        { path: "src/server/main.ts", source: "templates/web/main.ts", mode: "generated" },
      ] },
    ]);
  });

  const web = (overrides: Record<string, unknown>) => packsDir({ web: { workspaceTemplates: { web: { ...WEB, ...overrides } } } }, FILES);
  test.each([
    ["a bad root", { root: "apps/web" }, /root/],
    ["no description", { description: "" }, /description/],
    ["a missing manifest", { manifest: "templates/web/nope.json" }, /does not ship/],
    ["a non-JSON manifest", { manifest: "templates/web/main.ts" }, /\.json/],
    ["an escaping manifest", { manifest: "../hex/templates/context/package.json" }, /pack-relative/],
    ["an absolute manifest", { manifest: "/etc/passwd" }, /pack-relative/],
    ["an unknown field", { pins: {} }, /unknown field 'pins'/],
    ["a template package.json file", { files: { "package.json": { source: "templates/web/main.ts", mode: "generated" } } }, /other than package.json/],
    ["an escaping target", { files: { "../x.ts": { source: "templates/web/main.ts", mode: "generated" } } }, /workspace-relative/],
    ["an absolute target", { files: { "/x.ts": { source: "templates/web/main.ts", mode: "generated" } } }, /workspace-relative/],
    ["a bad mode", { files: { "src/x.ts": { source: "templates/web/main.ts", mode: "owned" } } }, /mode/],
    ["a missing source", { files: { "src/x.ts": { source: "templates/web/nope.ts", mode: "skeleton" } } }, /does not ship/],
    ["an unknown file field", { files: { "src/x.ts": { source: "templates/web/main.ts", mode: "skeleton", why: "" } } }, /unknown field/],
    ["files that are not an object", { files: ["src/x.ts"] }, /must be an object/],
    ["a runtime that is not kebab-case", { runtime: "Node" }, /runtime must be kebab-case/],
    ["a runtime that is not a string", { runtime: 1 }, /runtime must be kebab-case/],
  ])("refuses %s", (_label, overrides, message) => {
    expect(() => workspaceTemplates(["web"], web(overrides))).toThrow(message);
  });

  test("a declared runtime is read; none is absent", () => {
    const [read] = workspaceTemplates(["web"], web({ runtime: "bun" }));
    expect(read!.runtime).toBe("bun");
    expect(workspaceTemplates(["web"], web({}))[0]).not.toHaveProperty("runtime");
  });

  test("a kind must be kebab-case and contributed once", () => {
    expect(() => workspaceTemplates(["p"], packsDir({ p: { workspaceTemplates: { Web: CONTEXT } } }, FILES))).toThrow(/kebab-case kind/);
    const dir = packsDir({ hex: { workspaceTemplates: { context: CONTEXT } }, web: { workspaceTemplates: { context: CONTEXT } } }, {
      ...FILES, "web/templates/context/package.json": "{}",
    });
    expect(() => workspaceTemplates(["hex", "web"], dir)).toThrow(/contributed twice/);
  });

  test("a non-object field and an unreadable selected manifest throw", () => {
    expect(() => workspaceTemplates(["p"], packsDir({ p: { workspaceTemplates: ["web"] } }))).toThrow(/must be an object/);
    expect(() => workspaceTemplates(["missing"], packsDir({}))).toThrow(/missing or malformed/);
  });
});
