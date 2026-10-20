import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { verifyReleaseArchive } from "../release-manifest.ts";

const REPO = resolve(import.meta.dir, "../../..");

function nativeTarget(): string {
  if (process.platform === "darwin") return `darwin-${process.arch}`;
  if (process.platform === "win32") return `windows-${process.arch}`;
  if (process.platform === "linux") {
    const ldd = Bun.spawnSync(["ldd", "--version"], { stdout: "pipe", stderr: "pipe" });
    const report = `${ldd.stdout.toString()} ${ldd.stderr.toString()}`.toLowerCase();
    if (report.includes("musl")) return `linux-${process.arch}-musl`;
    if (report.includes("glibc") || report.includes("gnu libc")) return `linux-${process.arch}-gnu`;
  }
  throw new Error(`No native standalone target for ${process.platform}/${process.arch}`);
}

function successful(command: readonly string[], cwd: string): void {
  const [program, ...args] = command;
  if (program === undefined) throw new Error("No program to run");
  const ran = Bun.spawnSync([program, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (ran.exitCode !== 0) throw new Error(`${command.join(" ")} failed: ${ran.stdout.toString()}${ran.stderr.toString()}`);
}

interface Fixture {
  readonly root: string;
  readonly binary: string;
  readonly releaseIdentity: string;
  readonly releaseReceipt: string;
  readonly dataHome: string;
  readonly project: string;
  readonly managerLog: string;
  readonly version: string;
}

async function fixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "bounded-standalone-cli-routing-"));
  const source = join(root, "build-checkout");
  const release = join(root, "release");
  const project = join(root, "python project's space");
  const fakeBin = join(root, "fake-bin");
  const managerLog = join(root, "package-manager.log");
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(join(project, ".claude"), { recursive: true });
  writeFileSync(join(project, "main.py"), "print('hello')\n");
  writeFileSync(join(project, ".claude", "settings.json"), '{"hooks":{},"custom":true}\n');
  // A package-manager fallback has an observable effect even when it later refuses.
  for (const name of ["npm", "npx", "bun", "bunx", "pnpm", "yarn", "node"]) {
    const path = join(fakeBin, process.platform === "win32" ? `${name}.cmd` : name);
    writeFileSync(path, process.platform === "win32"
      ? `@echo off\r\necho ${name}>>"%MANAGER_LOG%"\r\nexit /b 83\r\n`
      : `#!/bin/sh\nprintf '%s\\n' '${name}' >> "$MANAGER_LOG"\nexit 83\n`);
    if (process.platform !== "win32") chmodSync(path, 0o755);
  }
  successful(["git", "clone", "--quiet", "--no-hardlinks", REPO, source], REPO);
  cpSync(join(REPO, "src"), join(source, "src"), { recursive: true, force: true });
  cpSync(join(REPO, "bun.lock"), join(source, "bun.lock"), { force: true });
  // Compile against the checked-out workspace dependencies, then remove this
  // build checkout before executing the archive's binary.
  successful([process.execPath, "install", "--frozen-lockfile", "--offline"], source);
  const target = nativeTarget();
  successful([process.execPath, join(source, "src", "build-release.ts"), "--target", target, "--smoke", "--out", release], source);
  const version = (JSON.parse(readFileSync(join(source, "src", "package.json"), "utf8")) as { version: string }).version;
  const manifest = JSON.parse(readFileSync(join(release, `bounded-v${version}-manifest-v1.json`), "utf8")) as Parameters<typeof verifyReleaseArchive>[0];
  const entry = manifest.targets[target];
  if (entry === undefined) throw new Error(`release lacks ${target}`);
  const verified = await verifyReleaseArchive(manifest, target, readFileSync(join(release, entry.archive.name)));
  if (!verified.ok) throw new Error(verified.error);
  const dataHome = join(root, "user-data");
  const installed = join(dataHome, "bounded", "releases", `v${version}`, target);
  mkdirSync(installed, { recursive: true });
  for (const [path, contents] of Object.entries(verified.value)) {
    const destination = join(installed, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, contents);
  }
  const binary = join(installed, entry.executable.path);
  if (!existsSync(binary)) throw new Error("verified release lacks executable");
  if (process.platform !== "win32") chmodSync(binary, 0o755);
  const releaseIdentity = join(installed, "release.json");
  if (!existsSync(releaseIdentity)) throw new Error("verified release lacks release.json");
  const stableManifest = Buffer.from(`${JSON.stringify({ ...manifest, channel: "stable" })}\n`);
  const manifestDigest = createHash("sha256").update(stableManifest).digest("hex");
  const receiptDirectory = join(dataHome, "bounded", "receipts", `v${version}`, target);
  mkdirSync(join(receiptDirectory, "manifests"), { recursive: true });
  writeFileSync(join(receiptDirectory, "manifests", `${manifestDigest}.json`), stableManifest);
  const releaseReceipt = join(receiptDirectory, "receipt-v1.json");
  writeFileSync(releaseReceipt, `${JSON.stringify({ schema: "bounded-install-receipt/1", version, target, manifestSha256: manifestDigest })}\n`);
  rmSync(source, { recursive: true, force: true });
  rmSync(release, { recursive: true, force: true });
  expect(existsSync(source)).toBe(false);
  return { root, binary, releaseIdentity, releaseReceipt, dataHome, project, managerLog, version };
}

