import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installManagedPack } from "./managed-pack-installer.ts";
import * as managedPackInstaller from "./managed-pack-installer.ts";
import { catalogue, manifest, packageArchive, packageEntries, sha256, sha512Integrity, type TarEntry } from "./managed-pack-artifact.test-support.ts";

type Reply = { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: Uint8Array };
type InstallResult = { readonly ok: true; readonly value: { readonly lockPath: string } } | { readonly ok: false; readonly error: string };
type Install = (input: {
  readonly request: string;
  readonly boundedVersion: string;
  readonly boundedExportPaths: readonly string[];
  readonly registryUrl: string;
  readonly projectRoot: string;
  readonly storeRoot: string;
  readonly get: (url: string) => Promise<Reply>;
  /** File-port fault seam: production writes the lock atomically only after all store entries are verified. */
  readonly publishLock?: (path: string, contents: string) => Promise<void>;
  /** Test seam after the existing lock has been fully verified, before publishing a replacement. */
  readonly afterExistingLockVerified?: (lockSha256: string) => Promise<void>;
}) => Promise<InstallResult>;

const install: Install = installManagedPack;
type VerifyResult = { readonly ok: true; readonly value: { readonly roots: Readonly<Record<string, string>> } } | { readonly ok: false; readonly error: string };
type Verify = (input: { readonly boundedVersion: string; readonly boundedExportPaths: readonly string[]; readonly projectRoot: string; readonly storeRoot: string }) => Promise<VerifyResult>;
// The verifier is the missing production seam under test; this cast keeps the red commit test-only and typecheckable.
const verify: Verify = (managedPackInstaller as unknown as { readonly verifyManagedPackLock: Verify }).verifyManagedPackLock;

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const JSON_REPLY = { "content-type": "application/json" };
const TAR_REPLY = { "content-type": "application/octet-stream" };
const REGISTRY = "https://registry.example.test";
const tarUrl = (name: string, version: string): string => `${REGISTRY}/${name}/-/${name}-${version}.tgz`;

interface PublishedPackage {
  readonly name: string;
  readonly version: string;
  readonly entries?: readonly TarEntry[];
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly integrity?: string;
  readonly url?: string;
}

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true }); });

function fixture(published: readonly PublishedPackage[] = [{ name: "bounded-example", version: "1.0.0" }]) {
  const root = mkdtempSync(join(tmpdir(), "bounded-managed-pack-red-"));
  directories.push(root);
  const projectRoot = join(root, "project");
  const storeRoot = join(root, "store");
  const replies = new Map<string, Reply>();
  const metadataByName = new Map<string, Record<string, unknown>>();
  const calls: string[] = [];
  for (const item of published) {
    const entries = item.entries ?? packageEntries({ ...manifest(item.name, item.version),
      ...(item.dependencies === undefined ? {} : { dependencies: item.dependencies }),
      ...(item.peerDependencies === undefined ? {} : { peerDependencies: item.peerDependencies }),
      ...(item.scripts === undefined ? {} : { scripts: item.scripts }),
    }, catalogue(item.name, item.version));
    const archive = packageArchive(entries);
    const url = item.url ?? tarUrl(item.name, item.version);
    const versions = metadataByName.get(item.name) ?? {};
    versions[item.version] = { name: item.name, version: item.version,
      dependencies: item.dependencies ?? {}, peerDependencies: item.peerDependencies ?? (item.name === "bounded-example" ? { bounded: "~3.3.0" } : {}),
      dist: { tarball: url, integrity: item.integrity ?? sha512Integrity(archive) },
    };
    metadataByName.set(item.name, versions);
    replies.set(url, { status: 200, headers: TAR_REPLY, body: archive });
  }
  for (const [name, versions] of metadataByName) replies.set(`${REGISTRY}/${name}`, { status: 200, headers: JSON_REPLY, body: utf8(JSON.stringify({ name, versions })) });
  const get = async (url: string): Promise<Reply> => {
    calls.push(url);
    return replies.get(url) ?? { status: 404, headers: JSON_REPLY, body: utf8("missing") };
  };
  const run = (request = "bounded-example@1.0.0", publishLock?: (path: string, contents: string) => Promise<void>, afterExistingLockVerified?: (lockSha256: string) => Promise<void>) => install({ request, boundedVersion: "3.3.0", boundedExportPaths: ["./domain", "./application"], registryUrl: REGISTRY, projectRoot, storeRoot, get, ...(publishLock === undefined ? {} : { publishLock }), ...(afterExistingLockVerified === undefined ? {} : { afterExistingLockVerified }) });
  const lockPath = join(projectRoot, ".bounded", "packs.lock.json");
  const verifyInstalled = () => verify({ boundedVersion: "3.3.0", boundedExportPaths: ["./domain", "./application"], projectRoot, storeRoot });
  return { root, projectRoot, storeRoot, replies, calls, get, run, lockPath, verifyInstalled };
}

