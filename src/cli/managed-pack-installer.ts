import { createHash, randomUUID } from "node:crypto";
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse, posix, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { parse as parseJavaScript } from "acorn";
import { packageExportsResolve } from "bounded/adapters";
import { PackageCatalog, PackageManifest } from "bounded/domain";
import tar from "tar-stream";
import ts from "typescript";

interface Reply { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: Uint8Array }
interface InstallInput {
  readonly request: string;
  readonly boundedVersion: string;
  readonly boundedExportPaths: readonly string[];
  readonly registryUrl: string;
  readonly projectRoot: string;
  readonly storeRoot: string;
  /** One HTTP response only; the adapter must disable automatic redirects so each hop is checked here. */
  readonly get: (url: string) => Promise<Reply>;
  readonly publishLock?: (path: string, contents: string) => Promise<void>;
  readonly afterExistingLockVerified?: (lockSha256: string) => Promise<void>;
}
interface VerifyInput {
  readonly boundedVersion: string;
  readonly boundedExportPaths: readonly string[];
  readonly projectRoot: string;
  readonly storeRoot: string;
}
type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };
type FileInventory = Readonly<Record<string, { readonly size: number; readonly sha256: string }>>;
interface RegistryVersion {
  readonly name: string;
  readonly version: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly peerDependencies: Readonly<Record<string, string>>;
  readonly dist: { readonly tarball: string; readonly integrity?: string };
}
interface LockNode {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly tarballUrl: string;
  readonly integrity: string | null;
  readonly sha256: string;
  readonly inventorySha256: string;
  readonly dependencies: Readonly<Record<string, string>>;
}
interface CatalogueImport { readonly importPath: string; readonly exportName: string }
interface PackLock {
  readonly schema: "bounded-packs-lock/2";
  readonly boundedVersion: string;
  readonly roots: Readonly<Record<string, string>>;
  readonly nodes: Readonly<Record<string, LockNode>>;
}

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const sameStringMap = (first: Readonly<Record<string, string>>, second: Readonly<Record<string, string>>): boolean => JSON.stringify(Object.entries(first).sort(([a], [b]) => a.localeCompare(b))) === JSON.stringify(Object.entries(second).sort(([a], [b]) => a.localeCompare(b)));
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const refusal = <T>(error: string): Result<T> => ({ ok: false, error });

function exactRequest(request: string): Result<{ name: string; version: string }> {
  const match = request.match(/^(@[a-z0-9._-]+\/[a-z0-9._-]+|[a-z0-9._-]+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/);
  if (match === null || match[1] === undefined || match[2] === undefined) return refusal(`Pack request ${request} must name an exact package version, such as bounded-example@1.0.0`);
  return { ok: true, value: { name: match[1], version: match[2] } };
}

const header = (headers: Readonly<Record<string, string>>, key: string): string | undefined => Object.entries(headers).find(([name]) => name.toLowerCase() === key)?.[1];

async function fetchHttps(url: string, get: InstallInput["get"]): Promise<Result<{ url: string; body: Uint8Array }>> {
  let current = url;
  const visited = new Set<string>();
  for (let hop = 0; hop < 9; hop++) {
    let parsed: URL;
    try { parsed = new URL(current); } catch { return refusal(`Invalid registry URL ${current}`); }
    if (parsed.protocol !== "https:") return refusal(`Registry and tarball requests require HTTPS at every redirect: ${current}`);
    if (visited.has(current)) return refusal(`Registry redirect loop at ${current}`);
    visited.add(current);
    let response: Reply;
    try { response = await get(current); } catch (error) { return refusal(`Cannot fetch ${current}: ${errorText(error)}`); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = header(response.headers, "location");
      if (location === undefined) return refusal(`Registry redirect from ${current} has no location`);
      try { current = new URL(location, current).href; } catch { return refusal(`Registry redirect from ${current} has invalid location ${location}`); }
      continue;
    }
    if (response.status !== 200) return refusal(`Registry request ${current} failed with HTTP ${response.status}`);
    if (response.body.byteLength > MAX_ARCHIVE_BYTES) return refusal(`Registry response ${current} exceeds the size limit`);
    return { ok: true, value: { url: current, body: response.body } };
  }
  return refusal(`Registry request ${url} has too many redirects`);
}

function json(bytes: Uint8Array, what: string): Result<unknown> {
  try { return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) }; }
  catch (error) { return refusal(`${what} is not valid JSON: ${errorText(error)}`); }
}

function stringMap(value: unknown, what: string): Result<Readonly<Record<string, string>>> {
  if (value === undefined) return { ok: true, value: {} };
  if (!record(value) || Object.values(value).some((item) => typeof item !== "string")) return refusal(`${what} must map package names to strings`);
  return { ok: true, value: value as Readonly<Record<string, string>> };
}

async function metadata(name: string, registryUrl: string, get: InstallInput["get"]): Promise<Result<Record<string, RegistryVersion>>> {
  let metadataUrl: string;
  try { metadataUrl = new URL(`${registryUrl.replace(/\/+$/, "")}/${encodeURIComponent(name)}`).href; }
  catch { return refusal(`Invalid registry URL ${registryUrl}`); }
  const response = await fetchHttps(metadataUrl, get);
  if (!response.ok) return response;
  const parsed = json(response.value.body, `${name} registry metadata`);
  if (!parsed.ok) return parsed;
  if (!record(parsed.value) || parsed.value.name !== name || !record(parsed.value.versions)) return refusal(`${name} registry metadata does not name the requested package and versions`);
  const versions: Record<string, RegistryVersion> = {};
  for (const [version, raw] of Object.entries(parsed.value.versions)) {
    if (!record(raw) || raw.name !== name || raw.version !== version || !record(raw.dist) || typeof raw.dist.tarball !== "string") return refusal(`${name}@${version} registry metadata is malformed`);
    const dependencies = stringMap(raw.dependencies, `${name}@${version} dependencies`);
    if (!dependencies.ok) return dependencies;
    const peerDependencies = stringMap(raw.peerDependencies, `${name}@${version} peerDependencies`);
    if (!peerDependencies.ok) return peerDependencies;
    if (raw.dist.integrity !== undefined && typeof raw.dist.integrity !== "string") return refusal(`${name}@${version} registry integrity is malformed`);
    versions[version] = { name, version, dependencies: dependencies.value, peerDependencies: peerDependencies.value,
      dist: { tarball: raw.dist.tarball, ...(raw.dist.integrity === undefined ? {} : { integrity: raw.dist.integrity }) } };
  }
  return { ok: true, value: versions };
}

const windowsReserved = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;
function safeMember(name: string): Result<string> {
  if (!name.startsWith("package/")) return refusal(`Archive path ${name} is outside package/`);
  const relative = name.slice("package/".length).replace(/\/$/, "");
  if (relative === "" || relative.startsWith("/") || relative.includes("\\") || [...relative].some((character) => character === ":" || character.charCodeAt(0) < 32)
    || relative.split("/").some((segment) => segment === "" || segment === "." || segment === ".." || segment.endsWith(".") || segment.endsWith(" ") || windowsReserved.test(segment))) return refusal(`Archive path ${name} is unsafe`);
  return { ok: true, value: relative };
}

async function archiveFiles(archive: Uint8Array): Promise<Result<Readonly<Record<string, Uint8Array>>>> {
  let tarBytes: Buffer;
  try { tarBytes = gunzipSync(Buffer.from(archive), { maxOutputLength: MAX_UNPACKED_BYTES }); }
  catch (error) { return refusal(`Cannot unpack tarball within size limit: ${errorText(error)}`); }
  const files: Record<string, Uint8Array> = {};
  const folded = new Map<string, string>();
  let total = 0;
  let count = 0;
  try {
    const extract = tar.extract();
    extract.end(tarBytes);
    for await (const entry of extract) {
      count++;
      if (count > MAX_ENTRIES) return refusal(`Archive exceeds entry count limit ${MAX_ENTRIES}`);
      const path = safeMember(entry.header.name);
      if (!path.ok) return path;
      const prior = folded.get(path.value.toLowerCase());
      if (prior !== undefined) return refusal(`Archive member ${entry.header.name} is a duplicate or case-fold collision with ${prior}`);
      folded.set(path.value.toLowerCase(), path.value);
      if (entry.header.type === "directory") continue;
      if (entry.header.type === "link" || entry.header.type === "symlink") return refusal(`Archive member ${entry.header.name} is a link; links are refused`);
      if (entry.header.type !== "file") return refusal(`Archive member ${entry.header.name} has an unsupported type`);
      if (entry.header.size > MAX_FILE_BYTES) return refusal(`Archive file ${path.value} exceeds size limit`);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of entry) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.byteLength;
        if (size > MAX_FILE_BYTES) return refusal(`Archive file ${path.value} exceeds size limit`);
        chunks.push(bytes);
      }
      total += size;
      if (total > MAX_UNPACKED_BYTES) return refusal("Archive exceeds total size limit");
      files[path.value] = Buffer.concat(chunks);
    }
  } catch (error) { return refusal(`Cannot parse tarball: ${errorText(error)}`); }
  if (Object.keys(files).length === 0) return refusal("Archive has no regular files");
  return { ok: true, value: files };
}

interface ArchiveManifest {
  readonly name: string;
  readonly version: string;
  readonly type: unknown;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly peerDependencies: Readonly<Record<string, string>>;
  readonly exports: unknown;
  readonly bounded?: unknown;
}

function archiveManifest(files: Readonly<Record<string, Uint8Array>>, expected: RegistryVersion, isPack: boolean, boundedVersion: string): Result<ArchiveManifest> {
  const bytes = files["package.json"];
  if (bytes === undefined) return refusal(`${expected.name} tarball has no package.json`);
  const parsed = json(bytes, `${expected.name} package.json`);
  if (!parsed.ok) return parsed;
  if (!record(parsed.value) || parsed.value.name !== expected.name || parsed.value.version !== expected.version) return refusal(`${expected.name} package.json identity/version differs from registry metadata`);
  const dependencies = stringMap(parsed.value.dependencies, `${expected.name} dependencies`);
  if (!dependencies.ok) return dependencies;
  const peers = stringMap(parsed.value.peerDependencies, `${expected.name} peerDependencies`);
  if (!peers.ok) return peers;
  if (!sameStringMap(dependencies.value, expected.dependencies) || !sameStringMap(peers.value, expected.peerDependencies)) return refusal(`${expected.name} dependencies or peers differ between registry and tarball`);
  if (record(parsed.value.scripts)) {
    for (const script of ["preinstall", "install", "postinstall"]) if (script in parsed.value.scripts) return refusal(`${expected.name} declares ${script}; bundle it before publishing`);
  }
  if ("bounded" in dependencies.value) return refusal(`${expected.name} depends on a second bounded copy; declare bounded as a peer`);
  if (isPack) {
    const peer = peers.value.bounded;
    if (peer === undefined || !Bun.semver.satisfies(boundedVersion, peer)) return refusal(`${expected.name} requires bounded peer ${peer ?? "(missing)"}, incompatible with ${boundedVersion}`);
  }
  return { ok: true, value: { name: expected.name, version: expected.version, type: parsed.value.type,
    dependencies: dependencies.value, peerDependencies: peers.value, exports: parsed.value.exports,
    ...(parsed.value.bounded === undefined ? {} : { bounded: parsed.value.bounded }) } };
}

