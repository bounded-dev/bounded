import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse, posix, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { parse as parseJavaScript } from "acorn";
import { packageExportsResolve } from "bounded/adapters";
import { PackageCatalog, PackageManifest } from "bounded/domain";
import tar from "tar-stream";

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
  readonly dependencies: Readonly<Record<string, string>>;
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
  return { ok: true, value: { name: expected.name, version: expected.version, dependencies: dependencies.value, peerDependencies: peers.value, exports: parsed.value.exports,
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
    if (files[target.value] === undefined) return refusal(`${manifest.name} export ${pack.exportPath} points to missing built JavaScript ${target.value}`);
  }
  return { ok: true, value: undefined };
}

function inventory(files: Readonly<Record<string, Uint8Array>>): FileInventory {
  return Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, { size: bytes.byteLength, sha256: sha256(bytes) }]));
}

async function verifiedStore(path: string, expected: FileInventory): Promise<boolean> {
  try {
    const raw = JSON.parse(await readFile(join(path, "inventory.json"), "utf8")) as unknown;
    if (!record(raw) || JSON.stringify(raw.files) !== JSON.stringify(expected)) return false;
    const found = await filesRecursively(path);
    if (found.length !== Object.keys(expected).length + 1) return false;
    for (const [name, details] of Object.entries(expected)) {
      const file = join(path, "package", name);
      const info = await stat(file);
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

async function publishStore(storeRoot: string, digest: string, files: Readonly<Record<string, Uint8Array>>, expected: FileInventory): Promise<Result<void>> {
  const finalPath = join(storeRoot, digest);
  const safe = await noLinkedComponents(finalPath);
  if (!safe.ok) return safe;
  if (existsSync(finalPath)) return await verifiedStore(finalPath, expected) ? { ok: true, value: undefined } : refusal(`Stored package ${digest} fails inventory verification`);
  await mkdir(storeRoot, { recursive: true });
  const stage = join(storeRoot, `.staging-${randomUUID()}`);
  await mkdir(stage);
  try {
    for (const [name, content] of Object.entries(files)) {
      const path = join(stage, "package", name);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, content, { flag: "wx" });
    }
    await writeFile(join(stage, "inventory.json"), `${JSON.stringify({ schema: "bounded-pack-inventory/1", files: expected })}\n`, { flag: "wx" });
    if (!await verifiedStore(stage, expected)) return refusal(`Staged package ${digest} fails inventory verification`);
    try { await rename(stage, finalPath); }
    catch (error) {
      if (!existsSync(finalPath) || !await verifiedStore(finalPath, expected)) return refusal(`Cannot publish stored package ${digest}: ${errorText(error)}`);
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

/** Installs the verified npm-compatible artifact graph without running a package manager or package scripts. */
export async function installManagedPack(input: InstallInput): Promise<Result<{ readonly lockPath: string }>> {
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
      const stored = await publishStore(input.storeRoot, digest, extracted.value, fileInventory);
      if (!stored.ok) return stored;
      nodes[id] = { id, name, version: version.version, tarballUrl: downloaded.value.url,
        integrity: version.dist.integrity ?? null, sha256: digest, dependencies: edges };
      installed.set(identity, { id, peers: manifest.value.peerDependencies });
      installedExports.set(id, { exports: manifest.value.exports, files: extracted.value });
      return { ok: true, value: id };
    } finally { visiting.delete(identity); }
  };
  try {
    const root = await add(request.value.name, request.value.version, true, { bounded: input.boundedVersion });
    if (!root.ok) return root;
    const lockPath = join(input.projectRoot, ".bounded", "packs.lock.json");
    const safeLock = await noLinkedComponents(lockPath);
    if (!safeLock.ok) return safeLock;
    const contents = `${JSON.stringify({ schema: "bounded-packs-lock/1", boundedVersion: input.boundedVersion,
      root: root.value, nodes }, null, 2)}\n`;
    try { await (input.publishLock ?? atomicLock)(lockPath, contents); }
    catch (error) { return refusal(`Cannot publish project lock: ${errorText(error)}`); }
    return { ok: true, value: { lockPath } };
  } catch (error) { return refusal(`Cannot install ${input.request}: ${errorText(error)}`); }
}