const refused = async (run: () => Promise<InstallResult>, phrase: string): Promise<string> => {
  const result = await run();
  expect(result.ok).toBe(false);
  if (result.ok) return "";
  expect(result.error.toLowerCase()).toContain(phrase.toLowerCase());
  return result.error;
};

const verifyRefused = async (run: () => Promise<VerifyResult>, phrase: string): Promise<void> => {
  const result = await run();
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.toLowerCase()).toContain(phrase.toLowerCase());
};

const pack = (name: string, version = "1.0.0"): PublishedPackage => ({ name, version, peerDependencies: { bounded: "~3.3.0" } });
const readLock = (path: string): { schema: string; boundedVersion: string; roots: Record<string, string>; nodes: Record<string, { id: string; name: string; version: string; sha256: string; inventorySha256: string; dependencies: Record<string, string> }> } => JSON.parse(readFileSync(path, "utf8"));
const writeLock = (path: string, lock: unknown): void => writeFileSync(path, `${JSON.stringify(lock, null, 2)}\n`);

const filesUnder = (root: string): string[] => existsSync(root)
  ? readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  })
  : [];

const plainPackageEntries = (name: string, version: string, dependencies: Readonly<Record<string, string>> = {}): TarEntry[] => [
  { name: "package/package.json", body: JSON.stringify({ name, version, type: "module", exports: { ".": "./index.js" }, dependencies }) },
  { name: "package/index.js", body: `export const version = ${JSON.stringify(version)};\n` },
];

const plainPackageWithPeers = (name: string, version: string, peers: Readonly<Record<string, string>>): TarEntry[] => [
  { name: "package/package.json", body: JSON.stringify({ name, version, type: "module", exports: { ".": "./index.js" }, peerDependencies: peers }) },
  { name: "package/index.js", body: "export const value = 1;\n" },
];

