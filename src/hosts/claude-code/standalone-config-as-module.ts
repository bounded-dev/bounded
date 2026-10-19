import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { extname, join, posix, sep } from "node:path";
import { packageExportsResolve } from "bounded/adapters";
import { FileSystemProjectConfigSource } from "bounded/adapters";
import type { ProjectConfigSource } from "bounded/application";
import { PackDescription, type Config as ProjectConfig, type BasePack } from "bounded/domain";
import ts from "typescript";

type RuntimeExports = Readonly<Record<string, Readonly<Record<string, unknown>>>>;
type Checked = { readonly ok: true; readonly value: undefined } | { readonly ok: false; readonly error: string };
interface ManagedNode {
  readonly id: string;
  readonly name: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly exports: unknown;
  readonly files: Readonly<Record<string, Uint8Array>>;
  readonly catalogue: null | { readonly packs: readonly { readonly id: string; readonly importPath: string; readonly exportName: string;
    readonly dependsOn: readonly string[]; readonly contributesTo: readonly string[];
    readonly points: readonly { readonly id: string; readonly key: string; readonly description: string }[];
    readonly ports: readonly { readonly id: string; readonly key: string }[];
    readonly optionalPorts?: readonly { readonly id: string; readonly key: string }[] }[] };
}
interface ManagedGraph {
  readonly roots: Readonly<Record<string, string>>;
  readonly nodes: Readonly<Record<string, ManagedNode>>;
  readonly recheckBoundary: () => Promise<Checked>;
}
const BOUNDED_EXPORTS = "__boundedStandaloneRuntimeExports";
const isInside = (root: string, path: string): boolean => path.startsWith(`${root}${sep}`);
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? `${parts[0]}/${parts[1] ?? ""}` : (parts[0] ?? "");
}
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
function projectSource(path: string, capturedSources: Map<string, string>): string {
  const source = readFileSync(path, "utf8");
  capturedSources.set(path, digest(new TextEncoder().encode(source)));
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : path.endsWith(".jsx") ? ts.ScriptKind.JSX : path.endsWith(".json") ? ts.ScriptKind.JSON : ts.ScriptKind.TS);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && (node.arguments.length !== 1 || node.arguments[0] === undefined || !ts.isStringLiteral(node.arguments[0])))
      throw new Error(`${path} uses a nonliteral dynamic import; name the pinned module explicitly`);
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require")
      throw new Error(`${path} calls require; use static ESM imports from the verified graph`);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return source;
}
const capturedConfigs = new Map<string, { graph: ManagedGraph; token: string }>();
function discardCapturedConfig(modulePath: string): void {
  const captured = capturedConfigs.get(modulePath);
  capturedConfigs.delete(modulePath);
  if (captured !== undefined) Reflect.deleteProperty(globalThis, captured.token);
}

/** The host validates the loaded snapshot before handing it to composition. */
export function standaloneManagedConfigSource(loadModule: (file: string, root: string) => Promise<string>): ProjectConfigSource {
  return { async load(projectRoot) {
    let builtModulePath: string | undefined;
    const source = new FileSystemProjectConfigSource(async (file, root) => {
      builtModulePath = await loadModule(file, root);
      return builtModulePath;
    });
    const loaded = await source.load(projectRoot);
    if (!loaded.ok || builtModulePath === undefined) {
      if (builtModulePath !== undefined) discardCapturedConfig(builtModulePath);
      return loaded;
    }
    const mismatch = validateStandaloneManagedConfig(builtModulePath, loaded.value);
    return mismatch === undefined ? loaded : { ok: false, error: mismatch };
  } };
}

