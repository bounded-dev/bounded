import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as standaloneRuntime from "../../standalone-runtime.ts";
import { nativeReleaseTarget } from "../../standalone-installed-release.ts";
import { catalogue, manifest, packageArchive, packageEntries, sha512Integrity } from "../managed-pack-artifact.test-support.ts";

type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };
type Parsed = { readonly request: string; readonly registryUrl: string };
type Reply = { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: Uint8Array };
type AddInput = { readonly request: string; readonly registryUrl: string; readonly projectRoot: string; readonly boundedVersion: string; readonly get: (url: string) => Promise<Reply> };
type AddModule = {
  readonly parseStandaloneAddArguments: (args: readonly string[]) => Result<Parsed>;
  readonly fetchStandalonePackResponse: (url: string, fetcher: typeof fetch, limits?: { readonly maxBytes: number; readonly timeoutMs: number }) => Promise<Reply>;
  readonly runStandaloneAddInternal: (args: readonly string[], context: { readonly projectRoot: string; readonly boundedVersion: string; readonly publish?: (input: AddInput) => Promise<Result<unknown>>; readonly get: (url: string) => Promise<Reply>; readonly env?: NodeJS.ProcessEnv }) => Promise<Result<unknown>>;
};
// The internal route is intentionally absent at this red commit. The public
// standalone add command must still refuse until verified runtime loading lands.
const add = standaloneRuntime as unknown as AddModule;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

function verifiedReleaseFixture() {
  const root = mkdtempSync(join(tmpdir(), "bounded-add-release-")); roots.push(root);
  const projectRoot = join(root, "python-project"); mkdirSync(projectRoot);
  const configPath = join(projectRoot, "bounded.config.ts"); writeFileSync(configPath, "user-edited config\n");
  const data = join(root, "user-data");
  const env = { ...process.env, XDG_DATA_HOME: data, LOCALAPPDATA: data };
  const target = nativeReleaseTarget();
  const releaseRoot = join(data, "bounded", "releases", "v3.3.0", target);
  const executablePath = process.platform === "win32" ? "bin/bounded.exe" : "bin/bounded";
  const required = [
    "LICENSE", "release.json", "share/types/index.d.ts",
    "share/claude-code/prereqs-status-band/.claude-plugin/plugin.json",
    "share/claude-code/prereqs-status-band/hooks/engine-subset.ts",
    "share/claude-code/prereqs-status-band/hooks/hooks.json",
    "share/claude-code/prereqs-status-band/hooks/prereqs-status-band-lines.ts",
    "share/claude-code/prereqs-status-band/hooks/prereqs-status-file.ts",
    "share/claude-code/prereqs-status-band/hooks/project-config-names.ts",
    "share/claude-code/prereqs-status-band/hooks/register.ts",
    "share/claude-code/prereqs-status-band/types/index.d.ts",
    ...[
      "core/domain/index.d.ts", "core/application/index.d.ts", "core/adapters/out/index.d.ts",
      "core/composition-root/open-project.d.ts", "packs/prereqs/index.d.ts",
      "packs/prereqs/adapters/out/index.d.ts", "packs/protected-paths/index.d.ts",
      "packs/protected-paths/adapters/out/index.d.ts", "shell-command-reader/index.d.ts",
    ].map((name) => `share/types/${name}`),
  ];
  const identity = `${JSON.stringify({ version: "3.3.0", target, sourceCommit: "a".repeat(40), protocolVersion: 1 })}\n`;
  const fileOf = (name: string, content: string) => {
    const path = join(releaseRoot, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content);
    const bytes = text(content); return { path: name, size: bytes.length, sha256: digest(bytes) };
  };
  const executable = fileOf(executablePath, "fixture executable\n");
  const files = required.map((name) => fileOf(name, name === "release.json" ? identity : name.endsWith(".d.ts") ? "export declare const fixture: true;\n" : `${name}\n`))
    .sort((a, b) => a.path.localeCompare(b.path, "en"));
  const manifestBytes = text(`${JSON.stringify({ schema: "bounded-release/1", version: "3.3.0", channel: "stable", sourceCommit: "a".repeat(40), builtWith: `Bun ${Bun.version}`,
    targets: { [target]: { minimumOS: "fixture", archive: { name: `bounded-v3.3.0-${target}.${target.startsWith("linux-") ? "tar.gz" : "zip"}`, size: 0, sha256: "0".repeat(64) }, executable, files } } })}\n`);
  const manifestSha256 = digest(manifestBytes);
  const receiptDirectory = join(data, "bounded", "receipts", "v3.3.0", target);
  mkdirSync(join(receiptDirectory, "manifests"), { recursive: true });
  writeFileSync(join(receiptDirectory, "manifests", `${manifestSha256}.json`), manifestBytes);
  const receiptPath = join(receiptDirectory, "receipt-v1.json");
  writeFileSync(receiptPath, `${JSON.stringify({ schema: "bounded-install-receipt/1", version: "3.3.0", target, manifestSha256 })}\n`);
  const archive = packageArchive(packageEntries(manifest(), catalogue()));
  const registry = "https://registry.example.test";
  const archiveUrl = `${registry}/bounded-example/-/bounded-example-1.0.0.tgz`;
  const responses = new Map<string, Reply>([
    [`${registry}/bounded-example`, { status: 200, headers: { "content-type": "application/json" }, body: text(JSON.stringify({ name: "bounded-example", versions: { "1.0.0": { name: "bounded-example", version: "1.0.0", dependencies: {}, peerDependencies: { bounded: "~3.3.0" }, dist: { tarball: archiveUrl, integrity: sha512Integrity(archive) } } } })) }],
    [archiveUrl, { status: 200, headers: { "content-type": "application/octet-stream" }, body: archive }],
  ]);
  const calls: string[] = [];
  const get = async (url: string): Promise<Reply> => { calls.push(url); return responses.get(url) ?? { status: 404, headers: {}, body: text("missing") }; };
  return { root, projectRoot, configPath, env, receiptPath, registry, get, calls };
}