function exportTarget(exports: unknown, exportPath: string): Result<string> {
  let selected: string | undefined;
  try {
    const resolution = packageExportsResolve(exports, exportPath);
    if (resolution.listed) selected = resolution.target;
  } catch (error) { return refusal(`Published export ${exportPath} is invalid under Node import resolution: ${errorText(error)}`); }
  if (selected === undefined) return refusal(`Published export ${exportPath} has no Node import target; add import or default JavaScript`);
  if (!selected.startsWith("./")) return refusal(`Published export ${exportPath} has an invalid target ${selected}`);
  const path = safeMember(`package/${selected.slice(2)}`);
  if (!path.ok) return refusal(`Published export ${exportPath} has an unsafe target: ${path.error}`);
  if (!/\.(?:m?js|cjs)$/.test(path.value)) return refusal(`Published export ${exportPath} must name built JavaScript, not source`);
  return path;
}
interface PackageImport { readonly dependencyName: string; readonly exportPath: string }

function inspectJavaScript(files: Readonly<Record<string, Uint8Array>>, manifest: ArchiveManifest, boundedExportPaths: readonly string[]): Result<readonly PackageImport[]> {
  const imports: PackageImport[] = [];
  for (const [path, bytes] of Object.entries(files)) {
    if (path.endsWith(".node")) return refusal(`${manifest.name} contains native addon ${path}. Bundle portable JavaScript instead`);
    if (!/\.(?:m?js|cjs)$/.test(path)) continue;
    let ast: unknown;
    try { ast = parseJavaScript(new TextDecoder("utf-8", { fatal: true }).decode(bytes), { ecmaVersion: "latest", sourceType: "module", allowHashBang: true }); }
    catch (error) { return refusal(`${manifest.name}/${path} is not parseable built JavaScript: ${errorText(error)}`); }
    const checkSpecifier = (specifier: string): Result<void> => {
      if (specifier.startsWith("node:")) return { ok: true, value: undefined };
      if (specifier.startsWith("./") || specifier.startsWith("../")) {
        const resolved = posix.normalize(posix.join(posix.dirname(path), specifier));
        if (resolved === ".." || resolved.startsWith("../") || files[resolved] === undefined) return refusal(`${manifest.name}/${path} imports ${specifier}, which leaves the verified package or has no built file`);
        return { ok: true, value: undefined };
      }
      if (specifier.startsWith("/") || specifier.startsWith("#") || specifier.includes(":") || specifier.includes("\\")) return refusal(`${manifest.name}/${path} imports ${specifier}, which is outside the pinned package graph`);
      const parts = specifier.split("/");
      const dependencyName = specifier.startsWith("@") ? `${parts[0]}/${parts[1] ?? ""}` : parts[0];
      if (dependencyName === "bounded" && manifest.peerDependencies.bounded !== undefined) {
        const suffix = specifier.slice("bounded".length);
        const exportPath = suffix === "" ? "." : `.${suffix}`;
        if (!boundedExportPaths.includes(exportPath)) return refusal(`${manifest.name}/${path} imports ${specifier}, which is absent from the executable's embedded bounded exports`);
        return { ok: true, value: undefined };
      }
      if (dependencyName !== undefined && manifest.dependencies[dependencyName] !== undefined) {
        const suffix = specifier.slice(dependencyName.length);
        imports.push({ dependencyName, exportPath: suffix === "" ? "." : `.${suffix}` });
        return { ok: true, value: undefined };
      }
      return refusal(`${manifest.name}/${path} imports undeclared package ${specifier}; add it to dependencies and pin its closure`);
    };
    const visit = (node: unknown): Result<void> => {
      if (!record(node)) return { ok: true, value: undefined };
      if (node.type === "ImportExpression") {
        const source = node.source;
        if (!record(source) || source.type !== "Literal" || typeof source.value !== "string") return refusal(`${manifest.name}/${path} uses a nonliteral dynamic import; bundle it before publishing`);
        const checked = checkSpecifier(source.value);
        if (!checked.ok) return checked;
      }
      if (node.type === "ImportDeclaration" || node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") {
        const source = node.source;
        if (record(source) && typeof source.value === "string") {
          const checked = checkSpecifier(source.value);
          if (!checked.ok) return checked;
        }
      }
      if (node.type === "CallExpression" && record(node.callee) && node.callee.type === "Identifier" && node.callee.name === "require") {
        return refusal(`${manifest.name}/${path} calls require; publish ESM with statically declared imports`);
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) for (const item of value) { const result = visit(item); if (!result.ok) return result; }
        else if (record(value)) { const result = visit(value); if (!result.ok) return result; }
      }
      return { ok: true, value: undefined };
    };
    const checked = visit(ast);
    if (!checked.ok) return checked;
  }
  return { ok: true, value: imports };
}

function checkCatalog(files: Readonly<Record<string, Uint8Array>>, manifest: ArchiveManifest): Result<void> {
  const parsedManifest = PackageManifest.parse({ name: manifest.name, version: manifest.version, bounded: manifest.bounded });
  if (!parsedManifest.ok) return refusal(parsedManifest.error);
  const bytes = files[parsedManifest.value.catalogPath];
  if (bytes === undefined) return refusal(`${manifest.name} has no ${parsedManifest.value.catalogPath} catalogue`);
  const raw = json(bytes, `${manifest.name} catalogue`);
  if (!raw.ok) return raw;
  const catalog = PackageCatalog.parse(raw.value);
  if (!catalog.ok) return refusal(catalog.error);
  if (catalog.value.package.name !== manifest.name || catalog.value.package.version !== manifest.version) return refusal(`${manifest.name} catalogue package identity/version does not match package.json`);
  const expectedImports = parsedManifest.value.packs.map((pack) => pack.exportPath === "." ? manifest.name : `${manifest.name}/${pack.exportPath.slice(2)}`).sort();
  const listedImports = catalog.value.packs.map((pack) => pack.importPath).sort();
  if (JSON.stringify(expectedImports) !== JSON.stringify(listedImports)) return refusal(`${manifest.name} catalogue pack/export list does not match bounded.packs`);
  for (const pack of parsedManifest.value.packs) {
    const target = exportTarget(manifest.exports, pack.exportPath);
    if (!target.ok) return target;
    if (target.value.endsWith(".cjs") || (target.value.endsWith(".js") && manifest.type !== "module"))
      return refusal(`${manifest.name} catalogue pack export ${pack.exportPath} must target ESM .mjs or .js in a type: module package`);
    if (files[target.value] === undefined) return refusal(`${manifest.name} export ${pack.exportPath} points to missing built JavaScript ${target.value}`);
  }
  return { ok: true, value: undefined };
}

function inventory(files: Readonly<Record<string, Uint8Array>>): FileInventory {
  return Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, { size: bytes.byteLength, sha256: sha256(bytes) }]));
}

const inventoryBytes = (files: FileInventory): Uint8Array => new TextEncoder().encode(`${JSON.stringify({ schema: "bounded-pack-inventory/1", files })}\n`);
const digestPattern = /^[a-f0-9]{64}$/;
const packageNamePattern = /^(?:@[a-z0-9._-]+\/[a-z0-9._-]+|[a-z0-9._-]+)$/;
const runtimeGraphLimits = { nodes: 128, files: 20_000, bytes: 256 * 1024 * 1024,
  lockBytes: 16 * 1024 * 1024, inventoryBytes: 16 * 1024 * 1024 } as const;

/** Bound a proposed lock before any project lock, receipt or projection is published. */
async function checkProposedRuntimeGraphBounds(lock: PackLock, contents: string, storeRoot: string): Promise<Result<void>> {
  if (Object.keys(lock.nodes).length > runtimeGraphLimits.nodes)
    return refusal(`Managed pack graph exceeds ${runtimeGraphLimits.nodes} pinned nodes; reduce the dependency closure`);
  if (utf8(contents).byteLength > runtimeGraphLimits.lockBytes)
    return refusal(`Managed pack lock byte bound exceeds ${runtimeGraphLimits.lockBytes}; reduce the dependency closure`);
  let fileCount = 0;
  let fileBytes = 0;
  for (const [id, node] of Object.entries(lock.nodes)) {
    const inventoryPath = join(storeRoot, node.sha256, "inventory.json");
    const safePath = await noLinkedComponents(inventoryPath);
    if (!safePath.ok) return refusal(`${id}: ${safePath.error}; re-add ${node.name}`);
    try {
      const info = await lstat(inventoryPath);
      if (!info.isFile()) return refusal(`${id} inventory is not a regular file; re-add ${node.name}`);
      if (info.size > runtimeGraphLimits.inventoryBytes)
        return refusal(`${id} inventory metadata exceeds the runtime graph byte bound; reduce the dependency closure`);
      const bytes = await readFile(inventoryPath);
      if (sha256(bytes) !== node.inventorySha256) return refusal(`${id} inventory differs from its proposed lock; re-add ${node.name}`);
      const parsed = json(bytes, `${id} inventory`);
      if (!parsed.ok || !record(parsed.value) || parsed.value.schema !== "bounded-pack-inventory/1" || !record(parsed.value.files))
        return refusal(`${id} inventory is malformed; re-add ${node.name}`);
      for (const details of Object.values(parsed.value.files)) {
        if (!record(details) || !Number.isSafeInteger(details.size) || (details.size as number) < 0)
          return refusal(`${id} inventory size is malformed; re-add ${node.name}`);
        fileCount++;
        fileBytes += details.size as number;
        if (fileCount > runtimeGraphLimits.files || fileBytes > runtimeGraphLimits.bytes)
          return refusal("Managed pack graph exceeds the total file or byte bound; reduce the dependency closure");
      }
    } catch (error) { return refusal(`${id} inventory cannot be bounded: ${errorText(error)}; re-add ${node.name}`); }
  }
  return { ok: true, value: undefined };
}

