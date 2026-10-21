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
function installPriorManagedTestRelease(scratch: string, dataHome: string, targetId: string): string {
  const priorVersion = "3.2.9";
  const releaseRoot = join(dataHome, "bounded", "releases");
  const priorRoot = join(releaseRoot, `v${priorVersion}`, targetId);
  cpSync(join(releaseRoot, `v${VERSION}`, targetId), priorRoot, { recursive: true });
  const entry = join(scratch, "prior-managed-entry.ts");
  writeFileSync(entry, `import { dispatchStandalone } from ${JSON.stringify(join(REPO, "src", "standalone-dispatch.ts"))};\nconst version = ${JSON.stringify(priorVersion)};\nconst args = process.argv.slice(2);\nconst dispatched = await dispatchStandalone(args, version);\nif (!dispatched.answered) { if (args[0] === "--version") console.log(version); else { const { runStandaloneRuntime } = await import(${JSON.stringify(join(REPO, "src", "standalone-runtime.ts"))}); await runStandaloneRuntime(args, version, dispatched.hostProjectRoot); } }\n`);
  const binary = join(priorRoot, "bin", process.platform === "win32" ? "bounded.exe" : "bounded");
  rmSync(binary);
  const wasm = join(REPO, "node_modules", "@vscode", "tree-sitter-wasm", "wasm");
  const typeEnvironment = join(REPO, "src", "dist", "standalone", "bounded-type-environment-bytes.bin");
  successful([process.execPath, "build", entry, "--compile", "--asset", join(wasm, "tree-sitter.wasm"),
    "--asset", join(wasm, "tree-sitter-bash.wasm"), "--asset", typeEnvironment, "--outfile", binary], REPO);
  if (process.platform !== "win32") chmodSync(binary, 0o755);
  const identified = Bun.spawnSync([binary, "--version"], { stdout: "pipe", stderr: "pipe" });
  expect({ exitCode: identified.exitCode, version: identified.stdout.toString().trim() }).toEqual({ exitCode: 0, version: priorVersion });
  const currentReceipt = JSON.parse(readFileSync(join(dataHome, "bounded", "receipts", `v${VERSION}`, targetId, "receipt-v1.json"), "utf8")) as { manifestSha256: string };
  const currentManifestPath = join(dataHome, "bounded", "receipts", `v${VERSION}`, targetId, "manifests", `${currentReceipt.manifestSha256}.json`);
  const manifest = JSON.parse(readFileSync(currentManifestPath, "utf8")) as Parameters<typeof verifyReleaseArchive>[0];
  const identityPath = join(priorRoot, "release.json");
  const identity = JSON.parse(readFileSync(identityPath, "utf8")) as Record<string, unknown>;
  writeFileSync(identityPath, `${JSON.stringify({ ...identity, version: priorVersion })}\n`);
  const currentArchive = manifest.targets[targetId];
  if (currentArchive === undefined) throw new Error("Current release lacks native target");
  const changedManifest = { ...manifest, version: priorVersion, targets: { ...manifest.targets, [targetId]: {
    ...currentArchive,
    archive: { ...currentArchive.archive, name: currentArchive.archive.name.replace(`v${VERSION}`, `v${priorVersion}`) },
    executable: { ...currentArchive.executable, size: readFileSync(binary).byteLength, sha256: digest(readFileSync(binary)) },
    files: currentArchive.files.map((file) => file.path === "release.json"
      ? { ...file, size: readFileSync(identityPath).byteLength, sha256: digest(readFileSync(identityPath)) } : file),
  } } };
  const stableManifest = Buffer.from(`${JSON.stringify(changedManifest)}\n`);
  const manifestSha256 = digest(stableManifest);
  const receiptRoot = join(dataHome, "bounded", "receipts", `v${priorVersion}`, targetId);
  mkdirSync(join(receiptRoot, "manifests"), { recursive: true });
  writeFileSync(join(receiptRoot, "manifests", `${manifestSha256}.json`), stableManifest);
  writeFileSync(join(receiptRoot, "receipt-v1.json"), `${JSON.stringify({ schema: "bounded-install-receipt/1", version: priorVersion, target: targetId, manifestSha256 })}\n`);
  return binary;
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

function invokeInstalledPi(project: string, environment: Record<string, string | undefined>): { readonly exitCode: number; readonly stdout: string; readonly stderr: string } {
  const piPackage = "@earendil-works/pi-coding-agent";
  const fixture = join(REPO, "src", "hosts", "pi", "test", "fixtures", "pi-runtime");
  const piRoot = process.env.PI_CODING_AGENT_DIR ?? join(fixture, "node_modules", piPackage);
  if (!existsSync(join(piRoot, "package.json")) && process.env.PI_CODING_AGENT_DIR === undefined) {
    const npm = Bun.which(process.platform === "win32" ? "npm.cmd" : "npm");
    if (npm === null) throw new Error("Pinned Pi fixture requires npm during CI setup");
    successful([npm, "ci", "--prefix", fixture, "--ignore-scripts", "--no-audit", "--no-fund"], REPO);
  }
  const piManifest = JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8")) as {
    name?: string; version?: string; dependencies?: Record<string, string> };
  expect(piManifest.name).toBe(piPackage);
  expect(piManifest.version).toBe("0.87.1");
  expect(piManifest.dependencies?.jiti).toBe("2.7.0");
  const node = process.env.PI_NODE_BINARY ?? Bun.which("node");
  if (node === null) throw new Error("Pinned Pi runtime requires Node for Pi itself");
  const script = join(project, "pi-published-port.mjs");
  writeFileSync(script, `import { pathToFileURL } from "node:url";
const piLoader = await import(pathToFileURL(${JSON.stringify(join(piRoot, "dist", "core", "extensions", "loader.js"))}).href);
const piBus = await import(pathToFileURL(${JSON.stringify(join(piRoot, "dist", "core", "event-bus.js"))}).href);
const loaded = await piLoader.loadExtensions([${JSON.stringify(join(project, ".pi", "extensions", "bounded", "index.ts"))}], process.cwd(), piBus.createEventBus());
if (loaded.errors.length !== 0 || loaded.extensions.length !== 1) throw new Error(JSON.stringify(loaded.errors));
const handlers = new Map([...loaded.extensions[0].handlers].map(([name, values]) => [name, values[0]]));
await handlers.get("session_start")({ type: "session_start", reason: "startup" }, { cwd: process.cwd() });
const answer = await handlers.get("tool_call")({ type: "tool_call", toolCallId: "published-port-read", toolName: "read", input: { path: "README.md" } }, { cwd: process.cwd() });
console.log(JSON.stringify(answer));
process.exit(0);
`);
  const run = Bun.spawnSync([node, script], { cwd: project, env: environment, stdout: "pipe", stderr: "pipe" });
  return { exitCode: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

/** Add a second pack to the cloned publication fixture, with its adapter on a declared export path. */
function addPortBackedPublishedFixture(packageRoot: string): void {
  const manifestPath = join(packageRoot, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown> & { exports: Record<string, unknown>; bounded: { catalog: string; packs: Record<string, string> }; peerDependencies: Record<string, string> };
  manifest.exports["./port-backed"] = { bun: "./packs/port-backed/index.ts", types: "./dist/types/packs/port-backed/index.d.ts", default: "./dist/packs/port-backed/index.js" };
  manifest.exports["./port-backed-adapter"] = { bun: "./packs/port-backed/adapter.ts", types: "./dist/types/packs/port-backed/adapter.d.ts", default: "./dist/packs/port-backed/adapter.js" };
  manifest.bounded.packs["./port-backed"] = "packs/port-backed";
  manifest.peerDependencies.bounded = ">=3.2.9 <4";
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const directory = join(packageRoot, "packs", "port-backed");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "port-backed.contract.ts"), 'import type { BasePack, PackId, PortKey } from "bounded/domain";\nexport interface Notes { read(): string; }\nexport interface PortBackedPack extends BasePack { readonly id: PackId<"bounded-example/port-backed">; readonly ports: { readonly notes: PortKey<Notes, PackId<"bounded-example/port-backed"> > }; }\n');
  writeFileSync(join(directory, "port-backed.pack.ts"), `import { contribution, corePack, definePack, packIdsFor, portKeysFor, Verdict } from "bounded/domain";
import type { PackId, PortKey } from "bounded/domain";
import type { Notes, PortBackedPack } from "./port-backed.contract.ts";
const id = packIdsFor("bounded-example")("port-backed");
export const notes: PortKey<Notes, PackId<"bounded-example/port-backed">> = portKeysFor(id)<Notes>("notes");
export const portBackedPack: PortBackedPack = definePack({ id, dependsOn: [corePack], ports: { notes },
  contributes: [contribution(corePack.points.beforeTool, [async (_call, context) => {
    const opened = context.ports.get(notes);
    if (!opened.ok) return Verdict.refuse(opened.error, "Provide the notes adapter");
    return opened.value.read() === "deny" ? Verdict.refuse("Published port refused the call", "Use local docs") : Verdict.allow;
  }])],
});\n`);
  writeFileSync(join(directory, "index.ts"), 'export { portBackedPack, notes } from "./port-backed.pack.ts";\n');
  writeFileSync(join(directory, "adapter.ts"), 'import type { Notes } from "./port-backed.contract.ts";\nexport class PublishedNotes implements Notes { constructor(readonly root: string) {} read(): string { return "deny"; } }\n');
  mkdirSync(join(directory, "examples"));
  writeFileSync(join(directory, "examples", "with-adapter.config.ts"), 'import { defineConfig, Ports } from "bounded/domain";\nimport { portBackedPack } from "bounded-example/port-backed";\nimport { PublishedNotes } from "bounded-example/port-backed-adapter";\n/**\n * Supply a published notes adapter\n *\n * The project selects a pack and supplies its required port.\n */\nexport default defineConfig({ packs: [portBackedPack], ports: [Ports.provide(portBackedPack.ports.notes, root => new PublishedNotes(root))] });\n');
  writeFileSync(join(directory, "examples", "with-adapter.scenarios.ts"), 'import { defineExampleScenarios } from "bounded/domain";\nexport default defineExampleScenarios({ scenarios: [{ title: "The published adapter refuses a read", steps: [{ toolUse: { tool: "read", effects: [{ kind: "read", path: "README.md" }] }, verdict: { kind: "refuse", reason: "Published port refused the call", redirect: "Use local docs" } }] }] });\n');
  writeFileSync(join(directory, "README.md"), `# bounded-example/port-backed: use a published adapter\n\nA published pack with a required notes port.\n\n## What it is for\n\nTesting explicit project adapter provisions.\n\n## Rule shape\n\nThe pack has no rule values.\n\n## Workflows it fits\n\nA project that provides a notes adapter.\n\n## What it observes\n\nA tool call before it runs.\n\n## What it cannot see\n\nAnything outside the call and its provided port.\n\n## Ports\n\nThe required \`notes\` port reads a note from the project adapter.\n\n## Examples\n\n\`with-adapter.config.ts\` selects the pack and \`with-adapter.scenarios.ts\` describes a blocked call.\n`);
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
    addPortBackedPublishedFixture(join(source, "src", "published-packs", "example"));
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
          dependencies: {}, peerDependencies: { bounded: ">=3.2.9 <4" }, dist: { tarball, integrity: sha512Integrity(artifact) } } } }));
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
    mkdirSync(join(project, ".pi"));
    const environment = { ...process.env, PATH: join(scratch, "empty-path"), XDG_DATA_HOME: dataHome, LOCALAPPDATA: dataHome,
      NODE_EXTRA_CA_CERTS: certificate, SSL_CERT_FILE: certificate, CLAUDE_PROJECT_DIR: project, XDG_STATE_HOME: join(scratch, "state") };
    const initialized = Bun.spawnSync([binary, "init", "--host", "claude-code", "--host", "pi"], { cwd: project, env: environment, stdout: "pipe", stderr: "pipe" });
    expect({ exitCode: initialized.exitCode, stderr: initialized.stderr.toString() }).toEqual({ exitCode: 0, stderr: "" });
    const originalConfig = 'import { defineConfig } from "bounded/domain";\nexport default defineConfig({ packs: [] });\n';
    writeFileSync(join(project, "bounded.config.ts"), originalConfig);
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
    const piProject = join(scratch, "pi-only-python-project"); mkdirSync(piProject);
    mkdirSync(join(piProject, ".pi"));
    const piEnvironment = { ...environment, CLAUDE_PROJECT_DIR: piProject };
    const piInitialized = Bun.spawnSync([binary, "init", "--host", "pi"], { cwd: piProject, env: piEnvironment, stdout: "pipe", stderr: "pipe" });
    expect({ exitCode: piInitialized.exitCode, stderr: piInitialized.stderr.toString() }).toEqual({ exitCode: 0, stderr: "" });
    const piAdded = Bun.spawn([binary, "add", "bounded-example@0.1.0", "--registry", registryUrl],
      { cwd: piProject, env: piEnvironment, stdout: "pipe", stderr: "pipe" });
    await new Response(piAdded.stdout).text();
    const piAddError = await new Response(piAdded.stderr).text();
    expect({ exitCode: await piAdded.exited, stderr: piAddError }).toEqual({ exitCode: 0, stderr: "" });
    const priorBinary = installPriorManagedTestRelease(scratch, dataHome, targetId);
    const priorProject = join(scratch, "prior-managed-project");
    mkdirSync(join(priorProject, ".pi"), { recursive: true });
    const priorEnvironment = { ...environment, CLAUDE_PROJECT_DIR: priorProject };
    const priorInit = Bun.spawnSync([priorBinary, "init", "--host", "claude-code", "--host", "pi"],
      { cwd: priorProject, env: priorEnvironment, stdout: "pipe", stderr: "pipe" });
    expect({ exitCode: priorInit.exitCode, stderr: priorInit.stderr.toString() }).toEqual({ exitCode: 0, stderr: "" });
    expect(JSON.parse(readFileSync(join(priorProject, ".bounded", "version.json"), "utf8")).version).toBe("3.2.9");
    const priorAdd = Bun.spawn([priorBinary, "add", "bounded-example@0.1.0", "--registry", registryUrl],
      { cwd: priorProject, env: priorEnvironment, stdout: "pipe", stderr: "pipe" });
    await new Response(priorAdd.stdout).text();
    const priorAddError = await new Response(priorAdd.stderr).text();
    expect({ exitCode: await priorAdd.exited, stderr: priorAddError }).toEqual({ exitCode: 0, stderr: "" });
    const priorConfig = 'import { defineConfig } from "bounded/domain";\nimport { refusedToolsPack } from "bounded-example";\nexport default defineConfig({ packs: [refusedToolsPack] });\n';
    writeFileSync(join(priorProject, "bounded.config.ts"), priorConfig);
    const priorCheck = Bun.spawnSync([priorBinary, "check"], { cwd: priorProject, env: priorEnvironment, stdout: "pipe", stderr: "pipe" });
    expect({ exitCode: priorCheck.exitCode, stderr: priorCheck.stderr.toString() }).toEqual({ exitCode: 0, stderr: "" });
    const priorLock = JSON.parse(readFileSync(join(priorProject, ".bounded", "packs.lock.json"), "utf8")) as { boundedVersion: string };
    expect(priorLock.boundedVersion).toBe("3.2.9");
    const targetUpdate = Bun.spawnSync([binary, "update"], { cwd: priorProject, env: priorEnvironment, stdout: "pipe", stderr: "pipe" });
    expect({ exitCode: targetUpdate.exitCode, stderr: targetUpdate.stderr.toString() }).toEqual({ exitCode: 0, stderr: "" });
    expect(JSON.parse(readFileSync(join(priorProject, ".bounded", "version.json"), "utf8")).version).toBe(VERSION);
    const targetLock = JSON.parse(readFileSync(join(priorProject, ".bounded", "packs.lock.json"), "utf8")) as { boundedVersion: string };
    expect(targetLock.boundedVersion).toBe(VERSION);
    expect(readFileSync(join(priorProject, "bounded.config.ts"), "utf8")).toBe(priorConfig);
    const targetCheck = Bun.spawnSync([binary, "check"], { cwd: priorProject, env: priorEnvironment, stdout: "pipe", stderr: "pipe" });
    expect({ exitCode: targetCheck.exitCode, stderr: targetCheck.stderr.toString() }).toEqual({ exitCode: 0, stderr: "" });
    await stopRegistry();
    stopRegistry = undefined;

    const runCheck = () => {
      const checked = Bun.spawnSync([binary, "check"], { cwd: project, env: environment, stdout: "pipe", stderr: "pipe" });
      expect(existsSync(source)).toBe(false);
      expect(existsSync(join(scratch, "empty-path", "node"))).toBe(false);
      return { exitCode: checked.exitCode, stdout: checked.stdout.toString(), stderr: checked.stderr.toString() };
    };
    const validConfig = readFileSync(join(project, "bounded.config.ts"), "utf8");
    const portConfig = 'import { defineConfig, Ports } from "bounded/domain";\nimport { portBackedPack } from "bounded-example/port-backed";\nimport { PublishedNotes } from "bounded-example/port-backed-adapter";\nexport default defineConfig({ packs: [portBackedPack], ports: [Ports.provide(portBackedPack.ports.notes, root => new PublishedNotes(root))] });\n';
    writeFileSync(join(project, "bounded.config.ts"), portConfig);
    expect(runCheck()).toMatchObject({ exitCode: 0, stderr: "" });
    const updateLock = readFileSync(join(project, ".bounded", "packs.lock.json"));
    const updateReceipt = readFileSync(join(project, ".bounded", "types-receipt.json"));
    const updatePackManifest = readFileSync(join(projected, "package.json"));
    const updateSettings = readFileSync(join(project, ".claude", "settings.json"));
    const updateLoader = readFileSync(join(project, ".pi", "extensions", "bounded", "index.ts"));
    const updated = Bun.spawnSync([binary, "update"], { cwd: project, env: environment, stdout: "pipe", stderr: "pipe" });
    expect({ exitCode: updated.exitCode, stderr: updated.stderr.toString() }).toEqual({ exitCode: 0, stderr: "" });
    expect(readFileSync(join(project, ".bounded", "packs.lock.json"))).toEqual(updateLock);
    expect(readFileSync(join(project, ".bounded", "types-receipt.json"))).toEqual(updateReceipt);
    expect(readFileSync(join(projected, "package.json"))).toEqual(updatePackManifest);
    expect(readFileSync(join(project, ".claude", "settings.json"))).toEqual(updateSettings);
    expect(readFileSync(join(project, ".pi", "extensions", "bounded", "index.ts"))).toEqual(updateLoader);
    expect(readFileSync(join(project, "bounded.config.ts"), "utf8")).toBe(portConfig);
    expect(runCheck()).toMatchObject({ exitCode: 0, stderr: "" });
    const portJudged = Bun.spawnSync([binary, "hook", "claude-code"], { cwd: project, env: environment,
      stdin: hookPayload(project, "Read"), stdout: "pipe", stderr: "pipe" });
    expect(portJudged.exitCode).toBe(0);
    expect(portJudged.stdout.toString()).toContain("Published port refused the call");
    const piJudged = invokeInstalledPi(project, environment);
    expect(piJudged.exitCode).toBe(0);
    expect(JSON.parse(piJudged.stdout.trim())).toMatchObject({ block: true, reason: expect.stringContaining("Published port refused the call") });
    writeFileSync(join(project, "bounded.config.ts"), portConfig.replace("new PublishedNotes(root)", '(() => { throw new Error("factory opened during check"); })() as PublishedNotes'));
    expect(runCheck()).toMatchObject({ exitCode: 0, stderr: "" });
    writeFileSync(join(project, "bounded.config.ts"), portConfig);
    const lock = JSON.parse(readFileSync(join(project, ".bounded", "packs.lock.json"), "utf8")) as {
      roots: Record<string, string>; nodes: Record<string, { sha256: string }> };
    const publishedRoot = lock.roots["bounded-example"];
    const publishedNode = publishedRoot === undefined ? undefined : lock.nodes[publishedRoot];
    if (publishedNode === undefined) throw new Error("Published pack has no stored artifact node");
    const storedPackage = join(dataHome, "bounded", "packs", "store", publishedNode.sha256, "package");
    const adapterPath = join(storedPackage, "packs", "port-backed", "adapter.ts");
    const adapterBytes = readFileSync(adapterPath, "utf8");
    writeFileSync(adapterPath, `${adapterBytes}\n// changed installed adapter\n`);
    const changedAdapter = runCheck();
    expect(changedAdapter.exitCode).toBe(2);
    expect(changedAdapter.stderr).toMatch(/adapter\.ts.*(?:changed|modified|differs)|(?:changed|modified).*adapter\.ts/s);
    writeFileSync(adapterPath, adapterBytes);
    const packSourcePath = join(storedPackage, "packs", "port-backed", "port-backed.pack.ts");
    const packSourceBytes = readFileSync(packSourcePath, "utf8");
    writeFileSync(packSourcePath, `${packSourceBytes}\n// changed installed pack source\n`);
    const changedPackSource = runCheck();
    expect(changedPackSource.exitCode).toBe(2);
    expect(changedPackSource.stderr).toMatch(/port-backed\.pack\.ts.*(?:changed|modified|differs)|(?:changed|modified).*port-backed\.pack\.ts/s);
    writeFileSync(packSourcePath, packSourceBytes);
    const hostSpecificConfig = 'import { defineConfig, Ports } from "bounded/domain";\nimport { prereqs } from "bounded/prereqs";\nimport { FileSystemPrerequisiteStatusSnapshots } from "bounded/prereqs/adapters";\nimport { portBackedPack } from "bounded-example/port-backed";\nimport { PublishedNotes } from "bounded-example/port-backed-adapter";\nexport default defineConfig({ packs: [portBackedPack, prereqs], ports: [Ports.provide(portBackedPack.ports.notes, root => new PublishedNotes(root)), Ports.provide(prereqs.optionalPorts.prerequisiteStatusSnapshots, root => new FileSystemPrerequisiteStatusSnapshots(root))] });\n';
    writeFileSync(join(piProject, "bounded.config.ts"), hostSpecificConfig);
    const piOnlyChecked = Bun.spawnSync([binary, "check"], { cwd: piProject, env: piEnvironment, stdout: "pipe", stderr: "pipe" });
    expect({ exitCode: piOnlyChecked.exitCode, stderr: piOnlyChecked.stderr.toString() }).toEqual({ exitCode: 0, stderr: "" });
    writeFileSync(join(project, "bounded.config.ts"), hostSpecificConfig);
    const bothHostsChecked = runCheck();
    expect(bothHostsChecked.exitCode).toBe(2);
    expect(bothHostsChecked.stderr).toContain("Claude Code");
    expect(bothHostsChecked.stderr).toContain("bounded/prereqs");
    expect(bothHostsChecked.stderr).toContain("prerequisiteStatusSnapshots");
    writeFileSync(join(project, "bounded.config.ts"), originalConfig);
    expect(runCheck()).toMatchObject({ exitCode: 0, stderr: "" });
    writeFileSync(join(project, "bounded.config.ts"), validConfig);
    const everyPublicDeclaration = ["domain", "application", "adapters", "open-project", "prereqs", "prereqs/adapters",
      "protected-paths", "protected-paths/adapters", "shell-command-reader"]
      .map((path, index) => `import type * as Public${index} from "bounded/${path}";`).join("\n");
    writeFileSync(join(project, "bounded.config.ts"), `${everyPublicDeclaration}\ntype PublishedPack = typeof import("bounded-example").refusedToolsPack;\n${validConfig}`);
    expect(runCheck()).toMatchObject({ exitCode: 0, stderr: "" });
    const typeEnvironmentBytes = verified.value["share/typescript/type-environment.json"];
    expect(typeEnvironmentBytes).toBeDefined();
    if (typeEnvironmentBytes === undefined) throw new Error("release lacks its embedded TypeScript type manifest");
    const typeEnvironment = JSON.parse(new TextDecoder().decode(typeEnvironmentBytes)) as {
      schema: string; typescriptVersion: string; standardLibraries: Record<string, string>; externalDeclarations: Record<string, string> };
    expect(typeEnvironment.schema).toBe("bounded-type-environment/1");
    expect(typeEnvironment.typescriptVersion).toBe("5.9.3");
    expect(typeEnvironment.standardLibraries["lib.es2024.full.d.ts"]).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(typeEnvironment.standardLibraries).length).toBeGreaterThan(20);
    expect(Object.keys(typeEnvironment.externalDeclarations).some((path) => path.includes("tree-sitter-wasm"))).toBe(true);

    writeFileSync(join(project, "bounded.config.ts"), validConfig.replace('redirect: "Use local docs"', 'redirect: 42'));
    const wrongContribution = runCheck();
    expect(wrongContribution.exitCode).not.toBe(0);
    expect(wrongContribution.stderr).toMatch(/bounded\.config\.ts:\d+:\d+.*TS\d{4}/);
    expect(wrongContribution.stderr).toMatch(/redirect|number|string/);

    writeFileSync(join(project, "bounded.config.ts"), `import type { Absent } from "bounded-example/private";\n${validConfig}`);
    const undeclaredSubpath = runCheck();
    expect(undeclaredSubpath.exitCode).not.toBe(0);
    expect(undeclaredSubpath.stderr).toMatch(/TS2307.*bounded-example\/private|bounded-example\/private.*TS2307/);

    writeFileSync(join(project, "bounded.config.ts"), `import { doesNotExist } from "bounded/domain";\n${validConfig}`);
    const missingExport = runCheck();
    expect(missingExport.exitCode).not.toBe(0);
    expect(missingExport.stderr).toMatch(/TS2305.*doesNotExist|doesNotExist.*TS2305/);

    writeFileSync(join(project, "bounded.config.ts"), validConfig.replace("packs: [refusedToolsPack, localRule]", "packs: [localRule]"));
    const unlistedContribution = runCheck();
    expect(unlistedContribution.exitCode).not.toBe(0);
    expect(unlistedContribution.stderr).toMatch(/refusedTools|bounded-example/);
    expect(unlistedContribution.stderr).toMatch(/not.*(list|select|depend)|not assignable|TS\d{4}/i);

    writeFileSync(join(project, "bounded.config.ts"), "export default { packs: [] };\n");
    const malformedDefault = runCheck();
    expect(malformedDefault.exitCode).not.toBe(0);
    expect(malformedDefault.stderr).toMatch(/defineConfig|configuration|default export/i);

    writeFileSync(join(project, "bounded.config.ts"), validConfig.replace("packs: [refusedToolsPack, localRule]", "packs: [refusedToolsPack, refusedToolsPack, localRule]"));
    const duplicate = runCheck();
    expect(duplicate.exitCode).not.toBe(0);
    expect(duplicate.stderr).toMatch(/duplicate|listed twice|refusedToolsPack/i);

    writeFileSync(join(project, "bounded.config.ts"), validConfig);
    const journal = join(project, ".bounded", "types-journal.json");
    writeFileSync(journal, "{}\n");
    const interrupted = runCheck();
    expect(interrupted.exitCode).not.toBe(0);
    expect(interrupted.stderr).toMatch(/journal|recover/i);
    expect(readFileSync(journal, "utf8")).toBe("{}\n");
    rmSync(journal);

    const projectedType = join(projected, "dist", "types", "packs", "refused-tools", "index.d.ts");
    const originalType = readFileSync(projectedType);
    writeFileSync(projectedType, Buffer.concat([originalType, Buffer.from("\n// changed\n")]));
    const changedProjection = runCheck();
    expect(changedProjection.exitCode).not.toBe(0);
    expect(changedProjection.stderr).toMatch(/projection|modified|owned|re-add/i);
    writeFileSync(projectedType, originalType);
    expect(runCheck()).toMatchObject({ exitCode: 0, stderr: "" });

    const releaseReceipt = join(receipts, "receipt-v1.json");
    const originalReleaseReceipt = readFileSync(releaseReceipt);
    writeFileSync(releaseReceipt, Buffer.concat([originalReleaseReceipt, Buffer.from("changed\n")]));
    const changedRelease = runCheck();
    expect(changedRelease.exitCode).not.toBe(0);
    expect(changedRelease.stderr).toMatch(/release|receipt|reinstall/i);
    writeFileSync(releaseReceipt, originalReleaseReceipt);
    expect(runCheck()).toMatchObject({ exitCode: 0, stderr: "" });
    const releaseDeclaration = join(releaseRoot, "share", "types", "core", "domain", "index.d.ts");
    const originalDeclaration = readFileSync(releaseDeclaration);
    writeFileSync(releaseDeclaration, Buffer.concat([originalDeclaration, Buffer.from("\n// tampered declaration\n")]));
    const changedDeclaration = runCheck();
    expect(changedDeclaration.exitCode).not.toBe(0);
    expect(changedDeclaration.stderr).toMatch(/release|declaration|reinstall/i);
    writeFileSync(releaseDeclaration, originalDeclaration);
    expect(runCheck()).toMatchObject({ exitCode: 0, stderr: "" });
    expect(existsSync(join(scratch, "package-manager.log"))).toBe(false);
  } finally {
    await stopRegistry?.();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 180_000);
