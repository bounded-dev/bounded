import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as projectionModule from "./managed-pack-installer.ts";
import { catalogue, manifest, packageArchive, packageEntries, sha512Integrity, type TarEntry } from "./managed-pack-artifact.test-support.ts";

type Reply = { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: Uint8Array };
type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };
type Input = {
  readonly request: string;
  readonly boundedVersion: string;
  readonly boundedExportPaths: readonly string[];
  readonly registryUrl: string;
  readonly projectRoot: string;
  readonly storeRoot: string;
  readonly releaseTypesRoot: string;
  /** SHA-256 entries from the verified installed-release manifest, not hashes computed from source at use time. */
  readonly releaseTypeFilesFromVerifiedManifest: Readonly<Record<string, string>>;
  readonly get: (url: string) => Promise<Reply>;
  /** Test-only crash cut, after the named durable publication step. */
  readonly faultAfter?: string;
  /** Test-only observation under the one shared project writer. */
  readonly afterExistingStateVerified?: (lockSha256: string | null) => Promise<void>;
};
type Add = (input: Input) => Promise<Result<{ readonly lockPath: string; readonly receiptPath: string }>>;
type Prepare = (input: Input) => Promise<Result<{ readonly lock: { readonly roots: Readonly<Record<string, string>> } }>>;
const prepare = (projectionModule as unknown as { readonly prepareManagedPackAddition: Prepare }).prepareManagedPackAddition;
type Verify = (input: Pick<Input, "boundedVersion" | "boundedExportPaths" | "projectRoot" | "storeRoot" | "releaseTypesRoot" | "releaseTypeFilesFromVerifiedManifest">) => Promise<Result<unknown>>;
type Recover = Verify;
// The production API is intentionally absent at the red commit. The casts keep the contract test-only.
const add = (projectionModule as unknown as { readonly addManagedPackWithProjection: Add }).addManagedPackWithProjection;
const verify = (projectionModule as unknown as { readonly verifyManagedPackProjection: Verify }).verifyManagedPackProjection;
const recover = (projectionModule as unknown as { readonly recoverManagedPackProjection: Recover }).recoverManagedPackProjection;
const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);
const digest = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
const registry = "https://registry.example.test";
const reply = (body: Uint8Array, contentType: string): Reply => ({ status: 200, headers: { "content-type": contentType }, body });
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