/** Reads a complete pinned graph without network access or running package code. */
async function verifyManagedPackLockDetailed(input: VerifyInput, limits?: typeof runtimeGraphLimits): Promise<Result<{ readonly lock: PackLock; readonly lockBytes: Uint8Array; readonly stored: ReadonlyMap<string, { readonly files: Readonly<Record<string, Uint8Array>>; readonly manifest: ArchiveManifest }> }>> {
  const lockPath = join(input.projectRoot, ".bounded", "packs.lock.json");
  const safeLock = await noLinkedComponents(lockPath);
  if (!safeLock.ok) return safeLock;
  let lockBytes: Uint8Array;
  try {
    const lockInfo = await lstat(lockPath);
    if (!lockInfo.isFile()) return refusal(`Project pack lock ${lockPath} is not a regular file; re-add the packs`);
    if (limits !== undefined && lockInfo.size > limits.lockBytes)
      return refusal(`Managed pack lock byte bound exceeds ${limits.lockBytes}; reduce the dependency closure`);
    lockBytes = await readFile(lockPath);
  } catch (error) { return refusal(`Cannot read project pack lock ${lockPath}: ${errorText(error)}; re-add the packs`); }
  const parsed = json(lockBytes, "Project pack lock");
  if (!parsed.ok) return parsed;
  if (!record(parsed.value)) return refusal("Project pack lock is malformed; re-add the packs");
  if (parsed.value.schema === "bounded-packs-lock/1") return refusal("Legacy bounded-packs-lock/1 cannot be migrated without re-verifying exact tarball bytes; re-add each published pack with bounded add name@version");
  if (parsed.value.schema !== "bounded-packs-lock/2" || parsed.value.boundedVersion !== input.boundedVersion || !record(parsed.value.roots) || !record(parsed.value.nodes))
    return refusal(`Project pack lock schema or Bounded version does not match ${input.boundedVersion}; re-add the packs for this Bounded version`);
  if (limits !== undefined && Object.keys(parsed.value.nodes).length > limits.nodes)
    return refusal(`Managed pack graph exceeds ${limits.nodes} pinned nodes; reduce the dependency closure`);
  const roots: Record<string, string> = {};
  const nodes: Record<string, LockNode> = {};
  for (const [name, id] of Object.entries(parsed.value.roots)) {
    if (!packageNamePattern.test(name) || typeof id !== "string" || roots[name] !== undefined) return refusal(`Project pack root ${name} is malformed; re-add the pack`);
    roots[name] = id;
  }
  if (Object.keys(roots).length === 0) return refusal("Project pack lock has no directly selected roots; re-add a pack");
  const identities = new Set<string>();
  for (const [key, raw] of Object.entries(parsed.value.nodes)) {
    if (!record(raw) || typeof raw.id !== "string" || raw.id !== key || typeof raw.name !== "string" || !packageNamePattern.test(raw.name)
      || typeof raw.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(raw.version)
      || typeof raw.sha256 !== "string" || !digestPattern.test(raw.sha256) || key !== `${raw.name}@${raw.version}#${raw.sha256}`
      || typeof raw.inventorySha256 !== "string" || !digestPattern.test(raw.inventorySha256)
      || typeof raw.tarballUrl !== "string" || !raw.tarballUrl.startsWith("https://")
      || (raw.integrity !== null && typeof raw.integrity !== "string") || !record(raw.dependencies)) return refusal(`Project pack node ${key} or its inventory digest is malformed; re-add that package`);
    const identity = `${raw.name}@${raw.version}`;
    if (identities.has(identity)) return refusal(`Project pack has duplicate identity ${identity}; re-add that package`);
    identities.add(identity);
    const edges: Record<string, string> = {};
    for (const [dependencyName, target] of Object.entries(raw.dependencies)) {
      if (!packageNamePattern.test(dependencyName) || typeof target !== "string") return refusal(`${identity} has a malformed dependency edge ${dependencyName}; re-add that package`);
      edges[dependencyName] = target;
    }
    nodes[key] = { id: key, name: raw.name, version: raw.version, sha256: raw.sha256, inventorySha256: raw.inventorySha256,
      tarballUrl: raw.tarballUrl, integrity: raw.integrity, dependencies: edges };
  }
  for (const [name, id] of Object.entries(roots)) if (nodes[id]?.name !== name) return refusal(`Project root ${name} names missing or mismatched node ${id}; re-add ${name}`);
  const stored = new Map<string, { files: Readonly<Record<string, Uint8Array>>; manifest: ArchiveManifest; imports: readonly PackageImport[] }>();
  let limitedFiles = 0;
  let limitedBytes = 0;
  for (const [id, node] of Object.entries(nodes)) {
    const storePath = join(input.storeRoot, node.sha256);
    const safeStore = await noLinkedComponents(storePath);
    if (!safeStore.ok) return refusal(`${id}: ${safeStore.error}; re-add ${node.name}`);
    try {
      if (!(await lstat(storePath)).isDirectory()) return refusal(`${id} store is not a directory; re-add ${node.name}`);
      const inventoryPath = join(storePath, "inventory.json");
      const inventoryInfo = await lstat(inventoryPath);
      if (!inventoryInfo.isFile()) return refusal(`${id} inventory is not a regular file; re-add ${node.name}`);
      if (limits !== undefined && inventoryInfo.size > limits.inventoryBytes)
        return refusal(`${id} inventory metadata exceeds the runtime graph byte bound; reduce the dependency closure`);
      const bytes = await readFile(inventoryPath);
      if (sha256(bytes) !== node.inventorySha256) return refusal(`${id} inventory digest differs from the lock; re-add ${node.name}`);
      const inventoryJson = json(bytes, `${id} inventory`);
      if (!inventoryJson.ok) return refusal(`${inventoryJson.error}; re-add ${node.name}`);
      if (!record(inventoryJson.value) || inventoryJson.value.schema !== "bounded-pack-inventory/1" || !record(inventoryJson.value.files)) return refusal(`${id} inventory is malformed; re-add ${node.name}`);
      if (limits !== undefined) {
        for (const details of Object.values(inventoryJson.value.files)) {
          if (!record(details) || !Number.isSafeInteger(details.size) || (details.size as number) < 0)
            return refusal(`${id} inventory size is malformed; re-add ${node.name}`);
          limitedFiles++;
          limitedBytes += details.size as number;
          if (limitedFiles > limits.files || limitedBytes > limits.bytes)
            return refusal(`Managed pack graph exceeds the total file or byte bound; reduce the dependency closure`);
        }
      }
      const files: Record<string, Uint8Array> = {};
      for (const [name, details] of Object.entries(inventoryJson.value.files)) {
        const safeName = safeMember(`package/${name}`);
        if (!safeName.ok || safeName.value !== name || !record(details) || !Number.isSafeInteger(details.size) || (details.size as number) < 0
          || typeof details.sha256 !== "string" || !digestPattern.test(details.sha256)) return refusal(`${id} inventory entry ${name} is malformed; re-add ${node.name}`);
        const filePath = join(storePath, "package", name);
        const safeFile = await noLinkedComponents(filePath);
        if (!safeFile.ok) return refusal(`${id}: ${safeFile.error}; re-add ${node.name}`);
        const info = await lstat(filePath);
        if (!info.isFile() || info.size !== details.size) return refusal(`${id} file ${name} differs from its inventory; re-add ${node.name}`);
        const content = await readFile(filePath);
        if (sha256(content) !== details.sha256) return refusal(`${id} file ${name} differs from its inventory; re-add ${node.name}`);
        files[name] = content;
      }
      const found = await filesRecursively(storePath);
      const expectedPaths = new Set([join(storePath, "inventory.json"), ...Object.keys(files).map((name) => join(storePath, "package", name))]);
      if (found.length !== expectedPaths.size || found.some((path) => !expectedPaths.has(path))) return refusal(`${id} store has missing or unexpected files; re-add ${node.name}`);
      const packageBytes = files["package.json"];
      if (packageBytes === undefined) return refusal(`${id} has no package.json; re-add ${node.name}`);
      const packageJson = json(packageBytes, `${id} package.json`);
      if (!packageJson.ok || !record(packageJson.value)) return refusal(`${id} package.json is malformed; re-add ${node.name}`);
      const dependencies = stringMap(packageJson.value.dependencies, `${id} dependencies`);
      const peers = stringMap(packageJson.value.peerDependencies, `${id} peers`);
      if (!dependencies.ok || !peers.ok) return refusal(`${id} package dependencies are malformed; re-add ${node.name}`);
      const expected: RegistryVersion = { name: node.name, version: node.version, dependencies: dependencies.value, peerDependencies: peers.value,
        dist: { tarball: node.tarballUrl, ...(node.integrity === null ? {} : { integrity: node.integrity }) } };
      const isPack = Object.values(roots).includes(id) || packageJson.value.bounded !== undefined;
      const manifest = archiveManifest(files, expected, isPack, input.boundedVersion);
      if (!manifest.ok) return refusal(`${id}: ${manifest.error}; re-add ${node.name}`);
      if (isPack) { const catalog = checkCatalog(files, manifest.value); if (!catalog.ok) return refusal(`${id}: ${catalog.error}; re-add ${node.name}`); }
      const imports = inspectJavaScript(files, manifest.value, input.boundedExportPaths);
      if (!imports.ok) return refusal(`${id}: ${imports.error}; re-add ${node.name}`);
      if (JSON.stringify(Object.keys(node.dependencies).sort()) !== JSON.stringify(Object.keys(manifest.value.dependencies).sort())) return refusal(`${id} dependency edges differ from package.json; re-add ${node.name}`);
      stored.set(id, { files, manifest: manifest.value, imports: imports.value });
    } catch (error) { return refusal(`${id} store cannot be verified: ${errorText(error)}; re-add ${node.name}`); }
  }
  const reachable = new Set<string>();
  const visiting = new Set<string>();
  const walk = (id: string, available: Readonly<Record<string, string>>): Result<void> => {
    const node = nodes[id];
    const data = stored.get(id);
    if (node === undefined || data === undefined) return refusal(`Missing package node ${id}; re-add the pack`);
    if (visiting.has(id)) return refusal(`${id} has a dependency cycle; re-add ${node.name}`);
    for (const [peer, range] of Object.entries(data.manifest.peerDependencies)) if (available[peer] === undefined || !Bun.semver.satisfies(available[peer], range))
      return refusal(`${id} peer ${peer}@${range} is not satisfied; re-add ${node.name}`);
    if (reachable.has(id)) return { ok: true, value: undefined };
    visiting.add(id);
    const childAvailable: Record<string, string> = { ...available };
    for (const [dependencyName, childId] of Object.entries(node.dependencies)) {
      const child = nodes[childId];
      if (child === undefined || child.name !== dependencyName || !Bun.semver.satisfies(child.version, data.manifest.dependencies[dependencyName] ?? ""))
        return refusal(`${id} dependency ${dependencyName} points to missing or mismatched node ${childId}; re-add ${node.name}`);
      childAvailable[dependencyName] = child.version;
    }
    for (const imported of data.imports) {
      const childId = node.dependencies[imported.dependencyName];
      const child = childId === undefined ? undefined : stored.get(childId);
      if (child === undefined) return refusal(`${id} import ${imported.dependencyName} has no dependency edge; re-add ${node.name}`);
      const target = exportTarget(child.manifest.exports, imported.exportPath);
      if (!target.ok || child.files[target.value] === undefined) return refusal(`${id} import ${imported.dependencyName} has missing export; re-add ${node.name}`);
    }
    for (const childId of Object.values(node.dependencies)) { const result = walk(childId, childAvailable); if (!result.ok) return result; }
    visiting.delete(id);
    reachable.add(id);
    return { ok: true, value: undefined };
  };
  for (const id of Object.values(roots)) { const result = walk(id, { bounded: input.boundedVersion }); if (!result.ok) return result; }
  if (reachable.size !== Object.keys(nodes).length) return refusal("Project pack lock contains unreachable nodes; re-add the packs");
  return { ok: true, value: { lock: { schema: "bounded-packs-lock/2", boundedVersion: input.boundedVersion, roots, nodes }, lockBytes, stored } };
}

export async function verifyManagedPackLock(input: VerifyInput): Promise<Result<PackLock>> {
  const checked = await verifyManagedPackLockDetailed(input);
  return checked.ok ? { ok: true, value: checked.value.lock } : checked;
}