/** Validate every selected pack after the core config source has imported the built module. */
export function validateStandaloneManagedConfig(modulePath: string, config: ProjectConfig): string | undefined {
  const captured = capturedConfigs.get(modulePath);
  if (captured === undefined) return undefined;
  capturedConfigs.delete(modulePath);
  const { graph, token } = captured;
  const registered: unknown = Reflect.get(globalThis, token);
  Reflect.deleteProperty(globalThis, token);
  const namespaces = registered instanceof Map ? registered : new Map<string, Record<string, unknown>>();
  const selected: BasePack[] = [...config.listedPacks];
  const seen = new Set<unknown>();
  for (let index = 0; index < selected.length; index++) {
    const loaded = selected[index];
    if (loaded === undefined) continue;
    if (seen.has(loaded)) continue;
    seen.add(loaded);
    selected.push(...loaded.dependsOn);
    const runtime = PackDescription.of(loaded);
    const candidates = Object.values(graph.nodes).flatMap((node) => (node.catalogue?.packs ?? [])
      .filter((pack) => pack.id === runtime.id).map((pack) => ({ node, pack })));
    if (candidates.length === 0) {
      const owner = Object.values(graph.nodes).find((node) => runtime.id.startsWith(`${node.name}/`) && node.catalogue !== null);
      if (owner !== undefined) return `Selected pack ${runtime.id} is absent from ${owner.name}'s locked catalogue; re-add ${owner.name}`;
      continue;
    }
    const candidate = candidates.find(({ node, pack }) => namespaces.get(`${node.id}|${pack.importPath}`)?.[pack.exportName] === loaded);
    if (candidate === undefined) return `Selected pack ${runtime.id} did not come from its locked catalogue importPath and exportName; import the published pack export`;
    const expected = candidate.pack;
    const actual = { id: runtime.id, dependsOn: runtime.dependsOn, contributesTo: runtime.contributesTo,
      points: runtime.points.map(({ id, key, description }) => ({ id, key, description })),
      ports: runtime.ports.map(({ id, key }) => ({ id, key })),
      optionalPorts: runtime.optionalPorts.map(({ id, key }) => ({ id, key })) };
    const locked = { id: expected.id, dependsOn: expected.dependsOn, contributesTo: expected.contributesTo,
      points: expected.points.map(({ id, key, description }) => ({ id, key, description })),
      ports: expected.ports.map(({ id, key }) => ({ id, key })),
      optionalPorts: (expected.optionalPorts ?? []).map(({ id, key }) => ({ id, key })) };
    if (JSON.stringify(actual) !== JSON.stringify(locked)) return `Selected pack ${runtime.id} runtime descriptor differs from its locked catalogue; re-add its package`;
  }
  return undefined;
}