type Published = { readonly name: string; readonly version: string; readonly dependencies?: Readonly<Record<string, string>>; readonly entries?: readonly TarEntry[] };
function pack(name: string, version = "1.0.0", dependencies: Readonly<Record<string, string>> = {}): Published {
  const pkg = { ...manifest(name, version), dependencies,
    exports: {
      ".": { import: "./dist/index.js", types: "./dist/index.d.ts" },
      "./extra": { import: "./dist/extra.js", types: "./dist/extra.d.ts" },
    },
  };
  const usesHelper = dependencies["plain-helper"] !== undefined;
  return { name, version, dependencies, entries: [
    ...packageEntries(pkg, catalogue(name, version)),
    { name: "package/dist/extra.js", body: "export const extra = 1;\n" },
    { name: "package/dist/extra.d.ts", body: `export declare const extra: "${name}-extra-${version}";\n` },
  ].map((entry) => entry.name === "package/dist/index.d.ts"
    ? { ...entry, body: `${usesHelper ? 'import { version } from "plain-helper";\nexport declare const helperVersion: typeof version;\n' : ""}export declare const packMarker: "${name}-${version}";\n` }
    : entry.name === "package/dist/index.js" && usesHelper
      ? { ...entry, body: 'import { version } from "plain-helper";\nexport const helperVersion = version;\n' } : entry) };
}
function library(name: string, version: string, dependencies: Readonly<Record<string, string>> = {}): Published {
  return { name, version, dependencies, entries: [
    { name: "package/package.json", body: `${JSON.stringify({ name, version, type: "module", dependencies,
      exports: { ".": { import: "./dist/index.js", types: "./dist/index.d.ts" } } })}\n` },
    { name: "package/dist/index.js", body: `export const version = ${JSON.stringify(version)};\n` },
    { name: "package/dist/index.d.ts", body: `export declare const version: "${version}";\n` },
  ] };
}
function fixture(published: readonly Published[] = [pack("bounded-example")]) {
  const root = mkdtempSync(join(tmpdir(), "bounded-projection-red-"));
  roots.push(root);
  const projectRoot = join(root, "python-project");
  const storeRoot = join(root, "store");
  const releaseTypesRoot = join(root, "verified-release", "share", "types");
  mkdirSync(join(releaseTypesRoot, "core", "domain"), { recursive: true });
  const domainDeclaration = utf8('export declare const boundedWord: "bounded";\n');
  writeFileSync(join(releaseTypesRoot, "core", "domain", "index.d.ts"), domainDeclaration);
  const releaseTypeFilesFromVerifiedManifest = { "core/domain/index.d.ts": digest(domainDeclaration) };
  const responses = new Map<string, Reply>();
  const versions = new Map<string, Record<string, unknown>>();
  const calls: string[] = [];
  for (const item of published) {
    const entries = item.entries ?? pack(item.name, item.version, item.dependencies).entries ?? [];
    const archive = packageArchive(entries);
    const url = `${registry}/${item.name}/-/${item.name}-${item.version}.tgz`;
    const listed = versions.get(item.name) ?? {};
    listed[item.version] = { name: item.name, version: item.version,
      dependencies: item.dependencies ?? {}, peerDependencies: item.name.startsWith("bounded-") ? { bounded: "~3.3.0" } : {},
      dist: { tarball: url, integrity: sha512Integrity(archive) } };
    versions.set(item.name, listed);
    responses.set(url, reply(archive, "application/octet-stream"));
  }
  for (const [name, listed] of versions) responses.set(`${registry}/${name}`, reply(utf8(JSON.stringify({ name, versions: listed })), "application/json"));
  const get = async (url: string): Promise<Reply> => { calls.push(url); return responses.get(url) ?? { status: 404, headers: {}, body: utf8("missing") }; };
  const base = { boundedVersion: "3.3.0", boundedExportPaths: ["./domain"], projectRoot, storeRoot, releaseTypesRoot, releaseTypeFilesFromVerifiedManifest };
  const run = (request = "bounded-example@1.0.0", options: Pick<Input, "faultAfter" | "afterExistingStateVerified"> = {}) =>
    add({ ...base, request, registryUrl: registry, get, ...options });
  const check = () => verify(base);
  const restart = () => recover(base);
  return { root, projectRoot, storeRoot, releaseTypesRoot, releaseTypeFilesFromVerifiedManifest, get, run, check, restart, calls,
    lockPath: join(projectRoot, ".bounded", "packs.lock.json"),
    receiptPath: join(projectRoot, ".bounded", "types-receipt.json"),
    journalPath: join(projectRoot, ".bounded", "types-journal.json"),
    projected: (name: string) => join(projectRoot, "node_modules", name) };
}
function allEntries(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path).flatMap((name) => {
    const child = join(path, name);
    return lstatSync(child).isDirectory() ? [child, ...allEntries(child)] : [child];
  });
}
function snapshot(path: string): Readonly<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of allEntries(path)) {
    const stat = lstatSync(entry);
    files[relative(path, entry)] = stat.isSymbolicLink() ? `link:${readlinkSync(entry)}` : stat.isDirectory() ? "directory" : `file:${digest(readFileSync(entry))}`;
  }
  return files;
}
async function refused(run: () => Promise<Result<unknown>>, phrase: string): Promise<void> {
  const result = await run();
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.toLowerCase()).toContain(phrase.toLowerCase());
}

/** Talks to the actual TypeScript language server in an inferred Python project. */
async function tsserver(projectRoot: string, file: string, position = { completionLine: 8, completionOffset: 9 }): Promise<{ diagnostics: readonly { code: number }[]; completions: readonly string[] }> {
  const serverPath = fileURLToPath(import.meta.resolve("typescript/lib/tsserver.js"));
  const child = spawn("node", [serverPath, "--useInferredProjectPerProjectRoot"], { cwd: projectRoot, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  let errors = "";
  child.stdout.setEncoding("utf8").on("data", (part: string) => { output += part; });
  child.stderr.setEncoding("utf8").on("data", (part: string) => { errors += part; });
  const command = (seq: number, name: string, args: Record<string, unknown>): void => {
    child.stdin.write(`${JSON.stringify({ seq, type: "request", command: name, arguments: args })}\n`);
  };
  command(1, "open", { file, projectRootPath: projectRoot });
  command(2, "semanticDiagnosticsSync", { file, includeLinePosition: true });
  command(3, "completionInfo", { file, line: position.completionLine, offset: position.completionOffset, includeExternalModuleExports: false });
  await new Promise<void>((resolveWait, rejectWait) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (output.includes('"request_seq":3') || Date.now() - start > 10000) {
        clearInterval(timer);
        if (Date.now() - start > 10000) rejectWait(new Error(`tsserver timed out: ${errors}\n${output}`));
        else resolveWait();
      }
    }, 20);
    child.once("error", rejectWait);
    child.once("exit", (code) => { clearInterval(timer); rejectWait(new Error(`tsserver exited ${code}: ${errors}\n${output}`)); });
  });
  child.kill();
  const messages = [...output.matchAll(/Content-Length: \d+\r?\n\r?\n([^\r\n]+)/g)].map((match) => JSON.parse(match[1] ?? "{}") as { request_seq?: number; body?: unknown });
  const diagnostics = messages.find((item) => item.request_seq === 2)?.body;
  const completion = messages.find((item) => item.request_seq === 3)?.body;
  if (!Array.isArray(diagnostics) || typeof completion !== "object" || completion === null || !("entries" in completion) || !Array.isArray(completion.entries))
    throw new Error(`Unexpected tsserver response: ${output}`);
  return { diagnostics: diagnostics as { code: number }[], completions: completion.entries.map((entry: { name: string }) => entry.name) };
}