async function verifiedStore(path: string, expected: FileInventory, expectedInventorySha256: string): Promise<boolean> {
  try {
    const inventoryPath = join(path, "inventory.json");
    if (!(await lstat(inventoryPath)).isFile()) return false;
    const bytes = await readFile(inventoryPath);
    if (sha256(bytes) !== expectedInventorySha256) return false;
    const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    if (!record(raw) || JSON.stringify(raw.files) !== JSON.stringify(expected)) return false;
    const found = await filesRecursively(path);
    if (found.length !== Object.keys(expected).length + 1) return false;
    for (const [name, details] of Object.entries(expected)) {
      const file = join(path, "package", name);
      const info = await lstat(file);
      if (!info.isFile() || info.size !== details.size || sha256(await readFile(file)) !== details.sha256) return false;
    }
    return true;
  } catch { return false; }
}

async function filesRecursively(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...await filesRecursively(path));
    else if (entry.isFile()) found.push(path);
    else throw new Error(`Store entry ${path} is a link or unsupported file`);
  }
  return found;
}

async function noLinkedComponents(path: string): Promise<Result<void>> {
  let absolute = resolve(path);
  // The operating system's temporary directory may itself be an alias (for example /var on macOS).
  // Resolve that trusted prefix, then inspect every component below it without following links.
  const temporaryRoot = resolve(tmpdir());
  if (absolute === temporaryRoot || absolute.startsWith(`${temporaryRoot}${sep}`)) {
    try { absolute = join(await realpath(temporaryRoot), relative(temporaryRoot, absolute)); }
    catch (error) { return refusal(`Cannot inspect temporary directory: ${errorText(error)}`); }
  }
  const root = parse(absolute).root;
  let current = root;
  for (const component of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) return refusal(`Path ${current} contains a link; managed pack stores and locks require real directories`);
    } catch (error) {
      if (record(error) && error.code === "ENOENT") return { ok: true, value: undefined };
      return refusal(`Cannot inspect path ${current}: ${errorText(error)}`);
    }
  }
  return { ok: true, value: undefined };
}

async function publishStore(storeRoot: string, digest: string, files: Readonly<Record<string, Uint8Array>>, expected: FileInventory, expectedInventorySha256: string): Promise<Result<void>> {
  const finalPath = join(storeRoot, digest);
  const safe = await noLinkedComponents(finalPath);
  if (!safe.ok) return safe;
  if (existsSync(finalPath)) return await verifiedStore(finalPath, expected, expectedInventorySha256) ? { ok: true, value: undefined } : refusal(`Stored package ${digest} fails inventory verification`);
  await mkdir(storeRoot, { recursive: true });
  const stage = join(storeRoot, `.staging-${randomUUID()}`);
  await mkdir(stage);
  try {
    for (const [name, content] of Object.entries(files)) {
      const path = join(stage, "package", name);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, content, { flag: "wx" });
    }
    await writeFile(join(stage, "inventory.json"), inventoryBytes(expected), { flag: "wx" });
    if (!await verifiedStore(stage, expected, expectedInventorySha256)) return refusal(`Staged package ${digest} fails inventory verification`);
    try { await rename(stage, finalPath); }
    catch (error) {
      if (!existsSync(finalPath) || !await verifiedStore(finalPath, expected, expectedInventorySha256)) return refusal(`Cannot publish stored package ${digest}: ${errorText(error)}`);
    }
    return { ok: true, value: undefined };
  } finally { await rm(stage, { recursive: true, force: true }); }
}

async function atomicLock(path: string, contents: string): Promise<void> {
  const directory = join(path, "..");
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.packs.lock-${randomUUID()}.tmp`);
  try { await writeFile(temporary, contents, { flag: "wx" }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

async function acquireProjectWriter(lockPath: string): Promise<Result<() => Promise<void>>> {
  const writerPath = join(lockPath, "..", ".packs-lock-writer");
  const reclaimPath = join(lockPath, "..", ".packs-lock-reclaim");
  const safe = await noLinkedComponents(writerPath);
  if (!safe.ok) return safe;
  await mkdir(join(lockPath, ".."), { recursive: true });
  for (let attempt = 0; attempt < 300; attempt++) {
    try {
      await mkdir(writerPath);
      const nonce = randomUUID();
      try { await writeFile(join(writerPath, "owner.json"), `${JSON.stringify({ pid: process.pid, nonce })}\n`, { flag: "wx" }); }
      catch (error) { await rm(writerPath, { recursive: true, force: true }); throw error; }
      return { ok: true, value: async () => {
        const owner: unknown = JSON.parse(await readFile(join(writerPath, "owner.json"), "utf8"));
        if (!record(owner) || owner.nonce !== nonce || owner.pid !== process.pid) throw new Error("Project pack writer ownership changed before release");
        await rm(writerPath, { recursive: true, force: true });
      } };
    } catch (error) {
      if (!record(error) || error.code !== "EEXIST") return refusal(`Cannot acquire project pack writer: ${errorText(error)}`);
      const checked = await noLinkedComponents(writerPath);
      if (!checked.ok) return checked;
      // The exclusive guard serializes post-mortem takeovers. If its own
      // owner died, refuse; no age-based guess can prove it is safe to take.
      try {
        await mkdir(reclaimPath);
      } catch (guardError) {
        if (!record(guardError) || guardError.code !== "EEXIST") return refusal(`Cannot inspect project pack writer: ${errorText(guardError)}`);
        await Bun.sleep(50);
        continue;
      }
      try {
        if (existsSync(writerPath)) {
          let names = await readdir(writerPath);
          // A live writer can be between mkdir and its owner-file write.
          for (let ownerWait = 0; names.length === 0 && ownerWait < 20; ownerWait++) {
            await Bun.sleep(50);
            if (!existsSync(writerPath)) break;
            names = await readdir(writerPath);
          }
          if (!existsSync(writerPath)) continue;
          if (names.length !== 1 || names[0] !== "owner.json") return refusal(`Project pack writer ownership is uncertain at ${writerPath}; repair manually`);
          const owner: unknown = JSON.parse(await readFile(join(writerPath, "owner.json"), "utf8"));
          if (!record(owner) || !Number.isSafeInteger(owner.pid) || typeof owner.nonce !== "string" || !/^[a-f0-9-]{36}$/.test(owner.nonce))
            return refusal(`Project pack writer ownership is uncertain at ${writerPath}; repair manually`);
          let dead = false;
          try { process.kill(owner.pid as number, 0); }
          catch (probeError) { if (record(probeError) && probeError.code === "ESRCH") dead = true; else return refusal(`Cannot prove project pack writer has exited: ${errorText(probeError)}`); }
          if (dead) await rm(writerPath, { recursive: true, force: true });
        }
      } catch (inspectError) { return refusal(`Cannot inspect project pack writer: ${errorText(inspectError)}`); }
      finally { await rm(reclaimPath, { recursive: true, force: true }); }
      await Bun.sleep(50);
    }
  }
  return refusal(`Project pack writer is busy at ${writerPath}; retry the add or repair the stale writer directory`);
}

async function prepareAdditionUnderWriter(input: InstallInput, publish: boolean, writerHeld: boolean): Promise<Result<{ readonly lockPath: string; readonly lock: PackLock; readonly contents: string; readonly catalogueImports: readonly CatalogueImport[] }>> {
  const request = exactRequest(input.request);
  if (!request.ok) return request;
  const nodes: Record<string, LockNode> = {};
  const versions = new Map<string, Record<string, RegistryVersion>>();
  const visiting = new Set<string>();
  const installed = new Map<string, { id: string; peers: Readonly<Record<string, string>> }>();
  const installedExports = new Map<string, { exports: unknown; files: Readonly<Record<string, Uint8Array>> }>();
  const checkPeers = (identity: string, peers: Readonly<Record<string, string>>, available: Readonly<Record<string, string>>): Result<void> => {
    for (const [peerName, peerRange] of Object.entries(peers)) {
      const visibleVersion = available[peerName];
      if (visibleVersion === undefined || !Bun.semver.satisfies(visibleVersion, peerRange)) return refusal(`${identity} requires peer ${peerName}@${peerRange}, but its consumer provides ${visibleVersion ?? "none"}`);
    }
    return { ok: true, value: undefined };
  };
  const fetchVersion = async (name: string, spec: string): Promise<Result<RegistryVersion>> => {
    let offered = versions.get(name);
    if (offered === undefined) {
      const read = await metadata(name, input.registryUrl, input.get);
      if (!read.ok) return read;
      offered = read.value;
      versions.set(name, offered);
    }
    const matched = Object.keys(offered).filter((version) => Bun.semver.satisfies(version, spec)).sort((a, b) => Bun.semver.order(b, a));
    const selected = matched[0];
    if (selected === undefined || offered[selected] === undefined) return refusal(`Package ${name} has no version satisfying ${spec}`);
    return { ok: true, value: offered[selected] };
  };
  const add = async (name: string, spec: string, isPack: boolean, available: Readonly<Record<string, string>>): Promise<Result<string>> => {
    const selected = await fetchVersion(name, spec);
    if (!selected.ok) return selected;
    const version = selected.value;
    const identity = `${name}@${version.version}`;
    if (visiting.has(identity)) return refusal(`Dependency cycle includes ${identity}; bundle it before publishing`);
    const already = installed.get(identity);
    if (already !== undefined) {
      const compatible = checkPeers(identity, already.peers, available);
      return compatible.ok ? { ok: true, value: already.id } : compatible;
    }
    visiting.add(identity);
    try {
      const downloaded = await fetchHttps(version.dist.tarball, input.get);
      if (!downloaded.ok) return downloaded;
      const archive = downloaded.value.body;
      if (version.dist.integrity !== undefined) {
        const expected = version.dist.integrity.match(/^sha512-([A-Za-z0-9+/]+={0,2})$/)?.[1];
        if (expected === undefined || createHash("sha512").update(archive).digest("base64") !== expected) return refusal(`${identity} tarball fails registry integrity`);
      }
      const digest = sha256(archive);
      const extracted = await archiveFiles(archive);
      if (!extracted.ok) return extracted;
      const manifest = archiveManifest(extracted.value, version, isPack, input.boundedVersion);
      if (!manifest.ok) return manifest;
      const compatible = checkPeers(identity, manifest.value.peerDependencies, available);
      if (!compatible.ok) return compatible;
      const inspected = inspectJavaScript(extracted.value, manifest.value, input.boundedExportPaths);
      if (!inspected.ok) return inspected;
      if (isPack) {
        const catalog = checkCatalog(extracted.value, manifest.value);
        if (!catalog.ok) return catalog;
      }
      const id = `${identity}#${digest}`;
      const edges: Record<string, string> = {};
      const visibleToChildren: Record<string, string> = { ...available };
      for (const [dependencyName, dependencySpec] of Object.entries(manifest.value.dependencies)) {
        const childVersion = await fetchVersion(dependencyName, dependencySpec);
        if (!childVersion.ok) return childVersion;
        visibleToChildren[dependencyName] = childVersion.value.version;
      }
      for (const [dependencyName, dependencySpec] of Object.entries(manifest.value.dependencies)) {
        const child = await add(dependencyName, dependencySpec, false, visibleToChildren);
        if (!child.ok) return child;
        edges[dependencyName] = child.value;
      }
      for (const imported of inspected.value) {
        const childId = edges[imported.dependencyName];
        const child = childId === undefined ? undefined : installedExports.get(childId);
        if (child === undefined) return refusal(`${identity} imports ${imported.dependencyName} outside its verified dependency closure`);
        const target = exportTarget(child.exports, imported.exportPath);
        if (!target.ok) return refusal(`${identity} imports ${imported.dependencyName}${imported.exportPath === "." ? "" : imported.exportPath.slice(1)}, whose export is unavailable: ${target.error}`);
        if (child.files[target.value] === undefined) return refusal(`${identity} imports ${imported.dependencyName}, whose exported JavaScript ${target.value} is missing`);
      }
      const fileInventory = inventory(extracted.value);
      const inventorySha256 = sha256(inventoryBytes(fileInventory));
      const stored = await publishStore(input.storeRoot, digest, extracted.value, fileInventory, inventorySha256);
      if (!stored.ok) return stored;
      nodes[id] = { id, name, version: version.version, tarballUrl: downloaded.value.url,
        integrity: version.dist.integrity ?? null, sha256: digest, inventorySha256, dependencies: edges };
      installed.set(identity, { id, peers: manifest.value.peerDependencies });
      installedExports.set(id, { exports: manifest.value.exports, files: extracted.value });
      return { ok: true, value: id };
    } finally { visiting.delete(identity); }
  };
  try {
    const root = await add(request.value.name, request.value.version, true, { bounded: input.boundedVersion });
    if (!root.ok) return root;
    const rootFiles = installedExports.get(root.value)?.files;
    const rootManifestBytes = rootFiles?.["package.json"];
    if (rootFiles === undefined || rootManifestBytes === undefined) return refusal(`${request.value.name} has no verified catalogue source`);
    const rootManifestJson = json(rootManifestBytes, `${request.value.name} package.json`);
    if (!rootManifestJson.ok) return rootManifestJson;
    const rootManifest = PackageManifest.parse(rootManifestJson.value);
    if (!rootManifest.ok) return rootManifest;
    const rootCatalogueBytes = rootFiles[rootManifest.value.catalogPath];
    if (rootCatalogueBytes === undefined) return refusal(`${request.value.name} has no verified catalogue`);
    const rootCatalogueJson = json(rootCatalogueBytes, `${request.value.name} catalogue`);
    if (!rootCatalogueJson.ok) return rootCatalogueJson;
    const rootCatalogue = PackageCatalog.parse(rootCatalogueJson.value);
    if (!rootCatalogue.ok) return rootCatalogue;
    const catalogueImports: readonly CatalogueImport[] = rootCatalogue.value.packs.map(({ importPath, exportName }) => ({ importPath, exportName }));
    const lockPath = join(input.projectRoot, ".bounded", "packs.lock.json");
    const safeLock = await noLinkedComponents(lockPath);
    if (!safeLock.ok) return safeLock;
    const writer = writerHeld ? { ok: true as const, value: async () => {} } : await acquireProjectWriter(lockPath);
    if (!writer.ok) return writer;
    try {
      let prior: PackLock | undefined;
      if (existsSync(lockPath)) {
        const verified = await verifyManagedPackLock(input);
        if (!verified.ok) return verified;
        prior = verified.value;
        if (input.afterExistingLockVerified !== undefined) await input.afterExistingLockVerified(sha256(await readFile(lockPath)));
      }
      const roots: Record<string, string> = { ...prior?.roots, [request.value.name]: root.value };
      const candidates: Record<string, LockNode> = { ...prior?.nodes, ...nodes };
      const kept: Record<string, LockNode> = {};
      const retain = (id: string): void => {
        if (kept[id] !== undefined) return;
        const node = candidates[id];
        if (node === undefined) throw new Error(`Project pack root or dependency node ${id} is missing`);
        kept[id] = node;
        for (const childId of Object.values(node.dependencies)) retain(childId);
      };
      for (const id of Object.values(roots)) retain(id);
      const contents = `${JSON.stringify({ schema: "bounded-packs-lock/2", boundedVersion: input.boundedVersion,
        roots, nodes: kept }, null, 2)}\n`;
      if (publish) {
        try { await (input.publishLock ?? atomicLock)(lockPath, contents); }
        catch (error) { return refusal(`Cannot publish project lock: ${errorText(error)}`); }
      }
      return { ok: true, value: { lockPath, lock: { schema: "bounded-packs-lock/2", boundedVersion: input.boundedVersion, roots, nodes: kept }, contents, catalogueImports } };
    } finally { await writer.value(); }
  } catch (error) { return refusal(`Cannot install ${input.request}: ${errorText(error)}`); }
}

