import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { builtinModules } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };
type FileRecord = { readonly size: number; readonly mode: number; readonly sha256: string };
type DirectoryRecord = { readonly mode: number; readonly entriesSha256: string };
type PackageIdentity = { readonly name: string; readonly version: string };
export interface NpmClosureSnapshot {
  readonly schema: "bounded-npm-closure/1";
  readonly version: "3.3.0";
  readonly files: Record<string, FileRecord>;
  readonly directories: Record<string, DirectoryRecord>;
  readonly packages: Record<string, PackageIdentity>;
}

const OLD_VERSION = "3.3.0";
const DEFAULT_CONFIG_SHA256 = "d7e3f3db5c8b2490f353f24ba7288e7678a030b6862baf66abd2aed619f016a7";
const PUBLISHED_BOUNDED_TREE_SHA256 = "0cd833b94ad72156d3472ef371e28a46fa82b1ed2dc2d36eb6ee19b2bae57ce1";
const PUBLISHED_ADAPTER_SHA256 = "c49025460a51e597fdf2d7d98128ca612f19a88d678e2afe4a4ce70eec0f4146";
const PUBLISHED_DEPENDENCY_TREE_SHA256: Record<string, string> = {
  "@vscode/tree-sitter-wasm": "6b111365a833a78096e29a73c2970688172ff62ca581d84239099169a5874403",
  picomatch: "f8e17bfacd2947be51746aa5835467691e6dab0ce424d7414af416558453f91c",
  zod: "75e4a86a1c16abaf9fb9ac9931f5122623ac3f1dfa67a90c19dcc7abbbe0acec",
};
const MAX_FILES = 20_000;
const MAX_BYTES = 512 * 1024 * 1024;
const PINNED_DEPENDENCIES: Record<string, string> = {
  "@vscode/tree-sitter-wasm": "0.3.1",
  picomatch: "4.0.7",
  zod: "4.6.4",
};
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
function fail(message: string): never { throw new Error(message); }
const normal = (path: string): string => path.split(sep).join("/");
const safeRel = (root: string, path: string): string => {
  const rel = relative(root, path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail(`${path} escapes the project`);
  return normal(rel);
};
const own = (record: Record<string, unknown>, key: string): unknown => Object.hasOwn(record, key) ? record[key] : undefined;
function regularFile(path: string): Uint8Array {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${path} is not a regular unlinked file`);
  if (stat.size > MAX_BYTES) fail(`${path} is too large to inventory`);
  return readFileSync(path);
}
function json(path: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(Buffer.from(regularFile(path)).toString("utf8")); }
  catch { return fail(`${path} is not readable JSON`); }
  if (!isRecord(value)) fail(`${path} must contain a JSON object`);
  return value;
}
function stringMap(value: unknown, where: string): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) fail(`${where} must be an object of exact versions`);
  const output: Record<string, string> = {};
  for (const [name, version] of Object.entries(value)) {
    if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(version)) fail(`${where} has an unsupported version for ${name}`);
    output[name] = version;
  }
  return output;
}
function noOptionalOrPeer(manifest: Record<string, unknown>, label: string): void {
  for (const name of ["optionalDependencies", "peerDependencies", "bundledDependencies", "bundleDependencies"]) {
    if (manifest[name] !== undefined && (!isRecord(manifest[name]) || Object.keys(manifest[name]).length > 0)) fail(`${label} declares ${name}; automatic npm rollback cannot prove it`);
  }
}
function sameMap(actual: Record<string, string>, expected: Record<string, string>, label: string): void {
  if (JSON.stringify(Object.entries(actual).sort()) !== JSON.stringify(Object.entries(expected).sort())) fail(`${label} does not match the installed dependency graph`);
}
function packageNameOf(specifier: string): string {
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    if (parts.length < 2 || !parts[1]) fail(`invalid scoped package import ${specifier}`);
    return `${parts[0]}/${parts[1]}`;
  }
  const [name] = specifier.split("/");
  if (!name) fail(`invalid package import ${specifier}`);
  return name;
}
function assertNoLinkFrom(root: string, path: string): void {
  safeRel(root, path);
  let current = root;
  for (const part of relative(root, path).split(sep)) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) fail(`${current} is linked; automatic npm rollback requires real installed files`);
  }
}
function nearestInstalledPackage(root: string, issuerPackage: string, name: string): string {
  let current = issuerPackage;
  while (true) {
    if (basename(current) !== "node_modules") {
      const candidate = join(current, "node_modules", name);
      try {
        assertNoLinkFrom(root, candidate);
        if (lstatSync(candidate).isDirectory()) return candidate;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current || !parent.startsWith(`${root}${sep}`) && parent !== root) break;
    current = parent;
  }
  fail(`${name} is a declared dependency but no installed package resolves from ${normal(relative(root, issuerPackage))}`);
}
function inventoryTree(root: string, tree: string, files: Record<string, FileRecord>, directories: Record<string, DirectoryRecord>, budget: { count: number; bytes: number }): void {
  const visit = (path: string): void => {
    assertNoLinkFrom(root, path);
    const stat = lstatSync(path);
    const rel = safeRel(root, path);
    if (!stat.isDirectory()) fail(`${rel} is not an installed directory`);
    const entries = readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    const listing: string[] = [];
    for (const entry of entries) {
      const child = join(path, entry.name);
      const childRel = safeRel(root, child);
      if (entry.isSymbolicLink()) fail(`${childRel} is linked`);
      if (entry.isDirectory()) { listing.push(`${entry.name}:directory`); visit(child); }
      else if (entry.isFile()) {
        listing.push(`${entry.name}:file`);
        const bytes = regularFile(child);
        budget.count++;
        budget.bytes += bytes.byteLength;
        if (budget.count > MAX_FILES || budget.bytes > MAX_BYTES) fail(`installed npm closure exceeds inventory bounds at ${childRel}`);
        files[childRel] = { size: bytes.byteLength, mode: lstatSync(child).mode & 0o777, sha256: sha256(bytes) };
      } else fail(`${childRel} is not a regular file or directory`);
    }
    directories[rel] = { mode: stat.mode & 0o777, entriesSha256: sha256(listing.join("\0")) };
  };
  visit(tree);
}
function installedTreeDigest(root: string, packageRoot: string, files: Record<string, FileRecord>): string {
  const prefix = `${normal(relative(root, packageRoot))}/`;
  const hash = createHash("sha256");
  for (const path of Object.keys(files).filter((path) => path.startsWith(prefix)).sort()) {
    hash.update(path.slice(prefix.length));
    hash.update("\0");
    hash.update(files[path]?.sha256 ?? "");
    hash.update("\0");
  }
  return hash.digest("hex");
}
function recordStandaloneFile(root: string, path: string, files: Record<string, FileRecord>): void {
  assertNoLinkFrom(root, path);
  const bytes = regularFile(path);
  files[safeRel(root, path)] = { size: bytes.byteLength, mode: lstatSync(path).mode & 0o777, sha256: sha256(bytes) };
}
function selectedExport(target: unknown, condition: "import" | "require", label: string): string {
  if (typeof target === "string") return target;
  if (!isRecord(target)) fail(`${label} has an unsupported package export`);
  for (const [key, value] of Object.entries(target)) {
    if (key === condition || key === "node" || key === "default") return selectedExport(value, condition, label);
  }
  fail(`${label} does not have a ${condition} or default package export`);
}
function packageManifest(root: string): Record<string, unknown> { return json(join(root, "package.json")); }
function fileTarget(path: string, condition: "import" | "require", root: string): string {
  const options = condition === "require" ? [path, `${path}.js`, `${path}.cjs`, `${path}.json`, join(path, "index.js"), join(path, "index.cjs")] : [path];
  for (const option of options) {
    if (!option.startsWith(`${root}${sep}`)) continue;
    try {
      assertNoLinkFrom(root, option);
      if (lstatSync(option).isFile()) return option;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  fail(`${normal(relative(root, path))} cannot be resolved as an installed ${condition} module`);
}
function resolveModule(root: string, issuer: string, specifier: string, condition: "import" | "require", packageRoots: Set<string>): string | null {
  if (builtins.has(specifier)) return null;
  if (specifier.startsWith("#") || isAbsolute(specifier) || specifier.startsWith("file:")) fail(`${specifier} is an unsupported old-runtime import`);
  if (specifier.startsWith(".")) {
    const path = fileTarget(resolve(dirname(issuer), specifier), condition, root);
    if (!packageRoots.has(path) && ![...packageRoots].some((base) => path.startsWith(`${base}${sep}`))) fail(`${specifier} resolves outside the proven npm closure`);
    return path;
  }
  const name = packageNameOf(specifier);
  const issuerRoot = [...packageRoots].filter((base) => issuer === base || issuer.startsWith(`${base}${sep}`)).sort((a, b) => b.length - a.length)[0];
  if (issuerRoot === undefined) fail(`${issuer} is outside the proven npm closure`);
  const issuerManifest = packageManifest(issuerRoot);
  const targetRoot = issuerManifest.name === name ? issuerRoot : nearestInstalledPackage(root, issuerRoot, name);
  if (!packageRoots.has(targetRoot)) fail(`${specifier} resolves to a package outside the declared npm closure`);
  const manifest = packageManifest(targetRoot);
  const subpath = specifier === name ? "." : `./${specifier.slice(name.length + 1)}`;
  let target: string;
  if (manifest.exports !== undefined) {
    const exports = manifest.exports;
    if (typeof exports === "string") {
      if (subpath !== ".") fail(`${specifier} is not exported`);
      target = exports;
    } else if (isRecord(exports)) {
      const keys = Object.keys(exports);
      const keyed = keys.some((key) => key.startsWith("."));
      if (keyed && keys.some((key) => !key.startsWith("."))) fail(`${specifier} mixes subpath and condition exports`);
      if (keyed) {
        const selected = own(exports, subpath);
        if (selected === undefined) fail(`${specifier} is not exported`);
        target = selectedExport(selected, condition, specifier);
      } else {
        if (subpath !== ".") fail(`${specifier} is not exported`);
        target = selectedExport(exports, condition, specifier);
      }
    } else return fail(`${specifier} has unsupported exports`);
  } else {
    target = subpath === "." ? typeof manifest.main === "string" ? manifest.main : "index.js" : subpath;
  }
  if (manifest.exports !== undefined && !target.startsWith("./")) fail(`${specifier} export must start with ./`);
  const absolute = resolve(targetRoot, target);
  if (!absolute.startsWith(`${targetRoot}${sep}`)) fail(`${specifier} export escapes its package`);
  if (absolute.endsWith(".node")) fail(`${specifier} resolves to a native addon`);
  return fileTarget(absolute, condition, root);
}
function sourceImports(root: string, path: string, bytes: Uint8Array): { specifier: string; condition: "import" | "require" }[] {
  const source = Buffer.from(bytes).toString("utf8");
  const kind = path.endsWith(".ts") ? ts.ScriptKind.TS : path.endsWith(".cjs") ? ts.ScriptKind.JS : ts.ScriptKind.JS;
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
  if ((parsed as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length > 0) fail(`${normal(relative(root, path))} has unparseable JavaScript`);
  const imports: { specifier: string; condition: "import" | "require" }[] = [];
  const knownAdapter = normal(relative(root, path)) === "node_modules/bounded/dist/core/adapters/out/index.js" && sha256(bytes) === PUBLISHED_ADAPTER_SHA256;
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (specifier !== undefined) {
        if (!ts.isStringLiteralLike(specifier)) fail(`${path} has a nonliteral module specifier`);
        imports.push({ specifier: specifier.text, condition: "import" });
      }
    }
    if (ts.isCallExpression(node)) {
      const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const directRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      const requireResolve = ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "require" && node.expression.name.text === "resolve";
      if (dynamicImport || directRequire || requireResolve) {
        const [argument] = node.arguments;
        if (argument === undefined || !ts.isStringLiteralLike(argument)) {
          const callsite = node.getText(parsed);
          const knownConfigLoader = callsite === "import(`${file}?v=${statSync(file).mtimeMs}`)";
          const knownCliInstaller = callsite === "import(pathToFileURL(join(packageDir, target)).href)";
          if (!(knownAdapter && (knownConfigLoader || knownCliInstaller))) fail(`${normal(relative(root, path))} has an unprovable computed import or require: ${callsite.slice(0, 100)}`);
        } else imports.push({ specifier: argument.text, condition: directRequire || requireResolve ? "require" : "import" });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return imports;
}
function verifyModuleGraph(root: string, packageRoots: Set<string>): void {
  const entrypoints = [
    join(root, "node_modules", "bounded", "dist", "hosts", "claude-code", "hook.js"),
    join(root, "node_modules", "bounded", "dist", "hosts", "pi", "index.js"),
    join(root, "bounded.config.ts"),
  ];
  const moduleRoots = new Set([...packageRoots, root]);
  const visited = new Set<string>();
  const queue = [...entrypoints];
  while (queue.length > 0) {
    const path = queue.shift();
    if (path === undefined || visited.has(path)) continue;
    visited.add(path);
    const extension = path.slice(path.lastIndexOf("."));
    if (![".js", ".cjs", ".mjs", ".ts"].includes(extension)) continue;
    for (const imported of sourceImports(root, path, regularFile(path))) {
      const resolved = resolveModule(root, path, imported.specifier, imported.condition, moduleRoots);
      if (resolved !== null && !visited.has(resolved)) queue.push(resolved);
    }
  }
  // The published Pi loader contains a literal `import("bounded/hosts/pi")`.
  const pi = resolveModule(root, join(root, ".pi", "extensions", "bounded", "index.ts"), "bounded/hosts/pi", "import", moduleRoots);
  if (pi !== join(root, "node_modules", "bounded", "dist", "hosts", "pi", "index.js")) fail("published Pi loader does not resolve inside the inventoried Bounded package");
}
function capture(rootInput: string): NpmClosureSnapshot {
  const submittedRoot = resolve(rootInput);
  if (lstatSync(submittedRoot).isSymbolicLink()) fail("project root is linked");
  const root = realpathSync(submittedRoot);
  if (!lstatSync(root).isDirectory()) fail("project root is not an unlinked directory");
  const manifestPath = join(root, "package.json");
  const lockPath = join(root, "package-lock.json");
  const configPath = join(root, "bounded.config.ts");
  for (const name of ["bun.lock", "bun.lockb", "pnpm-lock.yaml", "yarn.lock", "npm-shrinkwrap.json", "bounded.config.js", "bounded.config.mjs"]) {
    try { lstatSync(join(root, name)); fail(`${name} is unsupported alongside published npm 3.3.0 default config`); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  }
  const rootManifest = json(manifestPath);
  noOptionalOrPeer(rootManifest, "project package.json");
  sameMap(stringMap(rootManifest.dependencies, "project dependencies"), { bounded: OLD_VERSION }, "project dependencies");
  sameMap(stringMap(rootManifest.devDependencies, "project devDependencies"), {}, "project devDependencies");
  const configBytes = regularFile(configPath);
  if (sha256(configBytes) !== DEFAULT_CONFIG_SHA256) fail("bounded.config.ts differs from the published 3.3.0 default; restore that config or migrate packs manually");
  const lock = json(lockPath);
  if (lock.lockfileVersion !== 3 || !isRecord(lock.packages)) fail("package-lock.json is not a supported npm v3 lock; reinstall or migrate manually");
  const lockPackages = lock.packages;
  const rootLock = lockPackages[""];
  if (!isRecord(rootLock)) fail("package-lock.json has no root package record");
  sameMap(stringMap(rootLock.dependencies, "lock root dependencies"), { bounded: OLD_VERSION }, "lock root dependencies");
  sameMap(stringMap(rootLock.devDependencies, "lock root devDependencies"), {}, "lock root devDependencies");
  const files: Record<string, FileRecord> = {};
  const directories: Record<string, DirectoryRecord> = {};
  const packages: Record<string, PackageIdentity> = {};
  const budget = { count: 0, bytes: 0 };
  for (const path of [manifestPath, lockPath, configPath]) recordStandaloneFile(root, path, files);
  const packageRoots = new Set<string>();
  const visitPackage = (packageRoot: string, expectedName: string, expectedVersion: string): void => {
    if (packageRoots.has(packageRoot)) return;
    assertNoLinkFrom(root, packageRoot);
    if (!lstatSync(packageRoot).isDirectory()) fail(`${expectedName} is not installed as a directory`);
    const manifest = packageManifest(packageRoot);
    const location = safeRel(root, packageRoot);
    if (manifest.name !== expectedName || manifest.version !== expectedVersion) fail(`${location} identity/version does not match ${expectedName}@${expectedVersion}`);
    noOptionalOrPeer(manifest, location);
    const dependencyVersions = stringMap(manifest.dependencies, `${location} dependencies`);
    const locked = lockPackages[location];
    if (!isRecord(locked) || locked.version !== expectedVersion || locked.link === true || typeof locked.integrity !== "string" || !locked.integrity.startsWith("sha512-")) fail(`${location} does not match a regular pinned npm lock entry`);
    sameMap(stringMap(locked.dependencies, `${location} lock dependencies`), dependencyVersions, `${location} lock dependencies`);
    noOptionalOrPeer(locked, `${location} lock entry`);
    packageRoots.add(packageRoot);
    packages[location] = { name: expectedName, version: expectedVersion };
    inventoryTree(root, packageRoot, files, directories, budget);
    for (const [name, version] of Object.entries(dependencyVersions)) visitPackage(nearestInstalledPackage(root, packageRoot, name), name, version);
  };
  const boundedRoot = join(root, "node_modules", "bounded");
  visitPackage(boundedRoot, "bounded", OLD_VERSION);
  const boundedManifest = packageManifest(boundedRoot);
  sameMap(stringMap(boundedManifest.dependencies, "published bounded dependencies"), PINNED_DEPENDENCIES, "published bounded dependencies");
  if (installedTreeDigest(root, boundedRoot, files) !== PUBLISHED_BOUNDED_TREE_SHA256) fail("node_modules/bounded differs from the published 3.3.0 package; reinstall it before automatic rollback");
  for (const name of Object.keys(PINNED_DEPENDENCIES)) {
    const dependencyRoot = nearestInstalledPackage(root, boundedRoot, name);
    if (installedTreeDigest(root, dependencyRoot, files) !== PUBLISHED_DEPENDENCY_TREE_SHA256[name]) fail(`${name} differs from its published installed package; reinstall it before automatic rollback`);
  }
  const declaredLockLocations = Object.keys(lockPackages).filter((key) => key !== "").sort();
  if (JSON.stringify(declaredLockLocations) !== JSON.stringify(Object.keys(packages).sort())) fail("package-lock.json contains installed packages outside the proven runtime closure");
  verifyModuleGraph(root, packageRoots);
  return { schema: "bounded-npm-closure/1", version: OLD_VERSION, files, directories, packages };
}
export function captureInstalledNpmClosure(projectRoot: string): Result<NpmClosureSnapshot> {
  try { return { ok: true, value: capture(projectRoot) }; }
  catch (error) { return { ok: false, error: `Cannot prove the installed published npm runtime: ${error instanceof Error ? error.message : String(error)}` }; }
}
export function reverifyInstalledNpmClosure(projectRoot: string, snapshot: unknown): Result<void> {
  if (!isRecord(snapshot) || snapshot.schema !== "bounded-npm-closure/1" || snapshot.version !== OLD_VERSION || !isRecord(snapshot.files) || !isRecord(snapshot.directories) || !isRecord(snapshot.packages)) return { ok: false, error: "npm rollback closure snapshot is malformed" };
  const current = captureInstalledNpmClosure(projectRoot);
  if (!current.ok) return current;
  const expected = JSON.stringify(current.value);
  if (JSON.stringify(snapshot) !== expected) return { ok: false, error: "installed npm runtime or rollback closure snapshot changed; repair it before restoring old Node hooks" };
  return { ok: true, value: undefined };
}
