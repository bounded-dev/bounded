import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { expect, test } from "bun:test";
import tar from "tar-stream";
import { verifyReleaseArchive } from "../release-manifest.ts";
import { sha512Integrity, type TarEntry } from "../managed-pack-artifact.test-support.ts";

const REPO = resolve(import.meta.dir, "../../..");
const VERSION = (JSON.parse(readFileSync(join(REPO, "src", "package.json"), "utf8")) as { version: string }).version;
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
function nativeTarget(): string {
  if (process.platform === "darwin") return `darwin-${process.arch}`;
  if (process.platform === "win32") return `windows-${process.arch}`;
  if (process.platform === "linux") {
    const found = Bun.spawnSync(["ldd", "--version"], { stdout: "pipe", stderr: "pipe" });
    const text = `${found.stdout.toString()}${found.stderr.toString()}`.toLowerCase();
    return `linux-${process.arch}-${text.includes("musl") ? "musl" : "gnu"}`;
  }
  throw new Error(`Unsupported native test target ${process.platform}`);
}
function successful(command: readonly string[], cwd: string): void {
  const [program, ...args] = command;
  if (program === undefined) throw new Error("missing test build command");
  const run = Bun.spawnSync([program, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`${command.join(" ")} failed: ${run.stdout.toString()}${run.stderr.toString()}`);
}
function entries(root: string, path = ""): TarEntry[] {
  return readdirSync(join(root, path), { withFileTypes: true }).flatMap((entry) => {
    const name = path === "" ? entry.name : `${path}/${entry.name}`;
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name.endsWith(".test.ts") || entry.name.endsWith(".test-support.ts")) return [];
    if (entry.isDirectory()) return entries(root, name);
    if (!entry.isFile()) throw new Error(`Unsupported packed fixture entry ${name}`);
    return [{ name: `package/${name}`, body: readFileSync(join(root, name)) }];
  });
}
async function packedArtifact(files: readonly TarEntry[]): Promise<Uint8Array> {
  return new Promise((resolveArchive, reject) => {
    const pack = tar.pack();
    const chunks: Buffer[] = [];
    pack.on("data", (chunk: Buffer) => chunks.push(chunk));
    pack.on("error", reject);
    pack.on("end", () => resolveArchive(gzipSync(Buffer.concat(chunks))));
    for (const entry of files) {
      const content = typeof entry.body === "string" ? Buffer.from(entry.body) : Buffer.from(entry.body ?? new Uint8Array());
      pack.entry({ name: entry.name, size: content.byteLength, mode: 0o644, type: "file", mtime: new Date(0),
        uid: 0, gid: 0, uname: "", gname: "" } as Parameters<typeof pack.entry>[0], content);
    }
    pack.finalize();
  });
}
function hookPayload(project: string, tool: string): Uint8Array {
  const toolInput = tool === "Read" ? { file_path: join(project, "README.md") } : { query: "documentation" };
  return new TextEncoder().encode(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: toolInput,
    cwd: project, session_id: "managed-add-test", tool_use_id: `call-${tool}` }));
}

