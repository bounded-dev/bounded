import { relative } from "node:path";
import { posix } from "node:path";
import ts from "typescript";
import { packageExportsResolve } from "../pack-modules/node-import-export-target.ts";
import type { StandaloneProjectSnapshot } from "./standalone-config-as-module.ts";

export const boundedDeclarationTargets: Readonly<Record<string, string>> = Object.freeze({
  "bounded/domain": "core/domain/index.d.ts",
  "bounded/application": "core/application/index.d.ts",
  "bounded/adapters": "core/adapters/out/index.d.ts",
  "bounded/open-project": "core/composition-root/open-project.d.ts",
  "bounded/prereqs": "packs/prereqs/index.d.ts",
  "bounded/prereqs/adapters": "packs/prereqs/adapters/out/index.d.ts",
  "bounded/protected-paths": "packs/protected-paths/index.d.ts",
  "bounded/protected-paths/adapters": "packs/protected-paths/adapters/out/index.d.ts",
  "bounded/shell-command-reader": "shell-command-reader/index.d.ts",
});

interface TypeEnvironment {
  readonly boundedDeclarations: Readonly<Record<string, Uint8Array>>;
  readonly standardLibraries: Readonly<Record<string, Uint8Array>>;
  readonly externalDeclarations?: Readonly<Record<string, Uint8Array>>;
}
interface TypeCheckResult { readonly ok: boolean; readonly diagnostics: readonly string[] }
const typeConditions = new Set(["types", "import", "node", "module-sync"]);
const decoder = new TextDecoder();