/** Prepares a complete verified graph and content-addressed stores without changing the active project lock. */
export async function prepareManagedPackAddition(input: InstallInput): Promise<Result<{ readonly lock: PackLock; readonly lockPath: string; readonly contents: string }>> {
  const lockPath = join(input.projectRoot, ".bounded", "packs.lock.json");
  const writer = await acquireProjectWriter(lockPath);
  if (!writer.ok) return writer;
  try { return await prepareAdditionUnderWriter(input, false, true); }
  finally { await writer.value(); }
}

/** Installs the verified npm-compatible artifact graph without running a package manager or package scripts. */
export async function installManagedPack(input: InstallInput): Promise<Result<{ readonly lockPath: string }>> {
  const result = await prepareAdditionUnderWriter(input, true, false);
  return result.ok ? { ok: true, value: { lockPath: result.value.lockPath } } : result;
}

export interface ProjectionInput extends InstallInput {
  /** Root of share/types from a verified installed release. */
  readonly releaseTypesRoot: string;
  /** Manifest-pinned SHA-256 values, supplied by the installed-release verifier. */
  readonly releaseTypeFilesFromVerifiedManifest: Readonly<Record<string, string>>;
  readonly faultAfter?: string;
  readonly afterExistingStateVerified?: (lockSha256: string | null) => Promise<void>;
}
type ProjectionVerifyInput = Pick<ProjectionInput, "boundedVersion" | "boundedExportPaths" | "projectRoot" | "storeRoot" | "releaseTypesRoot" | "releaseTypeFilesFromVerifiedManifest">;
interface ProjectionReceipt {
  readonly schema: "bounded-types-receipt/1";
  readonly lockSha256: string;
  readonly packages: readonly string[];
  readonly files: Readonly<Record<string, string>>;
}
interface ProjectionJournal {
  readonly schema: "bounded-types-journal/1";
  readonly oldLockBackup: string | null;
  readonly oldLockSha256: string | null;
  readonly oldReceiptBackup: string | null;
  readonly oldReceiptSha256: string | null;
  readonly oldPackages: Readonly<Record<string, string | null>>;
  readonly newPackages: readonly string[];
  readonly newFiles: Readonly<Record<string, string>>;
  readonly stage: string;
}
const boundedTypeTargets: Readonly<Record<string, string>> = {
  "./domain": "core/domain/index.d.ts", "./application": "core/application/index.d.ts",
  "./adapters": "core/adapters/out/index.d.ts", "./open-project": "core/composition-root/open-project.d.ts",
  "./prereqs": "packs/prereqs/index.d.ts", "./prereqs/adapters": "packs/prereqs/adapters/out/index.d.ts",
  "./protected-paths": "packs/protected-paths/index.d.ts", "./protected-paths/adapters": "packs/protected-paths/adapters/out/index.d.ts",
  "./shell-command-reader": "shell-command-reader/index.d.ts",
};
const projectionPaths = (root: string) => ({ bounded: join(root, ".bounded"), lock: join(root, ".bounded", "packs.lock.json"),
  receipt: join(root, ".bounded", "types-receipt.json"), journal: join(root, ".bounded", "types-journal.json"), modules: join(root, "node_modules") });
const isSafeRelative = (path: string): boolean => path !== "" && !path.startsWith("/") && !path.includes("\\")
  && path.split("/").every((part) => part !== "" && part !== "." && part !== ".." && !part.includes(":"));