describe("managed published pack artifact, lock and store contract", () => {
  test("installs one exact version with registry integrity, inventory binding, complete file hashes and a plural-root atomic lock", async () => {
    const given = fixture();
    const result = await given.run();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lockPath).toBe(given.lockPath);
    const lock = JSON.parse(readFileSync(given.lockPath, "utf8")) as Record<string, unknown>;
    expect(lock.schema).toBe("bounded-packs-lock/2");
    const roots = lock.roots as Record<string, string>;
    const nodes = lock.nodes as Record<string, { inventorySha256: string }>;
    expect(Object.keys(roots)).toEqual(["bounded-example"]);
    const rootId = roots["bounded-example"];
    expect(rootId).toBeDefined();
    if (rootId === undefined) return;
    const node = nodes[rootId];
    expect(node).toBeDefined();
    expect(JSON.stringify(lock)).toContain("bounded-example");
    expect(JSON.stringify(lock)).toContain("1.0.0");
    const archive = given.replies.get(tarUrl("bounded-example", "1.0.0"))?.body;
    expect(archive).toBeDefined();
    if (archive === undefined) return;
    expect(JSON.stringify(lock)).toContain(sha256(archive));
    expect(JSON.stringify(lock)).toContain(sha512Integrity(archive));
    const storeFiles = filesUnder(given.storeRoot);
    const inventoryPath = storeFiles.find((path) => path.endsWith("inventory.json"));
    expect(inventoryPath).toBeDefined();
    if (inventoryPath === undefined) return;
    expect(node?.inventorySha256).toBe(sha256(readFileSync(inventoryPath)));
    expect(storeFiles.some((path) => path.endsWith("dist/index.js"))).toBe(true);
    expect(storeFiles.some((path) => readFileSync(path).includes(sha256(utf8("export const refusedToolsPack = {};\n"))))).toBe(true);
  });

  test("rejects ranges and missing versions before publishing a lock", async () => {
    const given = fixture();
    await refused(() => given.run("bounded-example@^1.0.0"), "version");
    await refused(() => given.run("bounded-example@2.0.0"), "2.0.0");
    expect(existsSync(given.lockPath)).toBe(false);
  });

  test("rejects a wrong registry SHA-512 and leaves the prior lock untouched", async () => {
    const given = fixture([{ name: "bounded-example", version: "1.0.0", integrity: `sha512-${"A".repeat(88)}` }]);
    mkdirSync(join(given.projectRoot, ".bounded"), { recursive: true });
    writeFileSync(given.lockPath, "prior lock\n", { flag: "wx" });
    await refused(given.run, "integrity");
    expect(readFileSync(given.lockPath, "utf8")).toBe("prior lock\n");
  });

  test("a late lock publication failure preserves the previous lock after the new store entry is verified", async () => {
    const given = fixture([{ name: "bounded-example", version: "1.0.0" }, { name: "bounded-example", version: "1.0.1" }]);
    const first = await given.run();
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const previousLock = readFileSync(given.lockPath, "utf8");
    const previousFiles = filesUnder(given.storeRoot);
    const nextArchive = given.replies.get(tarUrl("bounded-example", "1.0.1"))?.body;
    expect(nextArchive).toBeDefined();
    if (nextArchive === undefined) return;
    let reachedLockPublication = false;
    await refused(() => given.run("bounded-example@1.0.1", async (path, contents) => {
      reachedLockPublication = true;
      expect(path).toBe(given.lockPath);
      expect(contents).toContain(sha256(nextArchive));
      const stored = filesUnder(given.storeRoot);
      expect(stored.length).toBeGreaterThan(previousFiles.length);
      expect(stored.some((file) => file.endsWith("package.json") && readFileSync(file, "utf8").includes('"version":"1.0.1"'))).toBe(true);
      expect(stored.some((file) => readFileSync(file).includes(sha256(utf8("export const refusedToolsPack = {};\n"))))).toBe(true);
      throw new Error("injected lock write failure");
    }), "injected lock write failure");
    expect(reachedLockPublication).toBe(true);
    expect(readFileSync(given.lockPath, "utf8")).toBe(previousLock);
  });

  test("rejects HTTP metadata, tarball URLs and every redirect downgrade", async () => {
    const given = fixture();
    given.replies.set(`${REGISTRY}/bounded-example`, { status: 302, headers: { location: "http://registry.example.test/package" }, body: new Uint8Array() });
    await refused(given.run, "https");
    expect(given.calls).not.toContain("http://registry.example.test/package");
    expect(existsSync(given.lockPath)).toBe(false);

    const insecure = fixture([{ name: "bounded-example", version: "1.0.0", url: "http://registry.example.test/bounded-example.tgz" }]);
    await refused(insecure.run, "https");
    expect(insecure.calls).not.toContain("http://registry.example.test/bounded-example.tgz");
    expect(existsSync(insecure.lockPath)).toBe(false);

    const tarRedirect = fixture();
    tarRedirect.replies.set(tarUrl("bounded-example", "1.0.0"), { status: 302, headers: { location: "http://cdn.example.test/archive.tgz" }, body: new Uint8Array() });
    await refused(tarRedirect.run, "https");
    expect(tarRedirect.calls).not.toContain("http://cdn.example.test/archive.tgz");
    expect(existsSync(tarRedirect.lockPath)).toBe(false);
  });

  test("rejects path escape, absolute entry, link and case-fold collision before publishing", async () => {
    const cases: readonly [readonly TarEntry[], string][] = [
      [[...packageEntries(), { name: "package/../outside.js", body: "x" }], "path"],
      [[...packageEntries(), { name: "/outside.js", body: "x" }], "path"],
      [[...packageEntries(), { name: "package/escape", type: "symlink", linkName: "../../outside" }], "link"],
      [[...packageEntries(), { name: "package/escape", type: "hardlink", linkName: "package/dist/index.js" }], "link"],
      [[...packageEntries(), { name: "package/dist/index.js", body: "different" }], "duplicate"],
      [[...packageEntries(), { name: "package/DIST/index.js", body: "different" }], "collision"],
      [[...packageEntries(), { name: "package/device", type: "character" }], "type"],
    ];
    for (const [entries, phrase] of cases) {
      const given = fixture([{ name: "bounded-example", version: "1.0.0", entries }]);
      await refused(given.run, phrase);
      expect(existsSync(given.lockPath)).toBe(false);
    }
  });

  test("requires built JavaScript in the published Node import export and a matching versioned catalogue", async () => {
    const missingJs = packageEntries().filter((entry) => entry.name !== "package/dist/index.js");
    const sourceOnly = packageEntries({ ...manifest(), exports: { ".": { bun: "./packs/refused-tools/index.ts" } } });
    const wrongVersion = packageEntries(manifest(), catalogue("bounded-example", "9.9.9"));
    const malformed = packageEntries(manifest(), { ...catalogue(), catalogVersion: 2 });
    for (const [entries, phrase] of [[missingJs, "export"], [sourceOnly, "import"], [wrongVersion, "catalog"], [malformed, "catalog"]] as const) {
      const given = fixture([{ name: "bounded-example", version: "1.0.0", entries }]);
      await refused(given.run, phrase);
      expect(existsSync(given.lockPath)).toBe(false);
    }
  });

  test("refuses a CommonJS catalogue pack export before publishing the lock", async () => {
    const packageManifest = { ...manifest(), exports: { ".": { import: "./dist/index.cjs" } } };
    const entries = packageEntries(packageManifest).map((entry) => entry.name === "package/dist/index.js"
      ? { ...entry, name: "package/dist/index.cjs", body: "module.exports = { selectedPack: {} };\n" }
      : entry);
    const given = fixture([{ name: "bounded-example", version: "1.0.0", entries }]);
    const result = await given.run();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("ESM");
    expect(existsSync(given.lockPath)).toBe(false);
  });

  test("refuses a .js catalogue pack export when package type is CommonJS", async () => {
    const entries = packageEntries({ ...manifest(), type: "commonjs" });
    const given = fixture([{ name: "bounded-example", version: "1.0.0", entries }]);
    await refused(given.run, "ESM");
    expect(existsSync(given.lockPath)).toBe(false);
  });

  test("a null Node import condition blocks a later default target", async () => {
    const entries = packageEntries({ ...manifest(), exports: { ".": { import: null, default: "./dist/index.js" } } });
    const given = fixture([{ name: "bounded-example", version: "1.0.0", entries }]);
    await refused(given.run, "export");
    expect(existsSync(given.lockPath)).toBe(false);
  });

  test("pins a complete dependency closure", async () => {
    const given = fixture([
      { name: "bounded-example", version: "1.0.0", dependencies: { "plain-helper": "1.0.0" } },
      { name: "plain-helper", version: "1.0.0", entries: [
        { name: "package/package.json", body: JSON.stringify({ name: "plain-helper", version: "1.0.0", type: "module", exports: { ".": "./index.js" } }) },
        { name: "package/index.js", body: "export default 1;\n" },
      ] },
    ]);
    const result = await given.run();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lock = readFileSync(given.lockPath, "utf8");
    expect(lock).toContain("plain-helper");
    expect(lock).toContain("1.0.0");
    expect(given.calls).toContain(`${REGISTRY}/plain-helper`);
    expect(given.calls).toContain(tarUrl("plain-helper", "1.0.0"));
  });

  test("keeps separate per-importer edges when two parents need different helper versions", async () => {
    const given = fixture([
      { name: "bounded-example", version: "1.0.0", dependencies: { "parent-a": "1.0.0", "parent-b": "1.0.0" } },
      { name: "parent-a", version: "1.0.0", dependencies: { "plain-helper": "1.0.0" }, entries: plainPackageEntries("parent-a", "1.0.0", { "plain-helper": "1.0.0" }) },
      { name: "parent-b", version: "1.0.0", dependencies: { "plain-helper": "2.0.0" }, entries: plainPackageEntries("parent-b", "1.0.0", { "plain-helper": "2.0.0" }) },
      { name: "plain-helper", version: "1.0.0", entries: plainPackageEntries("plain-helper", "1.0.0") },
      { name: "plain-helper", version: "2.0.0", entries: plainPackageEntries("plain-helper", "2.0.0") },
    ]);
    const result = await given.run();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lock = JSON.parse(readFileSync(given.lockPath, "utf8")) as { nodes: Record<string, { id?: string; name: string; version: string; dependencies: Record<string, string> }> };
    const nodes = Object.entries(lock.nodes).map(([key, node]) => ({ ...node, identity: node.id ?? key }));
    const only = (name: string, version: string) => {
      const matches = nodes.filter((node) => node.name === name && node.version === version);
      expect(matches).toHaveLength(1);
      return matches[0];
    };
    const parentA = only("parent-a", "1.0.0");
    const parentB = only("parent-b", "1.0.0");
    const helper1 = only("plain-helper", "1.0.0");
    const helper2 = only("plain-helper", "2.0.0");
    expect(parentA?.dependencies["plain-helper"]).toBe(helper1?.identity);
    expect(parentB?.dependencies["plain-helper"]).toBe(helper2?.identity);
    expect(parentA?.dependencies["plain-helper"]).not.toBe(parentB?.dependencies["plain-helper"]);
    expect(given.calls).toContain(tarUrl("plain-helper", "1.0.0"));
    expect(given.calls).toContain(tarUrl("plain-helper", "2.0.0"));
  });

  test("rejects a dependency peer missing from its consumer's resolved graph", async () => {
    const given = fixture([
      { name: "bounded-example", version: "1.0.0", dependencies: { "plain-helper": "1.0.0" } },
      { name: "plain-helper", version: "1.0.0", peerDependencies: { react: "^18.0.0" }, entries: plainPackageWithPeers("plain-helper", "1.0.0", { react: "^18.0.0" }) },
    ]);
    await refused(given.run, "react");
    expect(existsSync(given.lockPath)).toBe(false);
  });

  test("rejects an imported dependency subpath that the pinned package does not export", async () => {
    const rootEntries = packageEntries({ ...manifest(), dependencies: { "plain-helper": "1.0.0" } }).map((entry) => entry.name === "package/dist/index.js"
      ? { ...entry, body: 'import { version } from "plain-helper/missing"; export const refusedToolsPack = {};\n' }
      : entry);
    const given = fixture([
      { name: "bounded-example", version: "1.0.0", dependencies: { "plain-helper": "1.0.0" }, entries: rootEntries },
      { name: "plain-helper", version: "1.0.0", entries: plainPackageEntries("plain-helper", "1.0.0") },
    ]);
    await refused(given.run, "export");
    expect(existsSync(given.lockPath)).toBe(false);
  });

  test("rejects a bounded subpath absent from the executable's embedded exports", async () => {
    const rootEntries = packageEntries().map((entry) => entry.name === "package/dist/index.js"
      ? { ...entry, body: 'import "bounded/ghost"; export const refusedToolsPack = {};\n' }
      : entry);
    const given = fixture([{ name: "bounded-example", version: "1.0.0", entries: rootEntries }]);
    await refused(given.run, "bounded/ghost");
    expect(existsSync(given.lockPath)).toBe(false);
  });

  test("refuses linked store roots, linked digest entries and linked project lock directories", async () => {
    const linkedRoot = fixture();
    const outsideStore = join(linkedRoot.root, "outside-store");
    mkdirSync(outsideStore);
    symlinkSync(outsideStore, linkedRoot.storeRoot, "dir");
    await refused(linkedRoot.run, "link");
    expect(readdirSync(outsideStore)).toEqual([]);
    expect(existsSync(linkedRoot.lockPath)).toBe(false);

    const linkedDigest = fixture();
    const first = await linkedDigest.run();
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const priorLock = readFileSync(linkedDigest.lockPath, "utf8");
    const digest = (JSON.parse(priorLock) as { roots: Record<string, string> }).roots["bounded-example"]?.split("#")[1];
    expect(digest).toBeDefined();
    if (digest === undefined) return;
    const realStore = join(linkedDigest.root, "moved-store");
    renameSync(join(linkedDigest.storeRoot, digest), realStore);
    symlinkSync(realStore, join(linkedDigest.storeRoot, digest), "dir");
    await refused(linkedDigest.run, "link");
    expect(readFileSync(linkedDigest.lockPath, "utf8")).toBe(priorLock);

    const linkedProject = fixture();
    mkdirSync(linkedProject.projectRoot);
    const outsideLock = join(linkedProject.root, "outside-lock");
    mkdirSync(outsideLock);
    symlinkSync(outsideLock, join(linkedProject.projectRoot, ".bounded"), "dir");
    await refused(linkedProject.run, "link");
    expect(readdirSync(outsideLock)).toEqual([]);
  });

  test("rejects an incompatible Bounded peer, nested Bounded dependency and missing closure node", async () => {
    for (const [item, phrase] of [
      [{ name: "bounded-example", version: "1.0.0", peerDependencies: { bounded: "^4.0.0" } }, "bounded"],
      [{ name: "bounded-example", version: "1.0.0", dependencies: { bounded: "3.3.0" } }, "bounded"],
      [{ name: "bounded-example", version: "1.0.0", dependencies: { "missing-helper": "1.0.0" } }, "missing-helper"],
    ] as const) {
      const given = fixture([item]);
      await refused(given.run, phrase);
      expect(existsSync(given.lockPath)).toBe(false);
    }
  });

  test("rejects install lifecycle scripts, native addons and nonliteral dynamic imports in the closure", async () => {
    const scriptRoot = mkdtempSync(join(tmpdir(), "bounded-managed-pack-script-"));
    directories.push(scriptRoot);
    const sentinel = join(scriptRoot, "script-ran");
    for (const [item, phrase] of [
      [{ name: "bounded-example", version: "1.0.0", scripts: { postinstall: `touch ${sentinel}` } }, "postinstall"],
      [{ name: "bounded-example", version: "1.0.0", entries: [...packageEntries(), { name: "package/build/addon.node", body: "native" }] }, ".node"],
      [{ name: "bounded-example", version: "1.0.0", entries: packageEntries().map((entry) => entry.name === "package/dist/index.js" ? { ...entry, body: "export const refusedToolsPack = import(moduleName);\n" } : entry) }, "dynamic import"],
    ] as const) {
      const given = fixture([item]);
      await refused(given.run, phrase);
      expect(existsSync(given.lockPath)).toBe(false);
      expect(existsSync(sentinel)).toBe(false);
    }
  });
});

