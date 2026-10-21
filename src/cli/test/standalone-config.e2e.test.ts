import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { verifyReleaseArchive } from "../release-manifest.ts";

const REPO = resolve(import.meta.dir, "../../..");
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function nativeTarget(): string {
  if (process.platform === "darwin") return `darwin-${process.arch}`;
  if (process.platform === "win32") return `windows-${process.arch}`;
  if (process.platform === "linux") {
    const ldd = Bun.spawnSync(["ldd", "--version"], { stdout: "pipe", stderr: "pipe" });
    const description = `${ldd.stdout.toString()}\n${ldd.stderr.toString()}`.toLowerCase();
    if (description.includes("musl")) return `linux-${process.arch}-musl`;
    if (description.includes("glibc") || description.includes("gnu libc")) return `linux-${process.arch}-gnu`;
  }
  throw new Error(`No native standalone target for ${process.platform}/${process.arch}`);
}

function successful(command: readonly string[], cwd: string): void {
  const [program, ...args] = command;
  if (program === undefined) throw new Error("No program to run");
  const ran = Bun.spawnSync([program, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (ran.exitCode !== 0) throw new Error(`${command.join(" ")} failed: ${ran.stdout.toString()}${ran.stderr.toString()}`);
}

function hook(binary: string, project: string, dataHome: string, toolName: string, toolInput: Record<string, unknown>): { stdout: string; exitCode: number } {
  const payload = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput, cwd: project, session_id: "standalone-test", tool_use_id: `call-${toolName}` });
  const ran = Bun.spawnSync([binary, "hook", "claude-code"], {
    cwd: project,
    env: { ...process.env, PATH: join(project, "empty-path"), CLAUDE_PROJECT_DIR: project, XDG_STATE_HOME: join(project, "state"), XDG_DATA_HOME: dataHome, LOCALAPPDATA: dataHome },
    stdin: new TextEncoder().encode(payload),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { stdout: ran.stdout.toString(), exitCode: ran.exitCode };
}

function refusal(answer: string): string {
  const parsed = JSON.parse(answer) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
  expect(parsed.hookSpecificOutput?.permissionDecision).toBe("deny");
  return parsed.hookSpecificOutput?.permissionDecisionReason ?? "";
}

test("the archive alone loads a TypeScript project config, nested local pack and Bash grammar without Node, Bun, npm or build checkout", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "bounded-standalone-config-"));
  const source = join(scratch, "build-checkout");
  const release = join(scratch, "release");
  const project = join(scratch, "python-project");
  try {
    // Build in a disposable checkout. Delete it before running the artifact so
    // imports or WASM reads from its node_modules cannot make this pass.
    successful(["git", "clone", "--quiet", "--no-hardlinks", REPO, source], REPO);
    // Exercise the working tree during development as well as committed HEAD.
    cpSync(join(REPO, "src"), join(source, "src"), { recursive: true, force: true });
    cpSync(join(REPO, "bun.lock"), join(source, "bun.lock"), { force: true });
    successful([process.execPath, "install", "--frozen-lockfile", "--offline"], source);
    const targetId = nativeTarget();
    successful([process.execPath, join(source, "src", "build-release.ts"), "--target", targetId, "--smoke", "--out", release], source);
    const version = (JSON.parse(readFileSync(join(source, "src", "package.json"), "utf8")) as { version: string }).version;
    const manifestBytes = readFileSync(join(release, `bounded-v${version}-manifest-v1.json`));
    const manifest = JSON.parse(manifestBytes.toString()) as Parameters<typeof verifyReleaseArchive>[0];
    const entry = manifest.targets[targetId];
    expect(entry).toBeDefined();
    if (entry === undefined) throw new Error(`release lacks ${targetId}`);
    const archiveBytes = readFileSync(join(release, entry.archive.name));
    expect(sha256(archiveBytes)).toBe(entry.archive.sha256);
    const verified = await verifyReleaseArchive(manifest, targetId, archiveBytes);
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error(verified.error);
    const executableBytes = verified.value[entry.executable.path];
    if (executableBytes === undefined) throw new Error("verified archive lacks the executable");
    const dataHome = join(scratch, "user-data");
    const installedRelease = join(dataHome, "bounded", "releases", `v${version}`, targetId);
    for (const [path, bytes] of Object.entries(verified.value)) {
      const destination = join(installedRelease, path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, bytes);
    }
    const binary = join(installedRelease, entry.executable.path);
    const stableManifest = Buffer.from(`${JSON.stringify({ ...manifest, channel: "stable" })}\n`);
    const manifestDigest = sha256(stableManifest);
    const receiptDirectory = join(dataHome, "bounded", "receipts", `v${version}`, targetId);
    mkdirSync(join(receiptDirectory, "manifests"), { recursive: true });
    writeFileSync(join(receiptDirectory, "manifests", `${manifestDigest}.json`), stableManifest);
    writeFileSync(join(receiptDirectory, "receipt-v1.json"), `${JSON.stringify({ schema: "bounded-install-receipt/1", version, target: targetId, manifestSha256: manifestDigest })}\n`);
    if (!targetId.startsWith("windows-")) chmodSync(binary, 0o755);
    rmSync(source, { recursive: true, force: true });
    expect(existsSync(source)).toBe(false);

    mkdirSync(join(project, "packs"), { recursive: true });
    mkdirSync(join(project, "empty-path"));
    writeFileSync(join(project, "packs", "local-rule.ts"), 'export const guardedPrefix = "generated/";\n');
    const fixedRuleTime = new Date("2020-01-01T00:00:00.000Z");
    utimesSync(join(project, "packs", "local-rule.ts"), fixedRuleTime, fixedRuleTime);
    writeFileSync(join(project, "packs", "local-pack.ts"), `import { contribution, corePack, definePack, packIdsFor, Verdict } from "bounded/domain";
import { guardedPrefix } from "./local-rule.ts";
export const localGate = definePack({
  id: packIdsFor("local")("gate"),
  dependsOn: [corePack],
  contributes: [contribution(corePack.points.effectGuards.write, [
    (effect) => effect.path.value.startsWith(guardedPrefix)
      ? Verdict.refuse("generated files are owned by a generator", "Edit the generator's source")
      : Verdict.allow,
  ])],
});
`);
    writeFileSync(join(project, "bounded.config.ts"), `import { contribution, defineConfig } from "bounded/domain";
import { protectedPathsPack } from "bounded/protected-paths";
import { localGate } from "./packs/local-pack.ts";
export default defineConfig({
  packs: [protectedPathsPack, localGate],
  contributes: [contribution(protectedPathsPack.points.protectedPaths, [
    { match: "**/bounded.config.*", deny: ["create", "modify", "delete"], why: "the configuration is protected", redirect: "Ask a person to change the configuration" },
  ])],
});
`);
    expect(existsSync(join(project, "package.json"))).toBe(false);
    expect(existsSync(join(project, "node_modules"))).toBe(false);

    const blockedWrite = hook(binary, project, dataHome, "Write", { file_path: join(project, "generated", "a.py"), content: "x" });
    expect(blockedWrite.exitCode).toBe(0);
    const blockedReason = refusal(blockedWrite.stdout);
    expect(blockedReason).toContain("local/gate");
    expect(blockedReason).toContain("generated files are owned by a generator");
    const allowedWrite = hook(binary, project, dataHome, "Write", { file_path: join(project, "src", "a.py"), content: "x" });
    expect(allowedWrite.exitCode).toBe(0);
    expect(allowedWrite.stdout).toBe("");
    const decisions = readFileSync(join(project, ".bounded", "log.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { verdict: { kind: string } });
    expect(decisions.map((decision) => decision.verdict.kind)).toEqual(["refuse", "allow"]);

    const blockedShell = hook(binary, project, dataHome, "Bash", { command: "echo x > bounded.config.ts" });
    expect(blockedShell.exitCode).toBe(0);
    const shellReason = refusal(blockedShell.stdout);
    expect(shellReason).toContain("bounded.config.ts");
    expect(shellReason).toContain("the configuration is protected");
    expect(shellReason).not.toMatch(/parser could not load|cannot find module|unread/i);
    const allowedShell = hook(binary, project, dataHome, "Bash", { command: "echo x > scratch.txt" });
    expect(allowedShell.exitCode).toBe(0);
    expect(allowedShell.stdout).toBe("");

    const localRulePath = join(project, "packs", "local-rule.ts");
    const configPath = join(project, "bounded.config.ts");
    const priorRule = statSync(localRulePath);
    const priorConfig = statSync(configPath);
    writeFileSync(localRulePath, 'export const guardedPrefix = "alternate/";\n');
    utimesSync(localRulePath, priorRule.atime, priorRule.mtime);
    expect(statSync(localRulePath).mtimeMs).toBe(priorRule.mtimeMs);
    expect(statSync(localRulePath).size).toBe(priorRule.size);
    expect(statSync(configPath).mtimeMs).toBe(priorConfig.mtimeMs);
    const changedRule = hook(binary, project, dataHome, "Write", { file_path: join(project, "alternate", "a.py"), content: "x" });
    expect(refusal(changedRule.stdout)).toContain("local/gate");
    writeFileSync(join(project, "bounded.config.ts"), "export default 42;\n");
    expect(refusal(hook(binary, project, dataHome, "Write", { file_path: join(project, "src", "a.py"), content: "x" }).stdout)).toContain("default export is a number");
    writeFileSync(join(project, "bounded.config.ts"), 'import missing from "uninstalled-pack";\nexport default missing;\n');
    expect(refusal(hook(binary, project, dataHome, "Write", { file_path: join(project, "src", "a.py"), content: "x" }).stdout)).toMatch(/uninstalled-pack|not installed|not pinned/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 240_000);