const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);
const projectionError = (error: unknown): string => error instanceof Error ? error.message : String(error);
function syncSafe(path: string): void {
  let absolute = resolve(path);
  const temporary = resolve(tmpdir());
  if (absolute === temporary || absolute.startsWith(`${temporary}${sep}`)) absolute = join(realpathSync(temporary), relative(temporary, absolute));
  let current = parse(absolute).root;
  for (const component of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    try { if (lstatSync(current).isSymbolicLink()) throw new Error(`Path ${current} contains a link`); }
    catch (error) { if (!record(error) || error.code !== "ENOENT") throw error; }
  }
}
function syncFile(path: string): void {
  const file = openSync(path, "r");
  try { fsyncSync(file); } finally { closeSync(file); }
}
function syncDirectory(path: string): void {
  try { const directory = openSync(path, "r"); try { fsyncSync(directory); } finally { closeSync(directory); } }
  catch (error) {
    const code = record(error) ? error.code : undefined;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "EBADF" && code !== "EISDIR" && code !== "EPERM") throw error;
  }
}
function syncDirectoryTree(root: string): void {
  for (const name of readdirSync(root)) {
    const child = join(root, name);
    const info = lstatSync(child);
    if (info.isDirectory()) syncDirectoryTree(child);
    else if (!info.isFile()) throw new Error(`Cannot sync linked or unsupported staged entry ${child}`);
  }
  syncDirectory(root);
}
function syncParentChain(path: string, through: string): void {
  let parent = dirname(path);
  const boundary = resolve(through);
  for (;;) {
    syncDirectory(parent);
    if (resolve(parent) === boundary) break;
    const next = dirname(parent);
    if (next === parent || !resolve(parent).startsWith(`${boundary}${sep}`)) throw new Error(`Cannot sync parent of ${path} outside ${through}`);
    parent = next;
  }
  syncDirectory(dirname(boundary));
}
function durableWrite(path: string, bytes: Uint8Array): void {
  syncSafe(path);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.types-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, bytes, { flag: "wx" });
    syncFile(temporary);
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } finally { rmSync(temporary, { force: true }); }
}
function parseReceiptBytes(bytes: Uint8Array): ProjectionReceipt {
  const raw: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!record(raw) || raw.schema !== "bounded-types-receipt/1" || typeof raw.lockSha256 !== "string" || !digestPattern.test(raw.lockSha256)
    || !Array.isArray(raw.packages) || !raw.packages.every((name) => typeof name === "string" && isSafeRelative(name)) || !record(raw.files))
    throw new Error("Projection receipt is malformed");
  for (const [path, hash] of Object.entries(raw.files)) if (!isSafeRelative(path) || typeof hash !== "string" || !digestPattern.test(hash)) throw new Error(`Projection receipt file ${path} is malformed`);
  return raw as unknown as ProjectionReceipt;
}
function parseReceipt(path: string): ProjectionReceipt { return parseReceiptBytes(readFileSync(path)); }
function fileSet(root: string): Readonly<Record<string, string>> {
  const found: Record<string, string> = {};
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const info = lstatSync(path);
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error(`Projection contains a link or unsupported entry at ${path}`);
      if (info.isDirectory()) visit(path);
      else found[relative(root, path).split(sep).join("/")] = sha256(readFileSync(path));
    }
  };
  visit(root);
  return found;
}
function directorySet(root: string): readonly string[] {
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const info = lstatSync(path);
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error(`Projection contains a link or unsupported entry at ${path}`);
      if (info.isDirectory()) { found.push(relative(root, path).split(sep).join("/")); visit(path); }
    }
  };
  visit(root);
  return found.sort();
}
function impliedDirectories(files: Readonly<Record<string, string>>): readonly string[] {
  const directories = new Set<string>();
  for (const name of Object.keys(files)) {
    const parts = name.split("/");
    for (let length = 1; length < parts.length; length++) directories.add(parts.slice(0, length).join("/"));
  }
  return [...directories].sort();
}
function exactTree(root: string, expectedFiles: Readonly<Record<string, string>>): boolean {
  return JSON.stringify(Object.entries(fileSet(root)).sort()) === JSON.stringify(Object.entries(expectedFiles).sort())
    && JSON.stringify(directorySet(root)) === JSON.stringify(impliedDirectories(expectedFiles));
}
function verifyOwnedProjection(input: ProjectionVerifyInput, receipt: ProjectionReceipt, lockBytes: Uint8Array): void {
  if (receipt.lockSha256 !== sha256(lockBytes)) throw new Error("Projection receipt source lock digest differs from active lock");
  const { modules } = projectionPaths(input.projectRoot);
  const actual: Record<string, string> = {};
  for (const packagePath of receipt.packages) {
    const path = join(modules, packagePath);
    syncSafe(path);
    if (!existsSync(path) || !lstatSync(path).isDirectory()) throw new Error(`Projection owned package ${path} is missing`);
    const found = fileSet(path);
    const expected = Object.fromEntries(Object.entries(receipt.files).filter(([name]) => name.startsWith(`node_modules/${packagePath}/`))
      .map(([name, hash]) => [name.slice(`node_modules/${packagePath}/`.length), hash]));
    if (!exactTree(path, expected)) throw new Error(`Projection package ${path} has unexpected files or directories`);
    for (const [name, hash] of Object.entries(found)) actual[`node_modules/${packagePath}/${name}`] = hash;
  }
  if (JSON.stringify(Object.entries(actual).sort()) !== JSON.stringify(Object.entries(receipt.files).sort()))
    throw new Error("Projection file set or bytes differ from receipt");
}
function releaseTypes(input: ProjectionVerifyInput): Readonly<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {};
  for (const [name, expected] of Object.entries(input.releaseTypeFilesFromVerifiedManifest)) {
    if (!isSafeRelative(name) || !name.endsWith(".d.ts") || !digestPattern.test(expected)) throw new Error(`Verified release type manifest entry ${name} is invalid`);
    const path = join(input.releaseTypesRoot, name);
    syncSafe(path);
    if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error(`Verified release declaration ${name} is missing`);
    const bytes = readFileSync(path);
    if (sha256(bytes) !== expected) throw new Error(`Verified release declaration ${name} fails manifest SHA-256`);
    files[name] = bytes;
  }
  return files;
}
function packageExportsTypes(exports: unknown, files: Readonly<Record<string, Uint8Array>>, name: string): Result<{ root?: string; paths: Readonly<Record<string, string>> }> {
  if (!record(exports)) return refusal(`${name} has no typed package exports; add declarations`);
  const paths: Record<string, string> = {};
  for (const [key, value] of Object.entries(exports)) {
    if (!(key === "." || key.startsWith("./"))) continue;
    const runtime = exportTarget(exports, key);
    if (!runtime.ok || files[runtime.value] === undefined) return refusal(`${name} export ${key} has no built JavaScript target`);
    const candidate = record(value) ? value.types : undefined;
    if (typeof candidate !== "string" || !candidate.startsWith("./") || !candidate.endsWith(".d.ts")) return refusal(`${name} export ${key} has no declaration; add types`);
    const target = candidate.slice(2);
    if (!isSafeRelative(target) || files[target] === undefined) return refusal(`${name} export ${key} declaration ${target} is missing`);
    paths[key] = target;
  }
  if (Object.keys(paths).length === 0) return refusal(`${name} has no declaration exports`);
  return { ok: true, value: { ...(paths["."] === undefined ? {} : { root: paths["."] }), paths } };
}
function verifyDeclarationImports(
  node: LockNode,
  files: Readonly<Record<string, Uint8Array>>,
  boundedExportPaths: readonly string[],
  lock: PackLock,
  storeRoot: string,
): Result<void> {
  for (const [path, bytes] of Object.entries(files)) {
    if (!path.endsWith(".d.ts")) continue;
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { return refusal(`${node.name} declaration ${path} is not UTF-8`); }
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    if ((source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length > 0) return refusal(`${node.name} declaration ${path} has invalid TypeScript syntax`);
    const references = ts.preProcessFile(text, true, true);
    for (const imported of [...references.importedFiles, ...references.referencedFiles]) {
      const specifier = imported.fileName;
      if (specifier.startsWith("./") || specifier.startsWith("../")) {
        const target = posix.normalize(posix.join(posix.dirname(path), specifier));
        if (target.startsWith("../") || target === "..") return refusal(`${node.name} declaration ${path} escapes its package via ${specifier}`);
        const candidates = [target, target.replace(/\.js$/, ".d.ts"), `${target}.d.ts`, `${target}/index.d.ts`];
        if (!candidates.some((candidate) => files[candidate] !== undefined)) return refusal(`${node.name} declaration ${path} imports missing ${specifier}`);
        continue;
      }
      if (specifier === "bounded" || specifier.startsWith("bounded/")) {
        const exportPath = specifier === "bounded" ? "." : `.${specifier.slice("bounded".length)}`;
        if (!boundedExportPaths.includes(exportPath)) return refusal(`${node.name} declaration ${path} imports unavailable ${specifier}`);
        continue;
      }
      if (specifier.startsWith("node:")) continue;
      const parts = specifier.split("/");
      const dependencyName = specifier.startsWith("@") ? `${parts[0]}/${parts[1] ?? ""}` : parts[0];
      if (dependencyName === undefined) return refusal(`${node.name} declaration ${path} imports malformed ${specifier}`);
      const childId = dependencyName === node.name ? node.id : node.dependencies[dependencyName];
      if (childId === undefined) return refusal(`${node.name} declaration ${path} imports unpinned ${specifier}`);
      const child = lock.nodes[childId];
      if (child === undefined) return refusal(`${node.name} declaration ${path} imports missing pinned node ${childId}`);
      const exportPath = specifier === dependencyName ? "." : `.${specifier.slice(dependencyName.length)}`;
      try {
        const childRoot = join(storeRoot, child.sha256, "package");
        const raw: unknown = JSON.parse(readFileSync(join(childRoot, "package.json"), "utf8"));
        const entry = record(raw) && record(raw.exports) ? raw.exports[exportPath] : undefined;
        const types = record(entry) ? entry.types : undefined;
        if (typeof types !== "string" || !types.startsWith("./") || !types.endsWith(".d.ts") || !isSafeRelative(types.slice(2)))
          return refusal(`${node.name} declaration ${path} imports ${specifier}, which has no typed export`);
        const declaration = join(childRoot, types.slice(2));
        syncSafe(declaration);
        if (!existsSync(declaration) || !lstatSync(declaration).isFile())
          return refusal(`${node.name} declaration ${path} imports ${specifier}, whose declaration is missing`);
      } catch (error) { return refusal(`${node.name} declaration ${path} cannot verify ${specifier}: ${projectionError(error)}`); }
    }
    if (references.typeReferenceDirectives.length > 0) return refusal(`${node.name} declaration ${path} has ambient type references; bundle declarations into the package`);
  }
  return { ok: true, value: undefined };
}
function desiredProjection(input: ProjectionVerifyInput, lock: PackLock): Result<{ packages: readonly string[]; files: Readonly<Record<string, Uint8Array>> }> {
  let release: Readonly<Record<string, Uint8Array>>;
  try { release = releaseTypes(input); } catch (error) { return refusal(projectionError(error)); }
  const result: Record<string, Uint8Array> = {};
  const packages = new Set<string>();
  const put = (path: string, bytes: Uint8Array): void => { result[`node_modules/${path}`] = bytes; };
  for (const [name, bytes] of Object.entries(release)) if (name !== "index.d.ts") put(`bounded/${name}`, bytes);
  const boundedExports: Record<string, { types: string }> = {};
  const boundedVersions: Record<string, string[]> = {};
  for (const exportPath of input.boundedExportPaths) {
    const target = boundedTypeTargets[exportPath];
    if (target === undefined) continue; // Runtime-only exports have no editor declaration projection.
    const bytes = release[target];
    if (bytes === undefined) return refusal(`Verified release declaration ${target} for bounded${exportPath.slice(1)} is missing`);
    boundedExports[exportPath] = { types: `./${target}` };
    boundedVersions[exportPath.slice(2)] = [target];
  }
  if (Object.keys(boundedExports).length === 0) return refusal("Verified release has no supported Bounded declarations");
  packages.add("bounded");
  put("bounded/package.json", utf8(`${JSON.stringify({ name: "bounded", version: input.boundedVersion, exports: boundedExports, typesVersions: { "*": boundedVersions } })}\n`));
  const render = (id: string, path: string): Result<void> => {
    const node = lock.nodes[id];
    if (node === undefined) return refusal(`Projection package node ${id} is missing`);
    let stored: Readonly<Record<string, Uint8Array>>;
    try {
      const store = join(input.storeRoot, node.sha256, "package");
      stored = Object.fromEntries(Object.keys(fileSet(store))
        .map((name) => [name, readFileSync(join(store, name))]));
    } catch (error) { return refusal(`Projection cannot read verified ${id}: ${projectionError(error)}`); }
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder().decode(stored["package.json"])); } catch { return refusal(`${id} package.json is malformed`); }
    if (!record(raw)) return refusal(`${id} package.json is malformed`);
    const declarationImports = verifyDeclarationImports(node, stored, input.boundedExportPaths, lock, input.storeRoot);
    if (!declarationImports.ok) return declarationImports;
    const selected = packageExportsTypes(raw.exports, stored, node.name);
    if (!selected.ok) return selected;
    const versions: Record<string, string[]> = {};
    const exports: Record<string, { types: string }> = {};
    for (const [key, target] of Object.entries(selected.value.paths)) {
      exports[key] = { types: `./${target}` };
      if (key !== ".") versions[key.slice(2)] = [target];
    }
    packages.add(path);
    put(`${path}/package.json`, utf8(`${JSON.stringify({ name: node.name, version: node.version,
      ...(selected.value.root === undefined ? {} : { types: `./${selected.value.root}` }), exports, typesVersions: { "*": versions } })}\n`));
    for (const [name, bytes] of Object.entries(stored)) if (name.endsWith(".d.ts")) put(`${path}/${name}`, bytes);
    for (const [dependencyName, childId] of Object.entries(node.dependencies)) {
      const child = render(childId, `${path}/node_modules/${dependencyName}`);
      if (!child.ok) return child;
    }
    return { ok: true, value: undefined };
  };
  for (const [name, id] of Object.entries(lock.roots)) { const built = render(id, name); if (!built.ok) return built; }
  return { ok: true, value: { packages: ["bounded", ...Object.keys(lock.roots)].sort(), files: result } };
}
function receiptFor(lockContents: string, projection: { packages: readonly string[]; files: Readonly<Record<string, Uint8Array>> }): ProjectionReceipt {
  return { schema: "bounded-types-receipt/1", lockSha256: sha256(utf8(lockContents)), packages: projection.packages,
    files: Object.fromEntries(Object.entries(projection.files).map(([path, bytes]) => [path, sha256(bytes)])) };
}
function parseJournal(path: string): ProjectionJournal {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!record(raw) || raw.schema !== "bounded-types-journal/1" || !record(raw.oldPackages) || !record(raw.newFiles) || !Array.isArray(raw.newPackages)
    || typeof raw.stage !== "string" || !/^\.types-stage-[a-f0-9-]+$/.test(raw.stage)
    || (raw.oldLockBackup !== null && (typeof raw.oldLockBackup !== "string" || !/^\.types-old-lock-[a-f0-9-]+\.bak$/.test(raw.oldLockBackup)))
    || (raw.oldReceiptBackup !== null && (typeof raw.oldReceiptBackup !== "string" || !/^\.types-old-receipt-[a-f0-9-]+\.bak$/.test(raw.oldReceiptBackup)))
    || (raw.oldLockSha256 !== null && (typeof raw.oldLockSha256 !== "string" || !digestPattern.test(raw.oldLockSha256)))
    || (raw.oldReceiptSha256 !== null && (typeof raw.oldReceiptSha256 !== "string" || !digestPattern.test(raw.oldReceiptSha256)))
    || !raw.newPackages.every((name) => typeof name === "string" && isSafeRelative(name))) throw new Error("Projection journal is malformed");
  for (const [name, backup] of Object.entries(raw.oldPackages)) if (!isSafeRelative(name) || (backup !== null && (typeof backup !== "string" || !/^\.types-old-package-[a-f0-9-]+$/.test(backup)))) throw new Error("Projection journal package backup is malformed");
  for (const [name, hash] of Object.entries(raw.newFiles)) if (!isSafeRelative(name) || !name.startsWith("node_modules/") || typeof hash !== "string" || !digestPattern.test(hash)) throw new Error("Projection journal new file is malformed");
  return raw as unknown as ProjectionJournal;
}
function restoreJournal(projectRoot: string, faultAfterRecoveryStep?: string): void {
  const paths = projectionPaths(projectRoot);
  syncSafe(paths.journal);
  const journal = parseJournal(paths.journal);
  const backup = (name: string | null, hash: string | null): Uint8Array | null => {
    if (name === null) { if (hash !== null) throw new Error("Projection journal backup marker is malformed"); return null; }
    const path = join(paths.bounded, name);
    syncSafe(path);
    if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error(`Projection backup ${name} is missing`);
    const bytes = readFileSync(path);
    if (hash === null || sha256(bytes) !== hash) throw new Error(`Projection backup ${name} is corrupt`);
    return bytes;
  };
  const oldLock = backup(journal.oldLockBackup, journal.oldLockSha256);
  const oldReceipt = backup(journal.oldReceiptBackup, journal.oldReceiptSha256);
  const oldRecord = journal.oldReceiptBackup === null ? null : parseReceipt(join(paths.bounded, journal.oldReceiptBackup));
  if ((oldLock === null) !== (oldRecord === null)) throw new Error("Projection journal backup states disagree");
  if (oldLock !== null && oldRecord !== null && oldRecord.lockSha256 !== sha256(oldLock)) throw new Error("Projection receipt backup differs from lock backup");
  const oldNames = Object.entries(journal.oldPackages).filter(([, value]) => value !== null).map(([name]) => name).sort();
  if (JSON.stringify(oldNames) !== JSON.stringify([...(oldRecord?.packages ?? [])].sort())) throw new Error("Projection journal package backups differ from old receipt");
  const expectedFor = (files: Readonly<Record<string, string>>, name: string): Readonly<Record<string, string>> => {
    const prefix = `node_modules/${name}/`;
    return Object.fromEntries(Object.entries(files).filter(([path]) => path.startsWith(prefix)).map(([path, hash]) => [path.slice(prefix.length), hash]));
  };
  const sameFiles = (first: Readonly<Record<string, string>>, second: Readonly<Record<string, string>>): boolean =>
    JSON.stringify(Object.entries(first).sort()) === JSON.stringify(Object.entries(second).sort());
  for (const [name, backupName] of Object.entries(journal.oldPackages)) {
    if (backupName === null) continue;
    const path = join(paths.bounded, backupName);
    syncSafe(path);
    if (!existsSync(path) || !lstatSync(path).isDirectory()) throw new Error(`Projection backup ${backupName} is missing`);
    if (!exactTree(path, expectedFor(oldRecord?.files ?? {}, name))) throw new Error(`Projection backup ${backupName} is corrupt`);
  }
  // A crash can leave an old package, a fully published new package, or no package.
  // Anything else may be user-owned or tampered state and must not be removed.
  for (const name of new Set([...Object.keys(journal.oldPackages), ...journal.newPackages])) {
    const path = join(paths.modules, name);
    syncSafe(path);
    if (!existsSync(path)) continue;
    if (!lstatSync(path).isDirectory()) throw new Error(`Projection active package ${path} is not a directory`);
    const found = fileSet(path);
    const previous = expectedFor(oldRecord?.files ?? {}, name);
    const next = expectedFor(journal.newFiles, name);
    const oldOwned = journal.oldPackages[name] !== null;
    if ((!oldOwned || !sameFiles(found, previous) || !exactTree(path, previous)) && (!sameFiles(found, next) || !exactTree(path, next)))
      throw new Error(`Projection active package ${path} is unowned or differs from journal; repair before recovery`);
  }
  // Copy every old package into a new, owned staging tree first. A crash while
  // copying leaves the active tree untouched and the journal retryable.
  const restoreStage = join(paths.bounded, `.types-restore-${randomUUID()}`);
  mkdirSync(restoreStage, { recursive: true });
  let copiedFirstFile = false;
  for (const [name, backupName] of Object.entries(journal.oldPackages)) {
    if (backupName === null) continue;
    const staged = join(restoreStage, name);
    copyTree(join(paths.bounded, backupName), staged, () => {
      if (faultAfterRecoveryStep === "stage-restore" && !copiedFirstFile) {
        copiedFirstFile = true;
        throw new Error("Injected fault during staged restore");
      }
    });
    if (!exactTree(staged, expectedFor(oldRecord?.files ?? {}, name))) throw new Error(`Projection staged restore ${name} differs from backup`);
  }
  syncDirectory(restoreStage);
  const recoveryTrash = join(paths.bounded, `${journal.stage}-recovery-trash-${randomUUID()}`);
  let renamedFirstActive = false;
  for (const name of new Set([...Object.keys(journal.oldPackages), ...journal.newPackages])) {
    const path = join(paths.modules, name);
    syncSafe(path);
    if (!existsSync(path)) continue;
    const trashPath = join(recoveryTrash, name);
    mkdirSync(dirname(trashPath), { recursive: true });
    renameSync(path, trashPath);
    syncParentChain(path, paths.modules);
    syncParentChain(trashPath, paths.bounded);
    if (faultAfterRecoveryStep === "rename-active" && !renamedFirstActive) {
      renamedFirstActive = true;
      throw new Error("Injected fault after active projection rename");
    }
  }
  let restoredFirstOld = false;
  for (const [name, backupName] of Object.entries(journal.oldPackages)) {
    if (backupName === null) continue;
    const path = join(paths.modules, name);
    mkdirSync(dirname(path), { recursive: true });
    renameSync(join(restoreStage, name), path);
    syncParentChain(path, paths.modules);
    if (faultAfterRecoveryStep === "restore-old" && !restoredFirstOld) {
      restoredFirstOld = true;
      throw new Error("Injected fault after old projection restore");
    }
  }
  if (oldReceipt === null) { rmSync(paths.receipt, { force: true }); syncDirectory(paths.bounded); }
  else durableWrite(paths.receipt, oldReceipt);
  if (oldLock === null) { rmSync(paths.lock, { force: true }); syncDirectory(paths.bounded); }
  else durableWrite(paths.lock, oldLock);
  rmSync(paths.journal, { force: true });
  syncDirectory(paths.bounded);
  rmSync(recoveryTrash, { recursive: true, force: true });
  rmSync(join(paths.bounded, `${journal.stage}-old-trash`), { recursive: true, force: true });
  rmSync(restoreStage, { recursive: true, force: true });
  rmSync(join(paths.bounded, journal.stage), { recursive: true, force: true });
  for (const name of [journal.oldLockBackup, journal.oldReceiptBackup, ...Object.values(journal.oldPackages)])
    if (name !== null) rmSync(join(paths.bounded, name), { recursive: true, force: true });
}
function copyTree(source: string, target: string, afterCopiedFile?: () => void): void {
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(source)) {
    const from = join(source, name);
    const to = join(target, name);
    const info = lstatSync(from);
    if (info.isDirectory()) copyTree(from, to, afterCopiedFile);
    else if (info.isFile()) { copyFileSync(from, to); syncFile(to); afterCopiedFile?.(); }
    else throw new Error(`Projection backup ${from} contains a link or unsupported entry`);
  }
  syncDirectory(target);
  syncDirectory(dirname(target));
}

