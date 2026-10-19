import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
}) => Promise<InstallResult>;

// This module is supplied by the green implementation. Keep the red tests typecheckable.
const installerModule = "./managed-pack-installer.ts";
const install: Install = async (input) => {
  const module = await import(installerModule) as { installManagedPack: Install };
  return module.installManagedPack(input);
};

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
  const run = (request = "bounded-example@1.0.0", publishLock?: (path: string, contents: string) => Promise<void>) => install({ request, boundedVersion: "3.3.0", boundedExportPaths: ["./domain", "./application"], registryUrl: REGISTRY, projectRoot, storeRoot, get, ...(publishLock === undefined ? {} : { publishLock }) });
  const lockPath = join(projectRoot, ".bounded", "packs.lock.json");
  return { root, projectRoot, storeRoot, replies, calls, get, run, lockPath };
}

const refused = async (run: () => Promise<InstallResult>, phrase: string): Promise<string> => {
  const result = await run();
  expect(result.ok).toBe(false);
  if (result.ok) return "";
  expect(result.error.toLowerCase()).toContain(phrase.toLowerCase());
  return result.error;
};

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
  test("installs one exact version with registry integrity, tarball SHA-256, complete file inventory and an atomic project lock", async () => {
    const given = fixture();
    const result = await given.run();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lockPath).toBe(given.lockPath);
    const lock = JSON.parse(readFileSync(given.lockPath, "utf8")) as Record<string, unknown>;
    expect(lock.schema).toBe("bounded-packs-lock/1");
    expect(JSON.stringify(lock)).toContain("bounded-example");
    expect(JSON.stringify(lock)).toContain("1.0.0");
    const archive = given.replies.get(tarUrl("bounded-example", "1.0.0"))?.body;
    expect(archive).toBeDefined();
    if (archive === undefined) return;
    expect(JSON.stringify(lock)).toContain(sha256(archive));
    expect(JSON.stringify(lock)).toContain(sha512Integrity(archive));
    const storeFiles = filesUnder(given.storeRoot);
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
    const digest = (JSON.parse(priorLock) as { root: string }).root.split("#")[1];
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