describe("managed pack offline verification and plural roots", () => {
  test("verifies an intact selected graph entirely offline, including the exact inventory bytes", async () => {
    const given = fixture([pack("bounded-example"), pack("bounded-second")]);
    expect((await given.run()).ok).toBe(true);
    expect((await given.run("bounded-second@1.0.0")).ok).toBe(true);
    given.calls.length = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error("offline verification contacted the network"); }) as unknown as typeof fetch;
    let result: VerifyResult;
    try { result = await given.verifyInstalled(); }
    finally { globalThis.fetch = originalFetch; }
    expect(result.ok).toBe(true);
    if (result.ok) expect(Object.keys(result.value.roots).sort()).toEqual(["bounded-example", "bounded-second"]);
    expect(given.calls).toEqual([]);
  });

  test("a lock node must bind inventory.json exact bytes with a valid SHA-256", async () => {
    for (const replacement of [undefined, "invalid", "0".repeat(64)]) {
      const given = fixture();
      expect((await given.run()).ok).toBe(true);
      const lock = readLock(given.lockPath);
      const root = lock.roots["bounded-example"];
      expect(root).toBeDefined();
      if (root === undefined) continue;
      const node = lock.nodes[root];
      expect(node).toBeDefined();
      if (node === undefined) continue;
      if (replacement === undefined) delete (node as Partial<typeof node>).inventorySha256;
      else node.inventorySha256 = replacement;
      writeLock(given.lockPath, lock);
      await verifyRefused(given.verifyInstalled, "inventory");
    }
  });

  test("refuses mutated inventory, changed, missing or extra package files, and a linked file", async () => {
    for (const mutation of ["inventory", "changed", "missing", "extra", "link"] as const) {
      const given = fixture();
      expect((await given.run()).ok).toBe(true);
      const root = readLock(given.lockPath).roots["bounded-example"];
      expect(root).toBeDefined();
      if (root === undefined) continue;
      const digest = root.split("#")[1];
      expect(digest).toBeDefined();
      if (digest === undefined) continue;
      const stored = join(given.storeRoot, digest);
      const js = join(stored, "package", "dist", "index.js");
      if (mutation === "inventory") writeFileSync(join(stored, "inventory.json"), `${readFileSync(join(stored, "inventory.json"), "utf8")} `);
      if (mutation === "changed") writeFileSync(js, "export const refusedToolsPack = { changed: true };\n");
      if (mutation === "missing") rmSync(js);
      if (mutation === "extra") writeFileSync(join(stored, "package", "extra.js"), "extra\n");
      if (mutation === "link") { writeFileSync(join(given.root, "outside.js"), "outside\n"); rmSync(js); symlinkSync(join(given.root, "outside.js"), js); }
      await verifyRefused(given.verifyInstalled, mutation === "link" ? "link" : "bounded-example");
    }
  });

  test("offline verification refuses linked store and project path components even when their targets exist", async () => {
    for (const boundary of ["store", "project"] as const) {
      const given = fixture();
      expect((await given.run()).ok).toBe(true);
      if (boundary === "store") {
        const outside = join(given.root, "real-store");
        renameSync(given.storeRoot, outside);
        symlinkSync(outside, given.storeRoot, "dir");
      } else {
        const bounded = join(given.projectRoot, ".bounded");
        const outside = join(given.root, "real-bounded");
        renameSync(bounded, outside);
        symlinkSync(outside, bounded, "dir");
      }
      await verifyRefused(given.verifyInstalled, "link");
    }
  });

  test("refuses missing graph nodes, wrong dependency edges, duplicate identities and Bounded version mismatch", async () => {
    const variants = ["missing", "edge", "duplicate", "version"] as const;
    for (const variant of variants) {
      const given = fixture([
        { ...pack("bounded-example"), dependencies: { "plain-helper": "1.0.0" } },
        { name: "plain-helper", version: "1.0.0", entries: plainPackageEntries("plain-helper", "1.0.0") },
      ]);
      expect((await given.run()).ok).toBe(true);
      const lock = readLock(given.lockPath);
      const root = lock.roots["bounded-example"];
      expect(root).toBeDefined();
      if (root === undefined) continue;
      const helper = lock.nodes[root]?.dependencies["plain-helper"];
      expect(helper).toBeDefined();
      if (helper === undefined) continue;
      const rootNode = lock.nodes[root];
      const helperNode = lock.nodes[helper];
      expect(rootNode).toBeDefined();
      expect(helperNode).toBeDefined();
      if (rootNode === undefined || helperNode === undefined) continue;
      if (variant === "missing") delete lock.nodes[helper];
      if (variant === "edge") rootNode.dependencies["plain-helper"] = root;
      if (variant === "duplicate") lock.nodes[`${helper}-duplicate`] = { ...helperNode };
      if (variant === "version") lock.boundedVersion = "9.9.9";
      writeLock(given.lockPath, lock);
      await verifyRefused(given.verifyInstalled, variant === "version" ? "bounded" : "plain-helper");
    }
  });

  test("refuses inconsistent package identity, catalogue import path or export target even when inventory and lock digests are recomputed", async () => {
    for (const mutation of ["identity", "catalogue", "export"] as const) {
      const given = fixture();
      expect((await given.run()).ok).toBe(true);
      const lock = readLock(given.lockPath);
      const root = lock.roots["bounded-example"];
      expect(root).toBeDefined();
      if (root === undefined) continue;
      const digest = root.split("#")[1];
      expect(digest).toBeDefined();
      if (digest === undefined) continue;
      const stored = join(given.storeRoot, digest);
      const file = mutation === "catalogue" ? "bounded.catalog.json" : "package.json";
      const path = join(stored, "package", file);
      const bytes = readFileSync(path, "utf8");
      writeFileSync(path, mutation === "identity" ? bytes.replace('"1.0.0"', '"2.0.0"') : mutation === "catalogue" ? bytes.replace('"importPath":"bounded-example"', '"importPath":"bounded-example/missing"') : bytes.replace("./dist/index.js", "./dist/missing.js"));
      const inventoryPath = join(stored, "inventory.json");
      const inventory = JSON.parse(readFileSync(inventoryPath, "utf8")) as { files: Record<string, { size: number; sha256: string }> };
      const changed = readFileSync(path);
      inventory.files[file] = { size: changed.length, sha256: sha256(changed) };
      writeFileSync(inventoryPath, `${JSON.stringify(inventory)}\n`);
      const node = lock.nodes[root];
      expect(node).toBeDefined();
      if (node === undefined) continue;
      node.inventorySha256 = sha256(readFileSync(inventoryPath));
      writeLock(given.lockPath, lock);
      await verifyRefused(given.verifyInstalled, mutation === "identity" ? "version" : mutation === "catalogue" ? "catalog" : "export");
    }
  });

  test("keeps both direct roots through a later add and an upgrade of one root", async () => {
    const given = fixture([pack("bounded-example", "1.0.0"), pack("bounded-example", "1.0.1"), pack("bounded-second")]);
    expect((await given.run()).ok).toBe(true);
    const originalA = readLock(given.lockPath).roots["bounded-example"];
    expect((await given.run("bounded-second@1.0.0")).ok).toBe(true);
    const both = readLock(given.lockPath);
    expect(both.roots["bounded-example"]).toBe(originalA);
    expect(both.roots["bounded-second"]).toBeDefined();
    expect((await given.run("bounded-example@1.0.1")).ok).toBe(true);
    const upgraded = readLock(given.lockPath);
    expect(upgraded.roots["bounded-example"]).toContain("@1.0.1#");
    expect(upgraded.roots["bounded-second"]).toBe(both.roots["bounded-second"]);
    expect(upgraded.nodes[originalA ?? ""]).toBeUndefined();
    expect((await given.verifyInstalled()).ok).toBe(true);
  });

  test("a failed later add preserves the exact earlier lock and its offline-verifiable store", async () => {
    const given = fixture([pack("bounded-example"), { ...pack("bounded-second"), integrity: `sha512-${"A".repeat(88)}` }]);
    expect((await given.run()).ok).toBe(true);
    const original = readFileSync(given.lockPath);
    await refused(() => given.run("bounded-second@1.0.0"), "integrity");
    expect(readFileSync(given.lockPath)).toEqual(original);
    expect((await given.verifyInstalled()).ok).toBe(true);
  });

  test("an existing lock that fails offline verification is never replaced by a later add", async () => {
    const given = fixture([pack("bounded-example"), pack("bounded-second")]);
    expect((await given.run()).ok).toBe(true);
    const root = readLock(given.lockPath).roots["bounded-example"];
    expect(root).toBeDefined();
    if (root === undefined) return;
    const digest = root.split("#")[1];
    expect(digest).toBeDefined();
    if (digest === undefined) return;
    writeFileSync(join(given.storeRoot, digest, "package", "dist", "index.js"), "tampered\n");
    const oldBytes = readFileSync(given.lockPath);
    await refused(() => given.run("bounded-second@1.0.0"), "bounded-example");
    expect(readFileSync(given.lockPath)).toEqual(oldBytes);
  });

  test("refuses a legacy single-root lock with a re-add repair action before mutation", async () => {
    const given = fixture([pack("bounded-example"), pack("bounded-second")]);
    expect((await given.run()).ok).toBe(true);
    const modern = readLock(given.lockPath);
    writeLock(given.lockPath, { schema: "bounded-packs-lock/1", boundedVersion: modern.boundedVersion, root: modern.roots["bounded-example"], nodes: modern.nodes });
    const oldBytes = readFileSync(given.lockPath);
    await verifyRefused(given.verifyInstalled, "re-add");
    await refused(() => given.run("bounded-second@1.0.0"), "re-add");
    expect(readFileSync(given.lockPath)).toEqual(oldBytes);
  });

  test("two simultaneous additions preserve both roots or refuse one without overwriting the winner", async () => {
    const given = fixture([pack("bounded-example"), pack("bounded-second"), pack("bounded-third")]);
    expect((await given.run()).ok).toBe(true);
    const originalLock = readFileSync(given.lockPath);
    const snapshots: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstPaused: (() => void) | undefined;
    const firstAtSnapshot = new Promise<void>((resolve) => { firstPaused = resolve; });
    let secondSeen: (() => void) | undefined;
    const secondAtSnapshot = new Promise<void>((resolve) => { secondSeen = resolve; });
    const afterSnapshot = async (digest: string): Promise<void> => {
      snapshots.push(digest);
      if (snapshots.length === 1) { firstPaused?.(); await firstBlocked; }
      else secondSeen?.();
    };
    const first = given.run("bounded-second@1.0.0", undefined, afterSnapshot);
    await Promise.race([firstAtSnapshot, Bun.sleep(3000)]);
    expect(snapshots.length).toBeGreaterThan(0);
    if (snapshots.length === 0) return;
    const second = given.run("bounded-third@1.0.0", undefined, afterSnapshot);
    // An exclusive writer may hold the second call before this seam. An optimistic writer
    // reaches it with the same snapshot while the first is held, exposing a lost update.
    await Promise.race([secondAtSnapshot, Bun.sleep(3000)]);
    releaseFirst?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    expect(snapshots[0]).toBe(sha256(originalLock));
    if (!firstResult.ok) {
      expect(firstResult.error.toLowerCase()).toContain("retry");
      expect((await given.run("bounded-second@1.0.0")).ok).toBe(true);
    }
    if (!secondResult.ok) {
      expect(secondResult.error.toLowerCase()).toContain("retry");
      expect((await given.run("bounded-third@1.0.0")).ok).toBe(true);
    }
    expect(Object.keys(readLock(given.lockPath).roots).sort()).toEqual(["bounded-example", "bounded-second", "bounded-third"]);
    expect((await given.verifyInstalled()).ok).toBe(true);
  });
});