async function verifyProjectionState(input: ProjectionVerifyInput, allowOwnJournal: boolean, limits?: typeof runtimeGraphLimits): Promise<Result<ProjectionReceipt>> {
  const paths = projectionPaths(input.projectRoot);
  try {
    syncSafe(paths.journal);
    if (!allowOwnJournal && existsSync(paths.journal)) return refusal(`Projection journal ${paths.journal} requires recovery before hooks or check`);
    const lock = await verifyManagedPackLockDetailed(input, limits);
    if (!lock.ok) return lock;
    syncSafe(paths.receipt);
    const receipt = parseReceipt(paths.receipt);
    const lockBytes = readFileSync(paths.lock);
    verifyOwnedProjection(input, receipt, lockBytes);
    const desired = desiredProjection(input, lock.value.lock);
    if (!desired.ok) return desired;
    const expected = receiptFor(new TextDecoder().decode(lockBytes), desired.value);
    if (JSON.stringify(expected) !== JSON.stringify(receipt)) return refusal("Projection receipt differs from verified lock, store or release declarations");
    return { ok: true, value: receipt };
  } catch (error) { return refusal(`Cannot verify projection: ${projectionError(error)}`); }
}

/** Read-only verification used by future hooks and check. It never contacts the registry. */
export async function verifyManagedPackProjection(input: ProjectionVerifyInput): Promise<Result<ProjectionReceipt>> {
  return verifyProjectionState(input, false);
}

export interface ManagedPackRuntimeNode {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly exports: unknown;
  readonly files: Readonly<Record<string, Uint8Array>>;
  readonly catalogue: (ReturnType<typeof PackageCatalog.parse> extends Result<infer T> ? T : never) | null;
}
export interface ManagedPackRuntimeGraph {
  readonly roots: Readonly<Record<string, string>>;
  readonly nodes: Readonly<Record<string, ManagedPackRuntimeNode>>;
  readonly recheckBoundary: () => Promise<Result<void>>;
}