describe("managed pack type-only projection and publication", () => {
  test("preparation verifies the proposed graph without publishing a lock or projection", async () => {
    const given = fixture();
    const proposed = await prepare({ request: "bounded-example@1.0.0", boundedVersion: "3.3.0",
      boundedExportPaths: ["./domain"], registryUrl: registry, projectRoot: given.projectRoot,
      storeRoot: given.storeRoot, releaseTypesRoot: given.releaseTypesRoot,
      releaseTypeFilesFromVerifiedManifest: given.releaseTypeFilesFromVerifiedManifest, get: given.get });
    expect(proposed.ok).toBe(true);
    if (proposed.ok) expect(proposed.value.lock.roots["bounded-example"]).toContain("bounded-example@1.0.0#");
    expect(existsSync(given.lockPath)).toBe(false);
    expect(existsSync(given.receiptPath)).toBe(false);
    expect(existsSync(given.projected("bounded-example"))).toBe(false);
  });

  test("a Python inferred project resolves release and pack root/subpath declarations with real tsserver", async () => {
    const given = fixture();
    expect(existsSync(join(given.projectRoot, "package.json"))).toBe(false);
    expect(existsSync(join(given.projectRoot, "tsconfig.json"))).toBe(false);
    expect(existsSync(join(given.projectRoot, "node_modules"))).toBe(false);
    const result = await given.run();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const file = join(given.projectRoot, "bounded.config.ts");
    writeFileSync(file, 'import { boundedWord } from "bounded/domain";\nimport { packMarker } from "bounded-example";\nimport { extra } from "bounded-example/extra";\nconst valid: "bounded" = boundedWord;\nconst wrong: "wrong" = packMarker;\nconst alsoWrong: "wrong" = extra;\nimport { missing } from "bounded";\nboundedW\n');
    const language = await tsserver(given.projectRoot, file);
    expect(language.diagnostics.filter((item) => item.code === 2307)).toHaveLength(1);
    expect(language.diagnostics.filter((item) => item.code === 2322)).toHaveLength(2);
    expect(language.completions).toContain("boundedWord");
    const files = allEntries(join(given.projectRoot, "node_modules")).filter((entry) => lstatSync(entry).isFile());
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((entry) => entry.endsWith(".d.ts") || entry.endsWith("package.json"))).toBe(true);
    expect(files.some((entry) => /\.(?:m?js|cjs|node)$/.test(entry))).toBe(false);
    expect((await given.check()).ok).toBe(true);
  });

  test("refuses a missing declaration even when the runtime export is valid", async () => {
    const broken = pack("bounded-example");
    const given = fixture([{ ...broken, entries: (broken.entries ?? []).filter((entry) => entry.name !== "package/dist/extra.d.ts") }]);
    await refused(() => given.run(), "declaration");
    expect(existsSync(given.lockPath)).toBe(false);
    expect(existsSync(given.projected("bounded-example"))).toBe(false);
  });

  test("release declarations must match the verified installed-release manifest before any active write", async () => {
    for (const mutation of ["missing", "tampered"] as const) {
      const given = fixture();
      const declaration = join(given.releaseTypesRoot, "core", "domain", "index.d.ts");
      if (mutation === "missing") rmSync(declaration);
      else writeFileSync(declaration, 'export declare const boundedWord: "forged";\n');
      await refused(() => given.run(), "release");
      expect(existsSync(given.lockPath)).toBe(false);
      expect(existsSync(given.projected("bounded"))).toBe(false);
    }
  });

  test("different pinned dependency versions have importer-local nested types", async () => {
    const given = fixture([
      pack("bounded-example", "1.0.0", { "plain-helper": "1.0.0" }),
      pack("bounded-second", "1.0.0", { "plain-helper": "2.0.0" }),
      library("plain-helper", "1.0.0"), library("plain-helper", "2.0.0"),
    ]);
    expect((await given.run()).ok).toBe(true);
    expect((await given.run("bounded-second@1.0.0")).ok).toBe(true);
    const a = join(given.projected("bounded-example"), "node_modules", "plain-helper", "dist", "index.d.ts");
    const b = join(given.projected("bounded-second"), "node_modules", "plain-helper", "dist", "index.d.ts");
    expect(readFileSync(a, "utf8")).toContain('"1.0.0"');
    expect(readFileSync(b, "utf8")).toContain('"2.0.0"');
    const source = join(given.projectRoot, "bounded.config.ts");
    writeFileSync(source, 'import { helperVersion as a } from "bounded-example";\nimport { helperVersion as b } from "bounded-second";\nconst aCorrect: "1.0.0" = a;\nconst bCorrect: "2.0.0" = b;\nconst aWrong: "2.0.0" = a;\nconst bWrong: "1.0.0" = b;\na\n');
    const language = await tsserver(given.projectRoot, source, { completionLine: 7, completionOffset: 2 });
    expect(language.diagnostics.filter((item) => item.code === 2307)).toHaveLength(0);
    expect(language.diagnostics.filter((item) => item.code === 2322)).toHaveLength(2);
    expect((await given.check()).ok).toBe(true);
  });

  test("unowned package managers' directories and links are left byte-identical, even with equivalent declarations", async () => {
    for (const owner of ["npm", "bun", "pnpm", "yarn", "equivalent", "link"] as const) {
      const given = fixture();
      const target = given.projected("bounded-example");
      mkdirSync(dirname(target), { recursive: true });
      if (owner === "link") { const outside = join(given.root, "outside"); mkdirSync(outside); symlinkSync(outside, target, "dir"); }
      else { mkdirSync(target); writeFileSync(join(target, "package.json"), owner === "equivalent" ? JSON.stringify({ name: "bounded-example", types: "./dist/index.d.ts" }) : owner); }
      const before = owner === "link" ? lstatSync(target).isSymbolicLink() : snapshot(target);
      await refused(() => given.run(), "unowned");
      expect(owner === "link" ? lstatSync(target).isSymbolicLink() : snapshot(target)).toEqual(before);
      expect(existsSync(given.lockPath)).toBe(false);
    }
  });

  test("an unowned parent package blocks a nested dependency projection", async () => {
    const given = fixture([pack("bounded-example", "1.0.0", { "plain-helper": "1.0.0" }), library("plain-helper", "1.0.0")]);
    const target = given.projected("bounded-example");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "user-file"), "owned by another package manager\n");
    const before = snapshot(target);
    await refused(() => given.run(), "unowned");
    expect(snapshot(target)).toEqual(before);
  });

  test("receipt binds the active lock and the exact owned tree, including no extra files or links", async () => {
    for (const mutation of ["bytes", "extra", "link", "receipt"] as const) {
      const given = fixture([pack("bounded-example"), pack("bounded-second")]);
      expect((await given.run()).ok).toBe(true);
      const target = given.projected("bounded-example");
      if (mutation === "bytes") writeFileSync(join(target, "dist", "index.d.ts"), "changed\n");
      if (mutation === "extra") writeFileSync(join(target, "extra.txt"), "unexpected\n");
      if (mutation === "link") symlinkSync(join(given.root, "outside"), join(target, "extra-link"));
      if (mutation === "receipt") {
        const receipt = JSON.parse(readFileSync(given.receiptPath, "utf8")) as { lockSha256?: string };
        expect(receipt.lockSha256).toMatch(/^[a-f0-9]{64}$/);
        receipt.lockSha256 = "0".repeat(64);
        writeFileSync(given.receiptPath, `${JSON.stringify(receipt)}\n`);
      }
      const oldLock = readFileSync(given.lockPath);
      await refused(given.check, mutation === "receipt" ? "receipt" : "projection");
      await refused(() => given.run("bounded-second@1.0.0"), mutation === "receipt" ? "receipt" : "projection");
      expect(readFileSync(given.lockPath)).toEqual(oldLock);
    }
  });

  test("fault cuts recover old bytes or a fully verified new state; lock publication is last", async () => {
    for (const cut of ["backup", "journal", "rename-old", "publish-a", "publish-b", "receipt", "lock", "journal-removal", "backup-cleanup"]) {
      const given = fixture([pack("bounded-example"), pack("bounded-second")]);
      expect((await given.run()).ok).toBe(true);
      const oldLock = readFileSync(given.lockPath);
      const oldReceipt = readFileSync(given.receiptPath);
      const oldTypes = snapshot(join(given.projectRoot, "node_modules"));
      await given.run("bounded-second@1.0.0", { faultAfter: cut });
      const recovered = await given.restart();
      expect(recovered.ok).toBe(true);
      const currentLock = readFileSync(given.lockPath);
      const old = currentLock.equals(oldLock);
      expect(old).toBe(!["journal-removal", "backup-cleanup"].includes(cut));
      if (old) {
        expect(readFileSync(given.receiptPath)).toEqual(oldReceipt);
        expect(snapshot(join(given.projectRoot, "node_modules"))).toEqual(oldTypes);
        expect(existsSync(given.projected("bounded-second"))).toBe(false);
      } else {
        expect(JSON.parse(currentLock.toString()).roots["bounded-second"]).toBeDefined();
        expect(existsSync(given.projected("bounded-second"))).toBe(true);
      }
      expect((await given.check()).ok).toBe(true);
      expect(existsSync(given.journalPath)).toBe(false);
    }
  });

  test("missing or malformed rollback material refuses restart without guessing", async () => {
    const given = fixture([pack("bounded-example"), pack("bounded-second")]);
    expect((await given.run()).ok).toBe(true);
    await given.run("bounded-second@1.0.0", { faultAfter: "journal" });
    expect(existsSync(given.journalPath)).toBe(true);
    writeFileSync(given.journalPath, '{"schema":"unexpected","backup":"../../outside"}\n');
    await refused(given.restart, "journal");
    await refused(given.check, "journal");
  });

  test("a missing or corrupt journal backup refuses recovery without changing active state", async () => {
    for (const mutation of ["missing", "corrupt"] as const) {
      const given = fixture([pack("bounded-example"), pack("bounded-second")]);
      expect((await given.run()).ok).toBe(true);
      await given.run("bounded-second@1.0.0", { faultAfter: "journal" });
      const journal = JSON.parse(readFileSync(given.journalPath, "utf8")) as { oldLockBackup?: string };
      expect(journal.oldLockBackup).toBeDefined();
      if (journal.oldLockBackup === undefined) return;
      const backup = resolve(given.projectRoot, ".bounded", journal.oldLockBackup);
      expect(backup.startsWith(`${resolve(given.projectRoot, ".bounded")}/`)).toBe(true);
      const activeBefore = readFileSync(given.lockPath);
      if (mutation === "missing") rmSync(backup);
      else writeFileSync(backup, "corrupted backup\n");
      await refused(given.restart, "backup");
      expect(readFileSync(given.lockPath)).toEqual(activeBefore);
      expect(existsSync(given.journalPath)).toBe(true);
    }
  });

  test("one shared writer serializes preparation and publication without stale writer or lost roots", async () => {
    const given = fixture([pack("bounded-example"), pack("bounded-second"), pack("bounded-third")]);
    expect((await given.run()).ok).toBe(true);
    let releaseFirst: (() => void) | undefined;
    let firstObserved: (() => void) | undefined;
    const blocked = new Promise<void>((resolveBlocked) => { releaseFirst = resolveBlocked; });
    const observed = new Promise<void>((resolveObserved) => { firstObserved = resolveObserved; });
    let calls = 0;
    const seam = async (): Promise<void> => { calls++; if (calls === 1) { firstObserved?.(); await blocked; } };
    const first = given.run("bounded-second@1.0.0", { afterExistingStateVerified: seam });
    await Promise.race([observed, Bun.sleep(3000)]);
    expect(calls).toBe(1);
    const second = given.run("bounded-third@1.0.0", { afterExistingStateVerified: seam });
    releaseFirst?.();
    const both = await Promise.race([Promise.all([first, second]), Bun.sleep(10000).then(() => null)]);
    expect(both).not.toBeNull();
    if (both === null) return;
    expect(both.every((result) => result.ok)).toBe(true);
    const lock = JSON.parse(readFileSync(given.lockPath, "utf8")) as { roots: Record<string, string> };
    expect(Object.keys(lock.roots).sort()).toEqual(["bounded-example", "bounded-second", "bounded-third"]);
    expect(existsSync(join(given.projectRoot, ".bounded", ".packs-lock-writer"))).toBe(false);
  });
});
