import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as standaloneRuntime from "../standalone-runtime.ts";

type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };
type Parsed = { readonly request: string; readonly registryUrl: string };
type Reply = { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: Uint8Array };
type AddInput = { readonly request: string; readonly registryUrl: string; readonly projectRoot: string; readonly boundedVersion: string; readonly get: (url: string) => Promise<Reply> };
type AddModule = {
  readonly parseStandaloneAddArguments: (args: readonly string[]) => Result<Parsed>;
  readonly fetchStandalonePackResponse: (url: string, fetcher: typeof fetch, limits?: { readonly maxBytes: number; readonly timeoutMs: number }) => Promise<Reply>;
  readonly runStandaloneAddInternal: (args: readonly string[], context: { readonly projectRoot: string; readonly boundedVersion: string; readonly publish: (input: AddInput) => Promise<Result<unknown>>; readonly get: (url: string) => Promise<Reply> }) => Promise<Result<unknown>>;
};
// The internal route is intentionally absent at this red commit. The public
// standalone add command must still refuse until verified runtime loading lands.
const add = standaloneRuntime as unknown as AddModule;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

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

test("compiled public add still refuses before network access or project mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "bounded-add-public-gate-")); roots.push(root);
  const executable = join(root, process.platform === "win32" ? "bounded.exe" : "bounded");
  const repo = resolve(import.meta.dir, "../..");
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
  expect(ran.stderr.toString()).toContain("unsupported standalone command");
  expect(readFileSync(config, "utf8")).toBe("user-edited config\n");
  expect(existsSync(join(project, ".bounded", "packs.lock.json"))).toBe(false);
  expect(existsSync(join(project, "node_modules"))).toBe(false);
});