/** Build from one verified graph and the executable's singleton Bounded exports. */
export async function buildStandaloneConfigModule(configFile: string, projectRoot: string, suppliedGraph?: ManagedGraph): Promise<string> {
  const exports: unknown = Reflect.get(globalThis, BOUNDED_EXPORTS);
  if ((typeof exports !== "object" || exports === null) && suppliedGraph === undefined) throw new Error("the standalone runtime exports are unavailable");
  const runtimeExports: RuntimeExports = typeof exports === "object" && exports !== null ? exports as RuntimeExports : {};
  const home = realpathSync(projectRoot);
  const graphLoader: unknown = Reflect.get(globalThis, "__boundedStandaloneManagedGraphLoader");
  const graph: ManagedGraph | undefined = suppliedGraph ?? (typeof graphLoader === "function"
    ? await Reflect.apply(graphLoader, undefined, [projectRoot]) as ManagedGraph | undefined : undefined);
  const outputDirectory = mkdtempSync(join(tmpdir(), "bounded-project-config-"));
  chmodSync(outputDirectory, 0o700);
  process.once("exit", () => rmSync(outputDirectory, { recursive: true, force: true }));
  const token = graph === undefined ? undefined : `__boundedManagedExports_${crypto.randomUUID().replaceAll("-", "")}`;
  if (token !== undefined) Reflect.set(globalThis, token, new Map<string, Record<string, unknown>>());
  let unavailableImport: string | undefined;
  const managedFiles = new Map<string, { id: string; file: string; importPath?: string }>();
  const capturedSources = new Map<string, string>();
  let nextManaged = 0;
  const managedPath = (id: string, file: string, importPath?: string): string => {
    const key = `verified-managed-${nextManaged++}`;
    managedFiles.set(key, { id, file, ...(importPath === undefined ? {} : { importPath }) });
    return key;
  };
  const resolveExport = (id: string, specifier: string): string => {
    const node = graph?.nodes[id];
    if (node === undefined) throw new Error(`Managed dependency ${id} is absent from the verified graph; re-add its parent`);
    const name = packageName(specifier);
    const suffix = specifier.slice(name.length);
    const exportPath = suffix === "" ? "." : `.${suffix}`;
    const resolution = packageExportsResolve(node.exports, exportPath);
    if (!resolution.listed || resolution.target === undefined || !resolution.target.startsWith("./"))
      throw new Error(`${node.name} has no Node import export ${exportPath}; choose a published subpath`);
    const file = resolution.target.slice(2);
    if (!/\.(?:m?js|cjs)$/.test(file) || node.files[file] === undefined)
      throw new Error(`${node.name} export ${exportPath} has no verified built JavaScript; re-add ${node.name}`);
    const isCatalogueImport = node.catalogue?.packs.some((pack) => pack.importPath === specifier) ?? false;
    return managedPath(id, file, isCatalogueImport ? specifier : undefined);
  };
  try {
    const built = await Bun.build({
      entrypoints: [configFile], outdir: outputDirectory, target: "bun", format: "esm", allowUnresolved: [],
      plugins: [{ name: "bounded-standalone-project-modules", setup(build) {
        build.onResolve({ filter: /^bounded-managed-self:/ }, ({ path }) => ({ path: path.slice("bounded-managed-self:".length), namespace: "bounded-managed" }));
        build.onResolve({ filter: /^[^./]/ }, ({ path, importer, namespace }) => {
          if (path.startsWith("node:") || (namespace === "file" && path.startsWith("bun:"))) return { path, external: true };
          if (Object.hasOwn(runtimeExports, path)) return { path, namespace: "bounded-standalone-runtime" };
          const name = packageName(path);
          const importerNode = managedFiles.get(importer)?.id;
          const id = importerNode === undefined ? graph?.roots[name] : graph?.nodes[importerNode]?.dependencies[name];
          if (id !== undefined) {
            const resolved = resolveExport(id, path);
            return { path: resolved, namespace: "bounded-managed" };
          }
          unavailableImport = `import '${path}' is not available to ${importerNode ?? "this project"}: use a public bounded export or add and pin the package with bounded add ${name}@version`;
          throw new Error(unavailableImport);
        });
        build.onResolve({ filter: /^\.\.?\// }, ({ path, importer }) => {
          const parent = managedFiles.get(importer);
          if (parent === undefined) return;
          const file = posix.normalize(posix.join(posix.dirname(parent.file), path));
          if (file === ".." || file.startsWith("../") || file.startsWith("/") || graph?.nodes[parent.id]?.files[file] === undefined)
            throw new Error(`${parent.id} imports ${path} outside its verified package; bundle that file before publishing`);
          return { path: managedPath(parent.id, file), namespace: "bounded-managed" };
        });
        build.onLoad({ filter: /.*/, namespace: "bounded-managed" }, ({ path }) => {
          const selected = managedFiles.get(path);
          const bytes = selected === undefined ? undefined : graph?.nodes[selected.id]?.files[selected.file];
          if (selected === undefined || bytes === undefined) throw new Error(`Managed module ${path} is missing from the verified snapshot`);
          const extension = extname(selected.file);
          const loader = extension === ".json" ? "json" : extension === ".js" || extension === ".mjs" || extension === ".cjs" ? "js" : undefined;
          if (loader === undefined) throw new Error(`${selected.id}/${selected.file} is not runnable built JavaScript`);
          if (selected.importPath !== undefined && token === undefined) throw new Error("managed catalogue export has no capture token");
          const registration = selected.importPath === undefined ? "" :
            `\nimport * as __boundedOwnExports from ${JSON.stringify(`bounded-managed-self:${path}`)};\n` +
            `globalThis[${JSON.stringify(token)}].set(${JSON.stringify(`${selected.id}|${selected.importPath}`)}, __boundedOwnExports);\n`;
          return { contents: registration === "" ? bytes : `${new TextDecoder().decode(bytes)}${registration}`, loader };
        });
        build.onLoad({ filter: /.*/, namespace: "bounded-standalone-runtime" }, ({ path }) => ({
          contents: Object.keys(runtimeExports[path] ?? {}).map((name) => `export const ${name} = globalThis.${BOUNDED_EXPORTS}[${JSON.stringify(path)}][${JSON.stringify(name)}];`).join("\n"), loader: "js",
        }));
        build.onLoad({ filter: /.*/, namespace: "file" }, ({ path }) => {
          const real = realpathSync(path);
          if (!isInside(home, real)) {
            unavailableImport = `import '${path}' resolves outside ${projectRoot}: project modules must live in the project`;
            throw new Error(unavailableImport);
          }
          const extension = extname(path);
          const loader = extension === ".ts" || extension === ".mts" || extension === ".cts" ? "ts" : extension === ".tsx" ? "tsx" : extension === ".jsx" ? "jsx" : extension === ".json" ? "json" : extension === ".js" || extension === ".mjs" || extension === ".cjs" ? "js" : undefined;
          if (loader === undefined) throw new Error(`import '${path}' uses an unsupported project module type`);
          return { contents: projectSource(real, capturedSources), loader };
        });
      } }],
    });
    if (!built.success) throw new Error(unavailableImport ?? built.logs.map((log) => JSON.stringify(log)).join("; "));
    const entry = built.outputs.find((output) => output.kind === "entry-point");
    if (entry === undefined) throw new Error("the standalone configuration build produced no entry module");
    for (const [path, expected] of capturedSources) {
      if (digest(readFileSync(path)) !== expected) throw new Error(`Project module ${path} changed during snapshot capture; retry after editing it`);
    }
    if (graph !== undefined) {
      const boundary = await graph.recheckBoundary();
      if (!boundary.ok) throw new Error(boundary.error);
      if (token === undefined) throw new Error("managed graph has no capture token");
      capturedConfigs.set(entry.path, { graph, token });
    }
    return entry.path;
  } catch (thrown) {
    if (token !== undefined) Reflect.deleteProperty(globalThis, token);
    throw new Error(unavailableImport ?? errorText(thrown));
  }
}
