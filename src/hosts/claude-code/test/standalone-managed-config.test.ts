import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as domain from "bounded/domain";
import * as adapters from "bounded/adapters";
import { openProject } from "bounded/open-project";
import { buildStandaloneConfigModule, standaloneManagedConfigSource } from "../standalone-config-as-module.ts";

type Node = {
  id: string; name: string; dependencies: Record<string, string>; exports: unknown;
  files: Record<string, Uint8Array>;
  catalogue: null | { packs: { id: string; importPath: string; exportName: string; dependsOn: readonly string[];
    contributesTo: readonly string[]; points: readonly { id: string; key: string; description: string }[];
    ports: readonly { id: string; key: string }[]; optionalPorts: readonly { id: string; key: string }[] }[] };
};
type Graph = { roots: Record<string, string>; nodes: Record<string, Node>;
  recheckBoundary: () => Promise<{ ok: true; value: undefined } | { ok: false; error: string }> };
const bytes = (source: string): Uint8Array => new TextEncoder().encode(source);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  Reflect.deleteProperty(globalThis, "__boundedStandaloneRuntimeExports");
  Reflect.deleteProperty(globalThis, "__boundedManagedUnselectedExecuted");
  Reflect.deleteProperty(globalThis, "__boundedManagedSelectedExecuted");
});
function project(source: string): { root: string; config: string } {
  const root = mkdtempSync(join(tmpdir(), "bounded-managed-loader-"));
  roots.push(root);
  const config = join(root, "bounded.config.ts");
  writeFileSync(config, source);
  Reflect.set(globalThis, "__boundedStandaloneRuntimeExports", Object.freeze({ "bounded/domain": domain }));
  return { root, config };
}
function node(name: string, version: string, source: string, dependencies: Record<string, string> = {}): Node {
  return { id: `${name}@${version}`, name, dependencies,
    exports: { ".": { import: "./dist/index.js" } }, files: { "dist/index.js": bytes(source) }, catalogue: null };
}
function graph(nodes: readonly Node[], rootsByName: Record<string, string>): Graph {
  return { roots: rootsByName, nodes: Object.fromEntries(nodes.map((item) => [item.id, item])),
    recheckBoundary: async () => ({ ok: true, value: undefined }) };
}
function cataloguePack(pack: domain.BasePack, importPath: string, exportName: string): NonNullable<Node["catalogue"]>["packs"][number] {
  const description = domain.PackDescription.of(pack);
  return { id: description.id, importPath, exportName, dependsOn: description.dependsOn,
    contributesTo: description.contributesTo, points: description.points, ports: description.ports,
    optionalPorts: description.optionalPorts };
}
function declarations(root: string): Record<string, Uint8Array> {
  const result: Record<string, Uint8Array> = {};
  const visit = (directory: string, prefix = ""): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) visit(join(directory, entry.name), name);
      else if (entry.isFile() && name.endsWith(".d.ts")) result[name] = readFileSync(join(directory, entry.name));
    }
  };
  visit(root);
  return result;
}
async function load(root: string, selected: Graph) {
  return standaloneManagedConfigSource((file, projectRoot) => buildStandaloneConfigModule(file, projectRoot, selected)).load(root);
}