test("internal add accepts one exact request and a HTTPS registry, then rejects ambiguous options", () => {
  expect(add.parseStandaloneAddArguments(["add", "@scope/guard@1.2.3"])).toEqual({ ok: true, value: { request: "@scope/guard@1.2.3", registryUrl: "https://registry.npmjs.org" } });
  expect(add.parseStandaloneAddArguments(["add", "guard@1.2.3", "--registry", "https://packs.example.test/base"])).toEqual({ ok: true, value: { request: "guard@1.2.3", registryUrl: "https://packs.example.test/base" } });
  for (const args of [["add", "guard@latest"], ["add", "guard@^1.2.3"], ["add", "guard@1.2.3", "extra"], ["add", "guard@1.2.3", "--registry", "http://packs.example.test"], ["add", "guard@1.2.3", "--registry", "https://packs.example.test", "--force"]]) {
    expect(add.parseStandaloneAddArguments(args).ok).toBe(false);
  }
});

test("one-response transport disables automatic redirects and bounds streamed bytes and time", async () => {
  const calls: { url: string; redirect: RequestInit["redirect"]; signal: AbortSignal | null | undefined }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), redirect: init?.redirect, signal: init?.signal });
    return new Response("pack", { status: 302, headers: { location: "https://packs.example.test/next" } });
  }) as typeof fetch;
  const response = await add.fetchStandalonePackResponse("https://packs.example.test/guard", fetcher, { maxBytes: 10, timeoutMs: 100 });
  expect(response).toEqual({ status: 302, headers: { location: "https://packs.example.test/next" }, body: new TextEncoder().encode("pack") });
  expect(calls).toEqual([{ url: "https://packs.example.test/guard", redirect: "manual", signal: expect.any(AbortSignal) }]);

  const streamed = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(6)); controller.enqueue(new Uint8Array(6)); controller.close(); } });
  await expect(add.fetchStandalonePackResponse("https://packs.example.test/large", (async () => new Response(streamed)) as unknown as typeof fetch, { maxBytes: 10, timeoutMs: 100 })).rejects.toThrow(/size|limit/i);
  const hangingFetch = ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
  })) as typeof fetch;
  await expect(add.fetchStandalonePackResponse("https://packs.example.test/hang", hangingFetch, { maxBytes: 10, timeoutMs: 10 })).rejects.toThrow(/timeout|aborted/i);
  const stalledBody = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(text("first")); } });
  await expect(add.fetchStandalonePackResponse("https://packs.example.test/body-stalls", (async () => new Response(stalledBody)) as unknown as typeof fetch, { maxBytes: 10, timeoutMs: 10 })).rejects.toThrow(/timeout|aborted/i);
  await expect(add.fetchStandalonePackResponse("http://packs.example.test/insecure", fetcher, { maxBytes: 10, timeoutMs: 100 })).rejects.toThrow(/https/i);
});