/** Copy verified bytes once; the loader never returns to the mutable store for module code. */
export async function captureManagedPackRuntimeGraph(input: ProjectionVerifyInput): Promise<Result<ManagedPackRuntimeGraph>> {
  const paths = projectionPaths(input.projectRoot);
  const projected = await verifyProjectionState(input, false, runtimeGraphLimits);
  if (!projected.ok) return projected;
  let firstLock: Uint8Array;
  let firstReceipt: Uint8Array;
  try { firstLock = readFileSync(paths.lock); firstReceipt = readFileSync(paths.receipt); }
  catch (error) { return refusal(`Cannot snapshot managed pack state: ${projectionError(error)}`); }
  const verified = await verifyManagedPackLockDetailed(input, runtimeGraphLimits);
  if (!verified.ok) return verified;
  if (sha256(verified.value.lockBytes) !== sha256(firstLock) || projected.value.lockSha256 !== sha256(firstLock))
    return refusal("Managed pack lock changed between projection and byte capture; retry after the add completes");
  try {
    if (JSON.stringify(parseReceiptBytes(firstReceipt)) !== JSON.stringify(projected.value))
      return refusal("Managed pack receipt changed between projection and byte capture; retry after the add completes");
  } catch (error) { return refusal(`Managed pack receipt changed during byte capture: ${projectionError(error)}`); }
  if (Object.keys(verified.value.lock.nodes).length > 128) return refusal("Managed pack graph exceeds 128 pinned nodes; reduce the dependency closure");
  const nodes: Record<string, ManagedPackRuntimeNode> = {};
  let totalBytes = 0;
  let totalFiles = 0;
  for (const [id, data] of verified.value.stored) {
    const node = verified.value.lock.nodes[id];
    if (node === undefined) return refusal(`Managed pack graph lost node ${id}; re-add the pack`);
    const files: Record<string, Uint8Array> = {};
    for (const [name, bytes] of Object.entries(data.files)) {
      totalFiles++;
      totalBytes += bytes.byteLength;
      if (totalFiles > 20_000 || totalBytes > 256 * 1024 * 1024) return refusal("Managed pack graph exceeds the total file or byte bound; reduce the dependency closure");
      files[name] = Uint8Array.from(bytes);
    }
    let catalogue: ManagedPackRuntimeNode["catalogue"] = null;
    if (data.manifest.bounded !== undefined) {
      const parsedManifest = PackageManifest.parse({ name: node.name, version: node.version, bounded: data.manifest.bounded });
      if (!parsedManifest.ok) return refusal(`${id} has invalid pack manifest: ${parsedManifest.error}`);
      const catalogueBytes = files[parsedManifest.value.catalogPath];
      if (catalogueBytes === undefined) return refusal(`${id} has no locked catalogue`);
      const parsed = json(catalogueBytes, `${id} catalogue`);
      if (!parsed.ok) return parsed;
      const selected = PackageCatalog.parse(parsed.value);
      if (!selected.ok) return selected;
      catalogue = selected.value;
    }
    nodes[id] = { id, name: node.name, version: node.version, dependencies: node.dependencies, exports: data.manifest.exports, files, catalogue };
  }
  const lockSha256 = sha256(firstLock);
  const receiptSha256 = sha256(firstReceipt);
  const recheckBoundary = async (): Promise<Result<void>> => {
    try {
      syncSafe(paths.journal);
      if (existsSync(paths.journal)) return refusal("A managed pack projection journal is pending; recover the add before loading packs");
      syncSafe(paths.lock); syncSafe(paths.receipt);
      if (!lstatSync(paths.lock).isFile() || !lstatSync(paths.receipt).isFile()
        || sha256(readFileSync(paths.lock)) !== lockSha256 || sha256(readFileSync(paths.receipt)) !== receiptSha256)
        return refusal("Managed pack lock or receipt changed while loading; retry after the add completes");
      return { ok: true, value: undefined };
    } catch (error) { return refusal(`Cannot recheck managed pack boundary: ${projectionError(error)}`); }
  };
  const boundary = await recheckBoundary();
  if (!boundary.ok) return boundary;
  return { ok: true, value: { roots: verified.value.lock.roots, nodes, recheckBoundary } };
}

/** Rolls back any journaled partial publication under the same project writer. */
export async function recoverManagedPackProjection(input: ProjectionVerifyInput & { readonly faultAfterRecoveryStep?: string }): Promise<Result<unknown>> {
  const paths = projectionPaths(input.projectRoot);
  const writer = await acquireProjectWriter(paths.lock);
  if (!writer.ok) return writer;
  try {
    let restoredEmpty = false;
    if (existsSync(paths.journal)) {
      const journal = parseJournal(paths.journal);
      restoredEmpty = journal.oldLockBackup === null && journal.oldReceiptBackup === null;
      restoreJournal(input.projectRoot, input.faultAfterRecoveryStep);
    }
    if (restoredEmpty && !existsSync(paths.lock) && !existsSync(paths.receipt)) return { ok: true, value: undefined };
    return await verifyManagedPackProjection(input);
  } catch (error) { return refusal(`Cannot recover projection journal or backup: ${projectionError(error)}`); }
  finally { await writer.value(); }
}

/** Prepare and validate under one writer, then publish the projection, receipt and lock. */
export async function addManagedPackWithProjection(input: ProjectionInput): Promise<Result<{ readonly lockPath: string; readonly receiptPath: string; readonly catalogueImports: readonly CatalogueImport[] }>> {
  const paths = projectionPaths(input.projectRoot);
  const writer = await acquireProjectWriter(paths.lock);
  if (!writer.ok) return writer;
  try {
    if (existsSync(paths.journal)) restoreJournal(input.projectRoot);
    let oldReceipt: ProjectionReceipt | null = null;
    let oldLockBytes: Uint8Array | null = null;
    if (existsSync(paths.lock)) {
      const checked = await verifyManagedPackProjection(input);
      if (!checked.ok) return checked;
      oldReceipt = checked.value;
      oldLockBytes = readFileSync(paths.lock);
    }
    await input.afterExistingStateVerified?.(oldLockBytes === null ? null : sha256(oldLockBytes));
    const prepared = await prepareAdditionUnderWriter(input, false, true);
    if (!prepared.ok) return prepared;
    const bounded = await checkProposedRuntimeGraphBounds(prepared.value.lock, prepared.value.contents, input.storeRoot);
    if (!bounded.ok) return bounded;
    const desired = desiredProjection(input, prepared.value.lock);
    if (!desired.ok) return desired;
    const newReceipt = receiptFor(prepared.value.contents, desired.value);
    const oldPackages = oldReceipt?.packages ?? [];
    const allPackages = [...new Set([...oldPackages, ...desired.value.packages])].sort();
    for (const name of allPackages) {
      const path = join(paths.modules, name);
      if (!oldPackages.includes(name)) {
        try { if (lstatSync(path).isSymbolicLink()) return refusal(`Unowned package collision at ${path}; move the link manually`); } catch { /* Absent path is available. */ }
      }
      syncSafe(path);
      if (existsSync(path) && !oldPackages.includes(name)) return refusal(`Unowned package collision at ${path}; move it manually before adding a managed pack`);
      if (!existsSync(path) && oldPackages.includes(name)) return refusal(`Owned projection package ${path} is missing`);
    }
    const stageName = `.types-stage-${randomUUID()}`;
    const stage = join(paths.bounded, stageName);
    mkdirSync(stage, { recursive: true });
    for (const [path, bytes] of Object.entries(desired.value.files)) {
      const target = join(stage, path);
      durableWrite(target, bytes);
    }
    syncDirectoryTree(stage);
    syncDirectory(paths.bounded);
    const backupLock = oldLockBytes === null ? null : `.types-old-lock-${randomUUID()}.bak`;
    const backupReceipt = oldReceipt === null ? null : `.types-old-receipt-${randomUUID()}.bak`;
    if (backupLock !== null && oldLockBytes !== null) durableWrite(join(paths.bounded, backupLock), oldLockBytes);
    if (backupReceipt !== null) durableWrite(join(paths.bounded, backupReceipt), readFileSync(paths.receipt));
    const oldBackups: Record<string, string | null> = {};
    for (const name of allPackages) {
      if (!oldPackages.includes(name)) { oldBackups[name] = null; continue; }
      const backup = `.types-old-package-${randomUUID()}`;
      const source = join(paths.modules, name);
      copyTree(source, join(paths.bounded, backup));
      if (!exactTree(join(paths.bounded, backup), fileSet(source))) throw new Error(`Projection backup ${name} differs from the active package`);
      oldBackups[name] = backup;
    }
    if (input.faultAfter === "backup") return refusal("Injected fault after backup");
    const journal: ProjectionJournal = { schema: "bounded-types-journal/1", oldLockBackup: backupLock, oldLockSha256: oldLockBytes === null ? null : sha256(oldLockBytes),
      oldReceiptBackup: backupReceipt, oldReceiptSha256: backupReceipt === null ? null : sha256(readFileSync(paths.receipt)),
      oldPackages: oldBackups, newPackages: desired.value.packages, newFiles: newReceipt.files, stage: stageName };
    durableWrite(paths.journal, utf8(`${JSON.stringify(journal)}\n`));
    if (input.faultAfter === "journal") return refusal("Injected fault after journal");
    if (input.faultAfter === "journal-hang") await Bun.sleep(60_000);
    const oldTrash = join(paths.bounded, `${stageName}-old-trash`);
    for (const [index, name] of oldPackages.entries()) {
      const path = join(paths.modules, name);
      const trashPath = join(oldTrash, name);
      mkdirSync(dirname(trashPath), { recursive: true });
      renameSync(path, trashPath);
      syncParentChain(path, paths.modules);
      syncParentChain(trashPath, paths.bounded);
      if (input.faultAfter === "rename-old" && index === 0) return refusal("Injected fault after old projection rename");
    }
    for (const [index, name] of desired.value.packages.entries()) {
      const source = join(stage, "node_modules", name);
      const target = join(paths.modules, name);
      mkdirSync(dirname(target), { recursive: true });
      renameSync(source, target);
      syncParentChain(target, paths.modules);
      if (input.faultAfter === (index === 0 ? "publish-a" : "publish-b")) return refusal("Injected fault after projection rename");
    }
    durableWrite(paths.receipt, utf8(`${JSON.stringify(newReceipt)}\n`));
    if (input.faultAfter === "receipt") return refusal("Injected fault after receipt publication");
    durableWrite(paths.lock, utf8(prepared.value.contents));
    if (input.faultAfter === "lock") return refusal("Injected fault after lock publication");
    // The writer owns the still-present journal. Recheck the complete lock,
    // store, release source, receipt, and active tree before retiring rollback.
    const verified = await verifyProjectionState(input, true);
    if (!verified.ok) throw new Error(verified.error);
    rmSync(paths.journal);
    syncDirectory(paths.bounded);
    if (input.faultAfter === "journal-removal") return refusal("Injected fault after journal removal");
    rmSync(oldTrash, { recursive: true, force: true });
    rmSync(stage, { recursive: true, force: true });
    for (const backup of [backupLock, backupReceipt, ...Object.values(oldBackups)]) if (backup !== null) rmSync(join(paths.bounded, backup), { recursive: true, force: true });
    if (input.faultAfter === "backup-cleanup") return refusal("Injected fault after backup cleanup");
    return { ok: true, value: { lockPath: paths.lock, receiptPath: paths.receipt, catalogueImports: prepared.value.catalogueImports } };
  } catch (error) {
    if (existsSync(paths.journal)) {
      try { restoreJournal(input.projectRoot); }
      catch (recoveryError) { return refusal(`Cannot publish projection: ${projectionError(error)}; recovery requires repair: ${projectionError(recoveryError)}`); }
    }
    return refusal(`Cannot publish projection: ${projectionError(error)}`);
  } finally { await writer.value(); }
}