describe("standalone managed config from a verified snapshot", () => {
  test("one captured project graph drives both typechecking and runtime, with importer-local helper versions", async () => {
    const first = node("bounded-first", "1.0.0", 'import { version } from "plain-helper"; export const firstVersion = version;\n',
      { "plain-helper": "plain-helper@1.0.0" });
    const second = node("bounded-second", "1.0.0", 'import { version } from "plain-helper"; export const secondVersion = version;\n',
      { "plain-helper": "plain-helper@2.0.0" });
    const helperOne = node("plain-helper", "1.0.0", 'export const version = "one";\n');
    const helperTwo = node("plain-helper", "2.0.0", 'export const version = "two";\n');
    first.exports = { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } };
    second.exports = { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } };
    helperOne.exports = { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } };
    helperTwo.exports = { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } };
    first.files["dist/index.d.ts"] = bytes('import type { Version } from "plain-helper"; export declare const firstVersion: Version;\n');
    second.files["dist/index.d.ts"] = bytes('import type { Version } from "plain-helper"; export declare const secondVersion: Version;\n');
    helperOne.files["dist/index.d.ts"] = bytes('export type Version = "one";\n');
    helperTwo.files["dist/index.d.ts"] = bytes('export type Version = "two";\n');
    const unused = node("bounded-unused", "1.0.0", 'globalThis.__boundedManagedUnselectedExecuted = true;\n');
    const chosen = graph([first, second, helperOne, helperTwo, unused],
      { "bounded-first": first.id, "bounded-second": second.id, "bounded-unused": unused.id });
    const { root, config } = project('import { defineConfig, definePack, packIdsFor } from "bounded/domain";\nimport { firstVersion } from "bounded-first";\nimport { secondVersion } from "bounded-second";\nimport { localName } from "./local-name.ts";\nconst first: "one" = firstVersion; const second: "two" = secondVersion;\nexport default defineConfig({ packs: [definePack({ id: packIdsFor("local")(localName + first + second) })] });\n');
    const localName = join(root, "local-name.ts");
    writeFileSync(localName, 'export const localName = "initial-";\n');
    type Snapshot = { readonly modulePath: string; readonly digest: string; readonly sourceFiles: Readonly<Record<string, Uint8Array>> };
    type Prepare = (file: string, root: string, options: { readonly managedGraph: Graph;
      readonly boundedRuntimeExports: Readonly<Record<string, Readonly<Record<string, unknown>>>> }) => Promise<Snapshot>;
    type Check = (snapshot: Snapshot, types: { readonly boundedDeclarations: Readonly<Record<string, Uint8Array>>;
      readonly standardLibraries: Readonly<Record<string, Uint8Array>> }) => Promise<{ readonly ok: boolean; readonly diagnostics: readonly string[] }>;
    const prepare = Reflect.get(adapters, "prepareStandaloneProjectSnapshot") as Prepare | undefined;
    const check = Reflect.get(adapters, "checkStandaloneProjectSnapshot") as Check | undefined;
    expect(prepare).toBeFunction();
    expect(check).toBeFunction();
    if (prepare === undefined || check === undefined) return;
    const options = { managedGraph: chosen, boundedRuntimeExports: { "bounded/domain": domain } };
    const snapshot = await prepare(config, root, options);
    expect(snapshot.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(new TextDecoder().decode(snapshot.sourceFiles[localName])).toContain("initial-");
    const same = await prepare(config, root, options);
    expect(same.digest).toBe(snapshot.digest);
    writeFileSync(localName, 'const changed: number = "wrong"; throw new Error("mutated project source executed");\n');
    const changed = await prepare(config, root, options);
    expect(changed.digest).not.toBe(snapshot.digest);
    const checked = await check(snapshot, { boundedDeclarations: declarations(join(import.meta.dir, "../../../dist/types")),
      standardLibraries: declarations(join(import.meta.dir, "../../../../node_modules/typescript/lib")) });
    expect(checked).toEqual({ ok: true, diagnostics: [] });
    const loaded = await standaloneManagedConfigSource(async () => snapshot.modulePath).load(root);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      const [selectedPack] = loaded.value.listedPacks;
      if (selectedPack === undefined) throw new Error("snapshot selected no local pack");
      expect(domain.PackDescription.of(selectedPack).id).toBe("local/initial-onetwo");
    }
    expect(Reflect.get(globalThis, "__boundedManagedUnselectedExecuted")).toBeUndefined();
  });
  test("a selected pack with an exact locked descriptor and export opens", async () => {
    const published = domain.definePack({ id: domain.packIdsFor("bounded-example")("selected"), dependsOn: [domain.corePack],
      points: { selectedRules: domain.point({ description: "Selected rules", check: (raw: unknown) => ({ ok: true, value: raw }) }) } });
    const selected = node("bounded-example", "1.0.0", 'import { definePack, packIdsFor, corePack, point } from "bounded/domain";\nexport const selectedPack = definePack({ id: packIdsFor("bounded-example")("selected"), dependsOn: [corePack], points: { selectedRules: point({ description: "Selected rules", check: (raw) => ({ ok: true, value: raw }) }) } });\n');
    selected.catalogue = { packs: [cataloguePack(published, "bounded-example", "selectedPack")] };
    const { root } = project('import { defineConfig } from "bounded/domain";\nimport { selectedPack } from "bounded-example";\nexport default defineConfig({ packs: [selectedPack] });\n');
    const loaded = await load(root, graph([selected], { "bounded-example": selected.id }));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      const [selectedPack] = loaded.value.listedPacks;
      if (selectedPack === undefined) throw new Error("configuration selected no pack");
      expect(domain.PackDescription.of(selectedPack).id).toBe("bounded-example/selected");
    }
  });

  test("a selected managed pack with a required port refuses until the project provides that port", async () => {
    const id = domain.packIdsFor("bounded-example")("port-bearing");
    const published = domain.definePack({ id, dependsOn: [domain.corePack],
      ports: { managedNotes: domain.portKeysFor(id)<{ save(text: string): Promise<void> }>("managedNotes") } });
    const selected = node("bounded-example", "1.0.0", 'import { corePack, definePack, packIdsFor, portKeysFor } from "bounded/domain";\nconst id = packIdsFor("bounded-example")("port-bearing");\nexport const portBearingPack = definePack({ id, dependsOn: [corePack], ports: { managedNotes: portKeysFor(id)("managedNotes") } });\n');
    selected.catalogue = { packs: [cataloguePack(published, "bounded-example", "portBearingPack")] };
    const { root } = project('import { defineConfig } from "bounded/domain";\nimport { portBearingPack } from "bounded-example";\nexport default defineConfig({ packs: [portBearingPack] });\n');
    const opened = await openProject(root, { configSource: standaloneManagedConfigSource((file, projectRoot) =>
      buildStandaloneConfigModule(file, projectRoot, graph([selected], { "bounded-example": selected.id }))) });
    expect(opened.problem).toMatch(/bounded-example\/port-bearing/i);
    expect(opened.problem).toMatch(/managedNotes|managed-notes/i);
  });

  test("direct roots resolve distinct importer-local dependency versions and leave an unselected installed pack inert", async () => {
    const first = node("bounded-first", "1.0.0", 'import { version } from "plain-helper"; export const firstVersion = version;\n', { "plain-helper": "plain-helper@1.0.0" });
    const second = node("bounded-second", "1.0.0", 'import { version } from "plain-helper"; export const secondVersion = version;\n', { "plain-helper": "plain-helper@2.0.0" });
    const unused = node("bounded-unused", "1.0.0", 'globalThis.__boundedManagedUnselectedExecuted = true; export const unused = 1;\n');
    const chosen = graph([first, second, unused, node("plain-helper", "1.0.0", 'export const version = "one";\n'),
      node("plain-helper", "2.0.0", 'export const version = "two";\n')],
    { "bounded-first": first.id, "bounded-second": second.id, "bounded-unused": unused.id });
    const { root } = project('import { defineConfig, definePack, packIdsFor } from "bounded/domain";\nimport { firstVersion } from "bounded-first";\nimport { secondVersion } from "bounded-second";\nexport default defineConfig({ packs: [definePack({ id: packIdsFor("local")(firstVersion + "-" + secondVersion) })] });\n');
    const loaded = await load(root, chosen);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      const [selectedPack] = loaded.value.listedPacks;
      if (selectedPack === undefined) throw new Error("configuration selected no pack");
      expect(domain.PackDescription.of(selectedPack).id).toBe("local/one-two");
    }
    expect(Reflect.get(globalThis, "__boundedManagedUnselectedExecuted")).toBeUndefined();
    const outside = project('import { defineConfig, definePack, packIdsFor } from "bounded/domain";\nimport { version } from "plain-helper";\nexport default defineConfig({ packs: [definePack({ id: packIdsFor("local")(version) })] });\n');
    const refused = await load(outside.root, chosen);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toMatch(/plain-helper|direct|bounded add/i);
  });

  test("a store edit after snapshot selection cannot replace copied executable bytes", async () => {
    const selected = node("bounded-selected", "1.0.0", 'globalThis.__boundedManagedSelectedExecuted = "original"; export const word = "original";\n');
    const chosen = graph([selected], { "bounded-selected": selected.id });
    const { root, config } = project('import { defineConfig, definePack, packIdsFor } from "bounded/domain";\nimport { word } from "bounded-selected";\nexport default defineConfig({ packs: [definePack({ id: packIdsFor("local")(word) })] });\n');
    const storeFile = join(root, "store", selected.id, "package", "dist", "index.js");
    mkdirSync(join(root, "store", selected.id, "package", "dist"), { recursive: true });
    const capturedBytes = selected.files["dist/index.js"];
    if (capturedBytes === undefined) throw new Error("selected fixture has no built module");
    writeFileSync(storeFile, capturedBytes);
    selected.files["dist/index.js"] = Uint8Array.from(readFileSync(storeFile));
    const oldBytes = Uint8Array.from(capturedBytes);
    writeFileSync(storeFile, 'globalThis.__boundedManagedSelectedExecuted = "tampered"; export const word = "tampered";\n');
    expect(readFileSync(storeFile, "utf8")).toContain("tampered");
    expect(selected.files["dist/index.js"]).toEqual(oldBytes);
    const loaded = await standaloneManagedConfigSource((file, projectRoot) => buildStandaloneConfigModule(file, projectRoot, chosen)).load(root);
    expect(loaded.ok).toBe(true);
    expect(Reflect.get(globalThis, "__boundedManagedSelectedExecuted")).toBe("original");
    expect(config).toEndWith("bounded.config.ts");
  });

  test("an unlisted transitive pack whose descriptor differs from its locked catalogue is refused", async () => {
    const child = domain.definePack({ id: domain.packIdsFor("bounded-example")("child"), dependsOn: [domain.corePack] });
    const parent = domain.definePack({ id: domain.packIdsFor("bounded-example")("parent"), dependsOn: [child] });
    const selected = node("bounded-example", "1.0.0", 'import { definePack, packIdsFor, corePack } from "bounded/domain";\nexport const childPack = definePack({ id: packIdsFor("bounded-example")("child"), dependsOn: [corePack] });\nexport const parentPack = definePack({ id: packIdsFor("bounded-example")("parent"), dependsOn: [childPack] });\n');
    selected.catalogue = { packs: [cataloguePack(parent, "bounded-example", "parentPack"),
      { ...cataloguePack(child, "bounded-example", "childPack"), dependsOn: [] }] };
    const { root } = project('import { defineConfig } from "bounded/domain";\nimport { parentPack } from "bounded-example";\nexport default defineConfig({ packs: [parentPack] });\n');
    const loaded = await load(root, graph([selected], { "bounded-example": selected.id }));
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error).toContain("bounded-example/child");
      expect(loaded.error).toMatch(/catalogue|descriptor/i);
    }
  });

  test("a selected pack must come from its locked import path and export name", async () => {
    const published = domain.definePack({ id: domain.packIdsFor("bounded-example")("selected"), dependsOn: [domain.corePack] });
    const selected = node("bounded-example", "1.0.0", 'import { definePack, packIdsFor, corePack } from "bounded/domain";\nexport const renamedPack = definePack({ id: packIdsFor("bounded-example")("selected"), dependsOn: [corePack] });\n');
    selected.catalogue = { packs: [cataloguePack(published, "bounded-example", "expectedPack")] };
    const { root } = project('import { defineConfig } from "bounded/domain";\nimport { renamedPack } from "bounded-example";\nexport default defineConfig({ packs: [renamedPack] });\n');
    const loaded = await load(root, graph([selected], { "bounded-example": selected.id }));
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error).toMatch(/importPath|exportName|catalogue/i);
  });

  test("a journal appearing after capture refuses before module execution", async () => {
    const selected = node("bounded-example", "1.0.0", 'globalThis.__boundedManagedSelectedExecuted = true; export const word = "blocked";\n');
    const chosen = graph([selected], { "bounded-example": selected.id });
    chosen.recheckBoundary = async () => ({ ok: false, error: "projection journal pending" });
    const { root } = project('import { defineConfig, definePack, packIdsFor } from "bounded/domain";\nimport { word } from "bounded-example";\nexport default defineConfig({ packs: [definePack({ id: packIdsFor("local")(word) })] });\n');
    const loaded = await load(root, chosen);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error).toMatch(/journal/);
    expect(Reflect.get(globalThis, "__boundedManagedSelectedExecuted")).toBeUndefined();
  });
});