test("internal add passes the dispatched root and exact request into the managed transaction without editing config", async () => {
  const root = mkdtempSync(join(tmpdir(), "bounded-add-slice-a-")); roots.push(root);
  const projectRoot = join(root, "python-project");
  mkdirSync(projectRoot);
  const config = join(projectRoot, "bounded.config.ts");
  writeFileSync(config, "user-edited config\n");
  let seen: AddInput | undefined;
  const get = async (_url: string): Promise<Reply> => ({ status: 200, headers: {}, body: new Uint8Array() });
  const result = await add.runStandaloneAddInternal(["add", "guard@1.2.3"], { projectRoot, boundedVersion: "3.3.0", get,
    publish: async (input) => { seen = input; return { ok: true, value: {} }; } });
  expect(result.ok).toBe(true);
  expect(seen).toEqual({ request: "guard@1.2.3", registryUrl: "https://registry.npmjs.org", projectRoot, boundedVersion: "3.3.0", get });
  expect(existsSync(join(projectRoot, ".bounded", "packs.lock.json"))).toBe(false);
  expect(readFileSync(config, "utf8")).toBe("user-edited config\n");
});

test("internal add requires a verified installed-release receipt before any registry request", async () => {
  for (const damage of ["missing", "tampered"] as const) {
    const fixture = verifiedReleaseFixture();
    if (damage === "missing") rmSync(fixture.receiptPath);
    else writeFileSync(fixture.receiptPath, `${JSON.stringify({ schema: "bounded-install-receipt/1", version: "3.3.0", target: nativeReleaseTarget(), manifestSha256: "0".repeat(64) })}\n`);
    const result = await add.runStandaloneAddInternal(["add", "bounded-example@1.0.0", "--registry", fixture.registry], {
      projectRoot: fixture.projectRoot, boundedVersion: "3.3.0", get: fixture.get, env: fixture.env,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/receipt|manifest|install/i);
    expect(fixture.calls).toEqual([]);
    expect(existsSync(join(fixture.projectRoot, ".bounded", "packs.lock.json"))).toBe(false);
  }
});

test("internal add uses the verified release and real managed transaction", async () => {
  const fixture = verifiedReleaseFixture();
  const result = await add.runStandaloneAddInternal(["add", "bounded-example@1.0.0", "--registry", fixture.registry], {
    projectRoot: fixture.projectRoot, boundedVersion: "3.3.0", get: fixture.get, env: fixture.env,
  });
  expect(result.ok).toBe(true);
  expect(fixture.calls).toEqual([`${fixture.registry}/bounded-example`, `${fixture.registry}/bounded-example/-/bounded-example-1.0.0.tgz`]);
  const lock = JSON.parse(readFileSync(join(fixture.projectRoot, ".bounded", "packs.lock.json"), "utf8")) as { roots: Record<string, string> };
  expect(lock.roots["bounded-example"]).toContain("bounded-example@1.0.0#");
  expect(existsSync(join(fixture.projectRoot, ".bounded", "types-receipt.json"))).toBe(true);
  expect(readFileSync(fixture.configPath, "utf8")).toBe("user-edited config\n");
});

test("compiled public add still refuses before network access or project mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "bounded-add-public-gate-")); roots.push(root);
  const executable = join(root, process.platform === "win32" ? "bounded.exe" : "bounded");
  const repo = resolve(import.meta.dir, "../../..");
  const built = Bun.spawnSync([process.execPath, "build", join(repo, "src", "standalone-main.ts"), "--compile",
    "--asset", join(repo, "node_modules", "@vscode", "tree-sitter-wasm", "wasm", "tree-sitter.wasm"),
    "--asset", join(repo, "node_modules", "@vscode", "tree-sitter-wasm", "wasm", "tree-sitter-bash.wasm"),
    "--outfile", executable], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  expect(built.exitCode).toBe(0);
  if (built.exitCode !== 0) throw new Error(built.stderr.toString());
  if (process.platform !== "win32") chmodSync(executable, 0o755);
  const project = join(root, "project"); mkdirSync(project);
  const config = join(project, "bounded.config.ts"); writeFileSync(config, "user-edited config\n");
  const ran = Bun.spawnSync([executable, "add", "guard@1.2.3", "--registry", "https://127.0.0.1:1"], {
    cwd: project, env: { ...process.env, PATH: "" }, stdout: "pipe", stderr: "pipe",
  });
  expect(ran.exitCode).toBe(2);
  expect(ran.stderr.toString()).toContain("bounded add is unavailable until verified managed-pack runtime loading");
  expect(readFileSync(config, "utf8")).toBe("user-edited config\n");
  expect(existsSync(join(project, ".bounded", "packs.lock.json"))).toBe(false);
  expect(existsSync(join(project, "node_modules"))).toBe(false);
});