function run(f: Fixture, args: readonly string[], cwd = f.project, stdin?: string): { readonly exitCode: number; readonly stdout: string; readonly stderr: string } {
  const executable = Bun.spawnSync([f.binary, ...args], {
    cwd,
    env: { ...process.env, PATH: join(f.root, "fake-bin"), MANAGER_LOG: f.managerLog, XDG_STATE_HOME: join(f.root, "state"),
      XDG_DATA_HOME: f.dataHome, LOCALAPPDATA: f.dataHome, CLAUDE_PROJECT_DIR: f.project },
    ...(stdin === undefined ? {} : { stdin: new TextEncoder().encode(stdin) }),
    stdout: "pipe", stderr: "pipe",
  });
  return { exitCode: executable.exitCode, stdout: executable.stdout.toString(), stderr: executable.stderr.toString() };
}

function projectBytes(f: Fixture): { readonly python: string; readonly settings: string; readonly configExists: boolean; readonly pinExists: boolean } {
  return {
    python: readFileSync(join(f.project, "main.py"), "utf8"),
    settings: readFileSync(join(f.project, ".claude", "settings.json"), "utf8"),
    configExists: existsSync(join(f.project, "bounded.config.ts")),
    pinExists: existsSync(join(f.project, ".bounded", "version.json")),
  };
}