function packageName(specifier: string): string {
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? `${segments[0]}/${segments[1] ?? ""}` : segments[0] ?? "";
}
function extension(path: string): ts.Extension {
  if (path.endsWith(".d.mts")) return ts.Extension.Dmts;
  if (path.endsWith(".d.cts")) return ts.Extension.Dcts;
  if (path.endsWith(".d.ts")) return ts.Extension.Dts;
  if (path.endsWith(".tsx")) return ts.Extension.Tsx;
  if (path.endsWith(".ts") || path.endsWith(".mts") || path.endsWith(".cts")) return ts.Extension.Ts;
  if (path.endsWith(".json")) return ts.Extension.Json;
  return ts.Extension.Js;
}
function candidatePaths(path: string): string[] {
  const candidates: string[] = [];
  if (path.endsWith(".mjs")) candidates.push(`${path.slice(0, -4)}.d.mts`);
  else if (path.endsWith(".cjs")) candidates.push(`${path.slice(0, -4)}.d.cts`);
  else if (path.endsWith(".js")) candidates.push(`${path.slice(0, -3)}.d.ts`);
  candidates.push(path);
  if (!/\.[^/]+$/.test(path)) candidates.push(`${path}.ts`, `${path}.tsx`, `${path}.d.ts`, `${path}.js`, `${path}/index.ts`, `${path}/index.d.ts`);
  return candidates;
}
function moduleDescription(path: string, root: string): string {
  return path.startsWith(`${root}/`) ? relative(root, path) : path.replace(/^\/__bounded_managed__\//, "managed:").replace(/^\/__bounded_types__\//, "bounded:");
}

/** Compile only captured project bytes, verified declarations and bundled standard libraries. */
export async function checkStandaloneProjectSnapshot(snapshot: StandaloneProjectSnapshot, environment: TypeEnvironment): Promise<TypeCheckResult> {
  const files = new Map<string, string>();
  for (const [path, bytes] of Object.entries(snapshot.sourceFiles)) files.set(path, decoder.decode(bytes));
  for (const [path, bytes] of Object.entries(environment.boundedDeclarations)) files.set(`/__bounded_types__/${path}`, decoder.decode(bytes));
  for (const [path, bytes] of Object.entries(environment.standardLibraries)) files.set(`/__bounded_libs__/${path}`, decoder.decode(bytes));
  for (const [path, bytes] of Object.entries(environment.externalDeclarations ?? {})) files.set(`/__external_types__/${path}`, decoder.decode(bytes));
  const managedPaths = new Map<string, { readonly id: string; readonly path: string }>();
  for (const [id, node] of Object.entries(snapshot.managedGraph?.nodes ?? {})) {
    for (const [path, bytes] of Object.entries(node.files)) {
      if (!/\.d\.(?:ts|mts|cts)$/.test(path)) continue;
      const virtual = `/__bounded_managed__/${id}/${path}`;
      files.set(virtual, decoder.decode(bytes));
      managedPaths.set(virtual, { id, path });
    }
  }
  const projectRoot = snapshot.projectRoot;
  const resolveVirtual = (path: string): ts.ResolvedModuleFull | undefined => {
    for (const candidate of candidatePaths(path)) if (files.has(candidate)) return { resolvedFileName: candidate, extension: extension(candidate) };
    return undefined;
  };
  const resolveImport = (specifier: string, containing: string): ts.ResolvedModuleFull | undefined => {
    if (specifier.startsWith(".")) return resolveVirtual(posix.normalize(posix.join(posix.dirname(containing), specifier)));
    if (specifier.startsWith("node:")) return resolveVirtual(`/__external_types__/@types/node/${specifier.slice(5)}.d.ts`);
    if (specifier === "undici-types" || specifier.startsWith("undici-types/")) {
      const subpath = specifier.slice("undici-types".length);
      return resolveVirtual(`/__external_types__/undici-types/${subpath === "" ? "index.d.ts" : `${subpath.slice(1)}.d.ts`}`);
    }
    if (Object.hasOwn(boundedDeclarationTargets, specifier)) return resolveVirtual(`/__bounded_types__/${boundedDeclarationTargets[specifier]}`);
    if (specifier === "bounded" || specifier.startsWith("bounded/")) return undefined;
    if (specifier === "@vscode/tree-sitter-wasm") return resolveVirtual("/__external_types__/@vscode/tree-sitter-wasm/wasm/web-tree-sitter.d.ts");
    const name = packageName(specifier);
    const parent = managedPaths.get(containing);
    const graph = snapshot.managedGraph;
    const id = parent === undefined ? graph?.roots[name] : graph?.nodes[parent.id]?.dependencies[name];
    const node = id === undefined ? undefined : graph?.nodes[id];
    if (node === undefined) return undefined;
    const subpath = specifier.slice(name.length);
    const exportPath = subpath === "" ? "." : `.${subpath}`;
    try {
      const resolved = packageExportsResolve(node.exports, exportPath, typeConditions);
      if (!resolved.listed || resolved.target === undefined || !resolved.target.startsWith("./")) return undefined;
      return resolveVirtual(`/__bounded_managed__/${id}/${resolved.target.slice(2)}`);
    } catch { return undefined; }
  };
  const options: ts.CompilerOptions = {
    strict: true, target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, allowImportingTsExtensions: true,
    allowJs: true, checkJs: false, resolveJsonModule: true, skipLibCheck: false,
    noEmit: true, types: [], lib: ["lib.es2024.full.d.ts"],
  };
  const host: ts.CompilerHost = {
    getSourceFile: (name, languageVersion) => {
      const content = files.get(name);
      return content === undefined ? undefined : ts.createSourceFile(name, content, languageVersion, true);
    },
    getDefaultLibFileName: () => "/__bounded_libs__/lib.es2024.full.d.ts",
    writeFile: () => {}, getCurrentDirectory: () => projectRoot,
    getDirectories: () => [], fileExists: (path) => files.has(path), readFile: (path) => files.get(path),
    directoryExists: (path) => [...files.keys()].some((file) => file.startsWith(`${path}/`)),
    getCanonicalFileName: (path) => path, useCaseSensitiveFileNames: () => true, getNewLine: () => "\n",
    realpath: (path) => path,
    resolveModuleNames: (specifiers, containing) => specifiers.map((specifier) => resolveImport(specifier, containing)),
    resolveTypeReferenceDirectives: (references) => references.map((reference) => {
      const name = typeof reference === "string" ? reference : reference.fileName;
      if (name !== "node" || !files.has("/__external_types__/@types/node/index.d.ts")) return undefined;
      return { resolvedFileName: "/__external_types__/@types/node/index.d.ts", primary: true };
    }),
  };
  const rootNames = [snapshot.configFile];
  if (files.has("/__external_types__/@types/node/index.d.ts")) rootNames.push("/__external_types__/@types/node/index.d.ts");
  const program = ts.createProgram({ rootNames, options, host });
  const reports = ts.getPreEmitDiagnostics(program);
  const diagnostics = reports.filter((report) => report.category === ts.DiagnosticCategory.Error || report.category === ts.DiagnosticCategory.Warning)
    .map((report) => {
      const where = report.file === undefined || report.start === undefined ? "bounded.config.ts" : moduleDescription(report.file.fileName, projectRoot);
      const position = report.file === undefined || report.start === undefined ? { line: 0, character: 0 } : report.file.getLineAndCharacterOfPosition(report.start);
      return `${where}:${position.line + 1}:${position.character + 1} TS${report.code}: ${ts.flattenDiagnosticMessageText(report.messageText, " ")}`;
    });
  return { ok: !reports.some((report) => report.category === ts.DiagnosticCategory.Error), diagnostics };
}