test("a compiled archive adds and executes a published pack with no ambient package runtime", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "bounded-managed-archive-"));
  let stopRegistry: (() => Promise<void>) | undefined;
  try {
    const source = join(scratch, "source");
    const releaseOutput = join(scratch, "release-output");
    successful(["git", "clone", "--quiet", "--no-hardlinks", REPO, source], REPO);
    cpSync(join(REPO, "src"), join(source, "src"), { recursive: true, force: true });
    cpSync(join(REPO, "bun.lock"), join(source, "bun.lock"), { force: true });
    successful([process.execPath, "install", "--frozen-lockfile", "--offline"], source);
    const targetId = nativeTarget();
    successful([process.execPath, join(source, "src", "build-release.ts"), "--target", targetId, "--smoke", "--out", releaseOutput], source);
    successful([process.execPath, join(source, "src", "build-published-pack.ts")], join(source, "src", "published-packs", "example"));
    successful([process.execPath, join(source, "src", "dist", "cli.js"), "catalog", "build"], join(source, "src", "published-packs", "example"));
    const packageRoot = join(source, "src", "published-packs", "example");
    const artifact = await packedArtifact(entries(packageRoot).filter((entry) => !entry.name.includes("/test/")));
    const manifestBytes = readFileSync(join(releaseOutput, `bounded-v${VERSION}-manifest-v1.json`));
    const smokeManifest = JSON.parse(manifestBytes.toString()) as Parameters<typeof verifyReleaseArchive>[0];
    const target = smokeManifest.targets[targetId];
    if (target === undefined) throw new Error(`Missing release target ${targetId}`);
    const verified = await verifyReleaseArchive(smokeManifest, targetId, readFileSync(join(releaseOutput, target.archive.name)));
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error(verified.error);
    const dataHome = join(scratch, "user-data");
    const releaseRoot = join(dataHome, "bounded", "releases", `v${VERSION}`, targetId);
    for (const [name, bytes] of Object.entries(verified.value)) {
      const path = join(releaseRoot, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
    }
    const binary = join(releaseRoot, target.executable.path);
    if (process.platform !== "win32") chmodSync(binary, 0o755);
    const stableManifestBytes = new TextEncoder().encode(`${JSON.stringify({ ...smokeManifest, channel: "stable" })}\n`);
    const manifestDigest = digest(stableManifestBytes);
    const receipts = join(dataHome, "bounded", "receipts", `v${VERSION}`, targetId);
    mkdirSync(join(receipts, "manifests"), { recursive: true });
    writeFileSync(join(receipts, "manifests", `${manifestDigest}.json`), stableManifestBytes);
    writeFileSync(join(receipts, "receipt-v1.json"), `${JSON.stringify({ schema: "bounded-install-receipt/1", version: VERSION, target: targetId, manifestSha256: manifestDigest })}\n`);
    rmSync(source, { recursive: true, force: true });
    expect(existsSync(source)).toBe(false);

    const key = join(scratch, "test-registry.key");
    const certificate = join(scratch, "test-registry.crt");
    successful(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", certificate,
      "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], scratch);
    let registryUrl = "";
    const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, (request, response) => {
      if (request.url === "/bounded-example") {
        const tarball = `${registryUrl}/bounded-example/-/bounded-example-0.1.0.tgz`;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ name: "bounded-example", versions: { "0.1.0": { name: "bounded-example", version: "0.1.0",
          dependencies: {}, peerDependencies: { bounded: "~3.3.0" }, dist: { tarball, integrity: sha512Integrity(artifact) } } } }));
      } else if (request.url === "/bounded-example/-/bounded-example-0.1.0.tgz") {
        response.writeHead(200, { "content-type": "application/octet-stream" }); response.end(artifact);
      } else { response.writeHead(404); response.end("missing"); }
    });
    await new Promise<void>((resolveListen, rejectListen) => server.listen(0, "127.0.0.1", (error?: Error) => error ? rejectListen(error) : resolveListen()));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Registry has no TCP port");
    registryUrl = `https://127.0.0.1:${address.port}`;
    stopRegistry = () => new Promise<void>((resolveStop, rejectStop) => server.close((error) => error ? rejectStop(error) : resolveStop()));

    const project = join(scratch, "python-project"); mkdirSync(project);
    mkdirSync(join(project, ".bounded"));
    writeFileSync(join(project, ".bounded", "version.json"), `${JSON.stringify({ schema: "bounded-project-version/1", version: VERSION })}\n`);
    const originalConfig = 'import { defineConfig } from "bounded/domain";\nexport default defineConfig({ packs: [] });\n';
    writeFileSync(join(project, "bounded.config.ts"), originalConfig);
    const environment = { ...process.env, PATH: join(scratch, "empty-path"), XDG_DATA_HOME: dataHome, LOCALAPPDATA: dataHome,
      NODE_EXTRA_CA_CERTS: certificate, SSL_CERT_FILE: certificate, CLAUDE_PROJECT_DIR: project, XDG_STATE_HOME: join(scratch, "state") };
    const added = Bun.spawn([binary, "add", "bounded-example@0.1.0", "--registry", registryUrl], {
      cwd: project, env: environment, stdout: "pipe", stderr: "pipe" });
    const addOutput = await new Response(added.stdout).text();
    const addError = await new Response(added.stderr).text();
    expect({ exitCode: await added.exited, stderr: addError }).toEqual({ exitCode: 0, stderr: "" });
    expect(addError).toBe("");
    expect(addOutput).toContain("bounded-example@0.1.0");
    expect(addOutput).toContain('import { refusedToolsPack } from "bounded-example"');
    expect(readFileSync(join(project, "bounded.config.ts"), "utf8")).toBe(originalConfig);
    expect(existsSync(join(project, ".bounded", "packs.lock.json"))).toBe(true);
    const projected = join(project, "node_modules", "bounded-example");
    expect(readdirSync(projected, { recursive: true }).every((name) => !/\.(?:m?js|cjs|node)$/.test(String(name)))).toBe(true);

    writeFileSync(join(project, "bounded.config.ts"), 'import { contribution, defineConfig } from "bounded/domain";\nimport { refusedToolsPack } from "bounded-example";\nimport { localRule } from "./local-rule.ts";\nexport default defineConfig({ packs: [refusedToolsPack, localRule], contributes: [contribution(refusedToolsPack.points.refusedTools, [{ tool: "web", redirect: "Use local docs" }])] });\n');
    writeFileSync(join(project, "local-rule.ts"), 'import { corePack, definePack, packIdsFor } from "bounded/domain";\nexport const localRule = definePack({ id: packIdsFor("local")("rule"), dependsOn: [corePack] });\n');
    writeFileSync(join(project, "README.md"), "Local docs for the managed pack test.\n");
    for (const [tool, decision] of [["WebSearch", "deny"], ["Read", "allow"]] as const) {
      const judged = Bun.spawn([binary, "hook", "claude-code"], { cwd: project, env: environment, stdin: hookPayload(project, tool), stdout: "pipe", stderr: "pipe" });
      const answerText = await new Response(judged.stdout).text();
      const answer = (answerText === "" ? {} : JSON.parse(answerText)) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
      expect(await judged.exited).toBe(0);
      expect({ decision: answer.hookSpecificOutput?.permissionDecision ?? "allow", reason: decision === "deny" ? answer.hookSpecificOutput?.permissionDecisionReason : undefined })
        .toMatchObject({ decision });
      if (tool === "WebSearch") expect(answer.hookSpecificOutput?.permissionDecisionReason).toContain("Use local docs");
    }
    const decisions = readFileSync(join(project, ".bounded", "log.jsonl"), "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as { verdict: { kind: string } });
    expect(decisions.map((decision) => decision.verdict.kind)).toEqual(["refuse", "allow"]);
  } finally {
    await stopRegistry?.();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 180_000);