test("archive-only executable routes unsupported commands locally and check requires a project pin", async () => {
  const f = await fixture();
  try {
    expect(run(f, ["--version"])).toMatchObject({ exitCode: 0, stdout: `${f.version}\n`, stderr: "" });
    const before = projectBytes(f);
    for (const args of [
      ["init", "--host", "pi"], ["update"],
      ["host", "pi"], ["catalog", "build"], ["unknown"], ["init", "--no-install"],
    ]) {
      const answer = run(f, args);
      expect(answer.exitCode).not.toBe(0);
      expect(answer.stderr).toMatch(/standalone|executable|unsupported|unavailable/i);
      expect(answer.stdout).not.toContain("handed over");
      expect(projectBytes(f)).toEqual(before);
      expect(existsSync(f.managerLog)).toBe(false);
    }
    const unpinnedCheck = run(f, ["check"]);
    expect(unpinnedCheck.exitCode).not.toBe(0);
    expect(unpinnedCheck.stderr).toMatch(/pin|version\.json|bounded init/i);
    expect(projectBytes(f)).toEqual(before);
    expect(existsSync(f.managerLog)).toBe(false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}, 240_000);

test("archive-only init installs Claude Code hooks and pins its executable in a Python project without package managers", async () => {
  const f = await fixture();
  try {
    expect(existsSync(join(f.project, "package.json"))).toBe(false);
    const answer = run(f, ["init", "--host", "claude-code"]);
    expect(answer.exitCode).toBe(0);
    expect(answer.stderr).toBe("");
    expect(existsSync(join(f.project, "bounded.config.ts"))).toBe(true);
    expect(JSON.parse(readFileSync(join(f.project, ".bounded", "version.json"), "utf8"))).toEqual({ schema: "bounded-project-version/1", version: f.version });
    const settings = JSON.parse(readFileSync(join(f.project, ".claude", "settings.json"), "utf8")) as { custom: boolean; hooks: Record<string, { hooks: { command: string }[] }[]> };
    expect(settings.custom).toBe(true);
    for (const event of ["PreToolUse", "PostToolUse", "PostToolUseFailure", "SubagentStop"]) {
      const entries = settings.hooks[event] ?? [];
      expect(entries).toHaveLength(1);
      const command = entries[0]?.hooks[0]?.command ?? "";
      expect(command).toContain("hook claude-code");
      expect(command).not.toMatch(/\b(?:node|bun|npm|npx)\b/);
      if (event === "SubagentStop") expect(command).not.toContain("exit 2");
      else expect(command).toContain("exit 2");
    }
    expect(existsSync(f.managerLog)).toBe(false);
    const checked = run(f, ["check"]);
    expect(checked).toMatchObject({ exitCode: 0, stderr: "" });
    expect(checked.stdout).toMatch(/checked|valid|ready/i);
    expect(existsSync(f.managerLog)).toBe(false);
    const installedSettings = readFileSync(join(f.project, ".claude", "settings.json"));
    writeFileSync(join(f.project, ".claude", "settings.json"), '{"hooks":{}}\n');
    const noHost = run(f, ["check"]);
    expect(noHost.exitCode).not.toBe(0);
    expect(noHost.stderr).toMatch(/host|Claude Code|init/i);
    writeFileSync(join(f.project, ".claude", "settings.json"), installedSettings);
    const validReceipt = readFileSync(f.releaseReceipt);
    rmSync(f.releaseReceipt);
    const missingReceipt = run(f, ["check"]);
    expect(missingReceipt.exitCode).not.toBe(0);
    expect(missingReceipt.stderr).toMatch(/receipt|install/i);
    writeFileSync(f.releaseReceipt, "{ malformed\n");
    const malformedReceipt = run(f, ["check"]);
    expect(malformedReceipt.exitCode).not.toBe(0);
    expect(malformedReceipt.stderr).toMatch(/receipt|install/i);
    writeFileSync(f.releaseReceipt, validReceipt);
    renameSync(join(f.project, "bounded.config.ts"), join(f.project, "bounded.config.ts.saved"));
    const missingConfig = run(f, ["check"]);
    expect(missingConfig.exitCode).not.toBe(0);
    expect(missingConfig.stderr).toMatch(/bounded\.config\.ts|configuration/i);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}, 240_000);

test("standalone Claude Code init replaces only owned legacy hooks and preserves user settings on a repeated write-once init", async () => {
  const f = await fixture();
  try {
    const legacy = 'node "$CLAUDE_PROJECT_DIR/node_modules/bounded/dist/hosts/claude-code/hook.js"';
    const wrapped = `{\n${legacy}\n} || { echo "bounded hook failed" >&2; exit 2; }`;
    const entry = (command: string) => ({ matcher: "", hooks: [{ type: "command", command, timeout: 30 }] });
    const role = entry(`${legacy} --role reviewer`);
    const lookalike = entry('node "$CLAUDE_PROJECT_DIR/node_modules/bounded/dist/hosts/claude-code/hook.js.bak"');
    const unrelated = entry("lint");
    const settingsPath = join(f.project, ".claude", "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ model: "opus", custom: { key: [1, 2] }, hooks: {
      PreToolUse: [entry(wrapped), role, lookalike, unrelated],
      PostToolUse: [entry(wrapped)], PostToolUseFailure: [entry(wrapped)], SubagentStop: [entry(legacy)], Stop: [unrelated],
    } }));
    chmodSync(settingsPath, 0o640);
    expect(run(f, ["init", "--host", "claude-code"]).exitCode).toBe(0);
    const first = readFileSync(settingsPath, "utf8");
    const settings = JSON.parse(first) as { model: string; custom: unknown; hooks: Record<string, { hooks: { command: string }[] }[]> };
    expect(settings.model).toBe("opus");
    expect(settings.custom).toEqual({ key: [1, 2] });
    expect(settings.hooks.Stop).toEqual([unrelated]);
    expect(settings.hooks.PreToolUse).toContainEqual(role);
    expect(settings.hooks.PreToolUse).toContainEqual(lookalike);
    expect(settings.hooks.PreToolUse).toContainEqual(unrelated);
    for (const event of ["PreToolUse", "PostToolUse", "PostToolUseFailure", "SubagentStop"]) {
      const commands = (settings.hooks[event] ?? []).flatMap((hook) => hook.hooks.map((item) => item.command));
      expect(commands.filter((command) => command.includes("hook claude-code"))).toHaveLength(1);
      expect(commands).not.toContain(wrapped);
      expect(commands).not.toContain(legacy);
    }
    if (process.platform !== "win32") expect(statSync(settingsPath).mode & 0o777).toBe(0o640);
    const again = run(f, ["init", "--host", "claude-code"]);
    expect(again.exitCode).not.toBe(0); // init is write-once; update owns a later refresh.
    expect(readFileSync(settingsPath, "utf8")).toBe(first);
    expect(existsSync(f.managerLog)).toBe(false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
}, 240_000);

test("installed standalone Claude Code command applies the generated rule, launches lifecycle events and fails closed without its executable", async () => {
  const f = await fixture();
  try {
    expect(run(f, ["init", "--host", "claude-code"]).exitCode).toBe(0);
    const settings = JSON.parse(readFileSync(join(f.project, ".claude", "settings.json"), "utf8")) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    const command = settings.hooks.PreToolUse?.[0]?.hooks[0]?.command ?? "";
    const payload = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: join(f.project, "bounded.config.ts"), old_string: "x", new_string: "y" }, cwd: f.project, session_id: "session", tool_use_id: "tool" });
    const shell = process.platform === "win32" ? ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command] : ["/bin/sh", "-c", command];
    const invoke = () => Bun.spawnSync(shell, { cwd: f.project, env: { ...process.env, PATH: `${dirname(f.binary)}${process.platform === "win32" ? ";" : ":"}${join(f.root, "fake-bin")}`, XDG_STATE_HOME: join(f.root, "state"), XDG_DATA_HOME: f.dataHome, LOCALAPPDATA: f.dataHome, CLAUDE_PROJECT_DIR: f.project, MANAGER_LOG: f.managerLog }, stdin: new TextEncoder().encode(payload), stdout: "pipe", stderr: "pipe" });
    const judged = invoke();
    expect(judged.exitCode).toBe(0);
    const decision = JSON.parse(judged.stdout.toString()) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
    expect(decision.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain("the rule '**/bounded.config.*' from bounded/project");
    const log = readFileSync(join(f.project, ".bounded", "log.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { verdict: { kind: string } });
    expect(log.at(-1)?.verdict.kind).toBe("refuse");
    // The archive test proves every installed command launches. Detailed afterTool
    // and run-finish semantics are covered by the host's composition-root and
    // main end-to-end lifecycle tests.
    for (const event of ["PostToolUse", "PostToolUseFailure", "SubagentStop"]) {
      const eventCommand = settings.hooks[event]?.[0]?.hooks[0]?.command ?? "";
      const eventShell = process.platform === "win32" ? ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", eventCommand] : ["/bin/sh", "-c", eventCommand];
      const eventPayload = JSON.stringify({ hook_event_name: event, tool_name: "Edit", tool_input: { file_path: join(f.project, "main.py"), old_string: "hello", new_string: "hi" }, tool_response: {}, cwd: f.project, session_id: "session", tool_use_id: "tool", agent_id: "agent" });
      const answered = Bun.spawnSync(eventShell, { cwd: f.project, env: { ...process.env, PATH: `${dirname(f.binary)}${process.platform === "win32" ? ";" : ":"}${join(f.root, "fake-bin")}`, XDG_STATE_HOME: join(f.root, "state"), XDG_DATA_HOME: f.dataHome, LOCALAPPDATA: f.dataHome, CLAUDE_PROJECT_DIR: f.project, MANAGER_LOG: f.managerLog }, stdin: new TextEncoder().encode(eventPayload), stdout: "pipe", stderr: "pipe" });
      expect(answered.exitCode).toBe(0);
      expect(answered.stderr.toString()).not.toContain("bounded hook failed");
    }
    const installedReceipt = readFileSync(f.releaseReceipt);
    const decisionsBeforeTamper = readFileSync(join(f.project, ".bounded", "log.jsonl"), "utf8").trim().split("\n").length;
    const configPath = join(f.project, "bounded.config.ts");
    const installedConfig = readFileSync(configPath);
    const executionSentinel = join(f.project, "config-executed-after-receipt-tamper");
    writeFileSync(configPath, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(executionSentinel)}, "ran");\n${installedConfig.toString()}`);
    writeFileSync(f.releaseReceipt, "{ malformed\n");
    const invalidRelease = invoke();
    expect(invalidRelease.exitCode).toBe(0);
    const invalidDecision = JSON.parse(invalidRelease.stdout.toString()) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
    expect(invalidDecision.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(invalidDecision.hookSpecificOutput.permissionDecisionReason).toMatch(/receipt|reinstall/i);
    expect(existsSync(executionSentinel)).toBe(false);
    const afterInvalid = readFileSync(join(f.project, ".bounded", "log.jsonl"), "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as { verdict: { kind: string } });
    expect(afterInvalid).toHaveLength(decisionsBeforeTamper + 1);
    expect(afterInvalid.at(-1)?.verdict.kind).toBe("refuse");
    writeFileSync(f.releaseReceipt, installedReceipt);
    writeFileSync(configPath, installedConfig);
    renameSync(f.binary, `${f.binary}.missing`);
    const missing = invoke();
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr.toString()).toContain("bounded hook failed");
    expect(existsSync(f.managerLog)).toBe(false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
}, 240_000);

test("init rejects missing or malformed executable release identity before changing a Python project", async () => {
  const f = await fixture();
  try {
    const before = projectBytes(f);
    for (const identity of [null, "not json\n", '{}\n']) {
      if (identity === null) rmSync(f.releaseIdentity, { force: true });
      else writeFileSync(f.releaseIdentity, identity);
      const answer = run(f, ["init", "--host", "claude-code"]);
      expect(answer.exitCode).not.toBe(0);
      expect(answer.stderr).toMatch(/release\.json|release identity|release metadata/i);
      expect(projectBytes(f)).toEqual(before);
      expect(existsSync(f.managerLog)).toBe(false);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}, 240_000);
