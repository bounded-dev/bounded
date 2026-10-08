// End to end, from the one packed tarball, `bounded`: its prepack compiles
// the library, the CLI and the host adapters to JavaScript for Node in dist/.
// The first install runs `npx -p <dir>/bounded-<v>.tgz bounded init --from
// <dir>` before the project has any bounded package; it adds bounded and
// hands over to the installed bounded, which writes the configuration (the
// core, the path gate and its two default rules) and installs the hooks of
// the hosts found. After that, `npx bounded update --from` runs the project's
// own bin, upgrades, and hands over to the newer bounded it installs. Under
// npm with no bun on PATH, the installed Claude Code hook, run by node as
// Claude Code runs it, judges calls with the path gate.
// The registry path is unit-tested with a stub runner (bounded-cli.registry.test.ts).
import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../../..");
const CORE = join(REPO, "contexts/core");
const VERSION = (JSON.parse(readFileSync(join(CORE, "package.json"), "utf8")) as { version: string }).version;
/** The Claude Code hook as installed: node runs bounded's bundled hook, found through CLAUDE_PROJECT_DIR. */
const HOOK = 'node "$CLAUDE_PROJECT_DIR/node_modules/bounded/dist/hosts/claude-code/hook.js"';
/** The restart notice's lines (bounded-cli.restart-notice.test.ts has every case). */
const CLAUDE_CODE_RESTART = "Restart Claude Code sessions in this project so they load the new hooks.";
const piRestart = (version: string): string => `Restart pi sessions in this project to load bounded ${version}.`;
const claudeCodeNoRestart = (version: string): string => `No need to restart Claude Code sessions: bounded ${version} is live on their next tool call.`;

/** PATH as a user's shell has it, or with every directory holding a `bun` removed. */
function pathWith(bun: boolean): string {
  const entries = (process.env.PATH ?? "").split(delimiter);
  return (bun ? entries : entries.filter((entry) => entry !== "" && !existsSync(join(entry, "bun")))).join(delimiter);
}

function run(command: readonly string[], cwd: string, options: { bun?: boolean; stdin?: string; env?: Record<string, string> } = {}): { exitCode: number; stdout: string; stderr: string } {
  // As from a user's shell: `bun run check` sets npm_config_user_agent to bun's, and npx keeps an inherited one.
  const { npm_config_user_agent: _inherited, ...env } = process.env;
  const ran = Bun.spawnSync([...command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    ...(options.stdin === undefined ? {} : { stdin: new TextEncoder().encode(options.stdin) }),
    env: { ...env, npm_config_yes: "true", PATH: pathWith(options.bun ?? true), ...options.env },
  });
  return { exitCode: ran.exitCode, stdout: ran.stdout.toString(), stderr: ran.stderr.toString() };
}

function mustRun(command: readonly string[], cwd: string, options: { bun?: boolean } = {}): string {
  const ran = run(command, cwd, options);
  if (ran.exitCode !== 0) throw new Error(`${command.join(" ")} failed (${ran.exitCode}):\n${ran.stdout}\n${ran.stderr}`);
  return ran.stdout;
}

/** Packs bounded as it is into `into`: the tarball a release publishes (its prepack builds dist/). */
const packBounded = (into: string): void => void mustRun(["bun", "pm", "pack", "--destination", into, "--quiet"], CORE);

/** Packs a copy of bounded as version `version`, built from copies of the core and the apps it bundles: a later release, for the update to install. */
function packRelease(version: string, scratch: string, into: string): void {
  for (const app of ["apps/cli", "apps/claude-code", "apps/pi"]) cpSync(join(REPO, app, "src"), join(scratch, app, "src"), { recursive: true });
  const copy = join(scratch, "contexts/core");
  cpSync(join(CORE, "src"), join(copy, "src"), { recursive: true });
  cpSync(join(CORE, "build-dist.ts"), join(copy, "build-dist.ts"));
  // The private shell command reader the build carries into dist (ADR 2026-020).
  const reader = join(scratch, "contexts/shell-command-reader");
  cpSync(join(REPO, "contexts/shell-command-reader/src"), join(reader, "src"), { recursive: true });
  cpSync(join(REPO, "contexts/shell-command-reader/package.json"), join(reader, "package.json"));
  // The build emits declarations with tsc, against the base tsconfig and the workspace's libraries, as in the checkout.
  cpSync(join(CORE, "tsconfig.types.json"), join(copy, "tsconfig.types.json"));
  cpSync(join(REPO, "tsconfig.base.json"), join(scratch, "tsconfig.base.json"));
  // The workspace's libraries, with its own packages resolving to the copies, as the checkout's resolve to themselves.
  mkdirSync(join(scratch, "node_modules"));
  const copies: Record<string, string> = { bounded: copy, "bounded-shell-command-reader": reader };
  for (const entry of readdirSync(join(REPO, "node_modules"))) symlinkSync(copies[entry] ?? join(REPO, "node_modules", entry), join(scratch, "node_modules", entry), "dir");
  const manifest = JSON.parse(readFileSync(join(CORE, "package.json"), "utf8")) as { version: string };
  manifest.version = version;
  writeFileSync(join(copy, "package.json"), JSON.stringify(manifest, null, 2));
  mustRun(["bun", "pm", "pack", "--destination", into, "--quiet"], copy);
}

const tarball = (dir: string, version: string): string => join(dir, `bounded-${version}.tgz`);
const json = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const versionOf = (project: string): string => json<{ version: string }>(join(project, "node_modules", "bounded", "package.json")).version;
const settingsOf = (project: string): { hooks: Record<string, { hooks: { command: string }[] }[]> } => json(join(project, ".claude", "settings.json"));

describe("npx bounded end to end, from the one bounded tarball, under node", () => {
  test("bounded's tarball carries every entry the bin, the hooks and the pi loader run, and its bin runs under node", () => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "bounded-e2e-tarball-")));
    packBounded(join(scratch, "release"));
    const listed = mustRun(["tar", "-tzf", tarball(join(scratch, "release"), VERSION)], scratch).split("\n");
    for (const entry of ["dist/cli.js", "dist/hosts/claude-code/hook.js", "dist/hosts/claude-code/host-installer.js", "dist/hosts/pi/index.js", "dist/hosts/pi/host-installer.js", "dist/domain/index.js", "dist/packs/path-gate/index.js"]) {
      expect(listed).toContain(`package/${entry}`);
    }
    mustRun(["tar", "-xzf", tarball(join(scratch, "release"), VERSION)], scratch);
    const manifest = json<{ bin: Record<string, string>; exports: Record<string, unknown> }>(join(scratch, "package", "package.json"));
    expect(manifest.bin).toEqual({ bounded: "dist/cli.js" });
    expect(manifest.exports["./hosts/pi"]).toBe("./dist/hosts/pi/index.js");
    // The bin as built for the tarball, run by node where bounded's dependencies resolve (the extracted tarball has none installed;
    // the npm case below runs it from an install).
    const usage = run(["node", join(CORE, "dist", "cli.js")], scratch, { bun: false });
    expect(usage.exitCode).toBe(2);
    expect(usage.stderr).toContain("bounded init");
    expect(usage.stdout).toBe("");
  }, 120_000);

  test("with bun: npx -p bounded's tarball bounded init --from sets a repository up for Claude Code and pi; npx bounded update --from upgrades and hands over; both are idempotent", () => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "bounded-e2e-bun-")));
    const first = join(scratch, "release-1");
    const second = join(scratch, "release-2");
    packBounded(first);
    packRelease("99.0.0", join(scratch, "copies"), second);

    const project = join(scratch, "project");
    mkdirSync(join(project, ".claude"), { recursive: true });
    mkdirSync(join(project, ".pi"));
    mustRun(["git", "init", "--quiet"], project);
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "demo", private: true, packageManager: `bun@${Bun.version}` }));

    const init = run(["npx", "--yes", "-p", tarball(first, VERSION), "bounded", "init", "--from", first], project);
    expect(init.stderr).toBe("");
    expect(init.exitCode).toBe(0);
    expect(init.stdout).toContain(`bounded ${VERSION}`);
    expect(init.stdout).toMatch(/restart/i);
    expect(init.stdout).toContain(CLAUDE_CODE_RESTART);
    expect(init.stdout).toContain(piRestart(VERSION));
    const manifest = json<{ devDependencies: Record<string, string>; overrides: Record<string, string> }>(join(project, "package.json"));
    expect(Object.keys(manifest.devDependencies)).toEqual(["bounded"]);
    expect(manifest.overrides.bounded).toBe(`file:${tarball(first, VERSION)}`);
    expect(existsSync(join(project, "node_modules", ".bin", "bounded"))).toBe(true);
    expect(existsSync(join(project, "node_modules", "bounded", "dist", "hosts", "claude-code", "hook.js"))).toBe(true);
    expect(init.stdout).toContain("claude-code: updated .claude/settings.json");
    expect(init.stdout).toContain("pi: updated .pi/extensions/bounded/index.ts");
    const config = readFileSync(join(project, "bounded.config.ts"), "utf8");
    expect(config).toContain("packs: [pathGate],");
    expect(config).toContain('match: "**/bounded.config.*"');
    expect(config).toContain('match: ".bounded/**"');
    const settingsText = readFileSync(join(project, ".claude", "settings.json"), "utf8");
    for (const event of ["PreToolUse", "PostToolUse", "PostToolUseFailure"]) expect(settingsOf(project).hooks[event]?.map((entry) => entry.hooks[0]?.command)).toEqual([`{\n${HOOK}\n} || { echo "bounded hook failed" >&2; exit 2; }`]);
    expect(settingsText).not.toContain(project);
    expect(settingsText).not.toContain(REPO);
    const loader = readFileSync(join(project, ".pi", "extensions", "bounded", "index.ts"), "utf8");
    expect(loader).toContain('"bounded/hosts/pi"');
    // The installed hook reads a Bash command with the reader bounded ships (bounded/shell-command-reader): a shell write to git's hooks is refused by init's rule.
    const hookCommand = settingsOf(project).hooks.PreToolUse?.[0]?.hooks[0]?.command ?? "";
    const bash = run(["sh", "-c", hookCommand], project, {
      env: { CLAUDE_PROJECT_DIR: project },
      stdin: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo x > .git/hooks/pre-commit" }, cwd: project, session_id: "s", tool_use_id: "toolu_bash" }),
    });
    expect(bash.exitCode).toBe(0);
    expect((JSON.parse(bash.stdout) as { hookSpecificOutput: { permissionDecisionReason: string } }).hookSpecificOutput.permissionDecisionReason).toContain("the rule '.git/hooks/**' from bounded/project");

    const again = run(["npx", "--no-install", "bounded", "init"], project);
    expect(again.exitCode).toBe(1);
    expect(readFileSync(join(project, "bounded.config.ts"), "utf8")).toBe(config);

    const update = run(["npx", "--no-install", "bounded", "update", "--from", second], project);
    expect(update.stderr).toBe("");
    expect(update.exitCode).toBe(0);
    expect(update.stdout).toContain("bounded 99.0.0");
    // The hooks did not change, so Claude Code needs no restart; pi loaded the old version in-process, so it does.
    expect(update.stdout).toContain(piRestart("99.0.0"));
    expect(update.stdout).not.toContain(CLAUDE_CODE_RESTART);
    expect(update.stdout).toContain(claudeCodeNoRestart("99.0.0"));
    expect(versionOf(project)).toBe("99.0.0");
    expect(json<{ overrides: Record<string, string> }>(join(project, "package.json")).overrides.bounded).toBe(`file:${tarball(second, "99.0.0")}`);
    expect(readFileSync(join(project, "bounded.config.ts"), "utf8")).toBe(config);
    expect(readFileSync(join(project, ".claude", "settings.json"), "utf8")).toBe(settingsText);
    expect(readFileSync(join(project, ".pi", "extensions", "bounded", "index.ts"), "utf8")).toBe(loader);

    const refresh = run(["npx", "--no-install", "bounded", "update", "--no-upgrade"], project);
    expect(refresh.exitCode).toBe(0);
    expect(refresh.stdout).toContain("up to date");
    // The CLI cannot know which bounded a running pi session loaded, so pi is told to restart after every update.
    expect(refresh.stdout).toContain(piRestart("99.0.0"));
    expect(refresh.stdout).toContain(claudeCodeNoRestart("99.0.0"));
    expect(readFileSync(join(project, ".claude", "settings.json"), "utf8")).toBe(settingsText);
    expect(readFileSync(join(project, "bounded.config.ts"), "utf8")).toBe(config);
  }, 300_000);

  test.skipIf(Bun.which("npm") === null)(
    "under npm with no bun on PATH (skipped when npm is not installed): init installs the hook, which node runs as Claude Code does and the path gate judges with init's default rules and a project rule; then update --from",
    () => {
      const scratch = realpathSync(mkdtempSync(join(tmpdir(), "bounded-e2e-npm-")));
      const first = join(scratch, "release-1");
      const second = join(scratch, "release-2");
      packBounded(first);
      packRelease("99.0.0", join(scratch, "copies"), second);

      // A fresh repository as `npm init -y` leaves it, using Claude Code; no bun anywhere from here on.
      const project = join(scratch, "project");
      mkdirSync(join(project, ".claude"), { recursive: true });
      mustRun(["git", "init", "--quiet"], project, { bun: false });
      mustRun(["npm", "init", "-y"], project, { bun: false });
      expect(run(["sh", "-c", "command -v bun"], project, { bun: false }).exitCode).not.toBe(0);

      const init = run(["npx", "--yes", "-p", tarball(first, VERSION), "bounded", "init", "--from", first], project, { bun: false });
      expect(init.stderr).toBe("");
      expect(init.exitCode).toBe(0);
      expect(init.stdout).toContain("with npm");
      expect(init.stdout).toContain(CLAUDE_CODE_RESTART);
      const manifest = json<{ devDependencies: Record<string, string>; overrides: Record<string, string> }>(join(project, "package.json"));
      expect(Object.keys(manifest.devDependencies)).toEqual(["bounded"]);
      expect(manifest.overrides.bounded).toBe("$bounded");

      // The project adds its own rule beside init's two defaults.
      const config = readFileSync(join(project, "bounded.config.ts"), "utf8");
      const secrets = '      { match: "secrets/**", deny: ["create", "modify", "delete"], why: "secrets are kept by people", redirect: "Ask a maintainer" },\n    ]),';
      expect(config.split("    ]),")).toHaveLength(2);
      writeFileSync(join(project, "bounded.config.ts"), config.replace("    ]),", secrets));
      mkdirSync(join(project, "secrets"));
      mkdirSync(join(project, "src"));
      writeFileSync(join(project, "secrets", "x"), "s\n");
      writeFileSync(join(project, "src", "a.ts"), "a\n");

      // Each call through the exact command settings.json holds, under sh, as Claude Code runs it.
      const command = settingsOf(project).hooks.PreToolUse?.[0]?.hooks[0]?.command ?? "";
      expect(command).toContain(HOOK);
      const hook = (tool: string, input: object) =>
        run(["sh", "-c", command], project, { bun: false, env: { CLAUDE_PROJECT_DIR: project }, stdin: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, cwd: project, session_id: "s", tool_use_id: tool }) });
      const reasonOf = (stdout: string): string => (stdout === "" ? "allowed" : (JSON.parse(stdout) as { hookSpecificOutput: { permissionDecisionReason: string } }).hookSpecificOutput.permissionDecisionReason);
      const edit = (path: string) => hook("Edit", { file_path: join(project, path), old_string: "s", new_string: "t" });

      const secret = edit("secrets/x");
      expect(secret.exitCode).toBe(0);
      expect(reasonOf(secret.stdout)).toContain("the rule 'secrets/**' from bounded/project denies modify of 'secrets/x' (secrets are kept by people)");
      expect(reasonOf(edit("bounded.config.ts").stdout)).toContain("the rule '**/bounded.config.*' from bounded/project");
      // init's default rules also keep agents off the hook's own settings.
      expect(reasonOf(edit(".claude/settings.json").stdout)).toContain("the rule '.claude/settings*.json' from bounded/project");
      // A local settings file could disable every hook: creating one is refused too.
      expect(reasonOf(hook("Write", { file_path: join(project, ".claude", "settings.local.json"), content: "{\"disableAllHooks\": true}" }).stdout)).toContain("the rule '.claude/settings*.json' from bounded/project");
      // And off git's hooks, which git runs later, outside Bounded's view.
      expect(reasonOf(hook("Bash", { command: "echo x > .git/hooks/pre-commit" }).stdout)).toContain("the rule '.git/hooks/**' from bounded/project");
      expect(reasonOf(edit("src/a.ts").stdout)).toBe("allowed");
      const shell = hook("Bash", { command: "echo hi > secrets/x" });
      expect(reasonOf(shell.stdout)).toContain("secrets/**");
      expect(readFileSync(join(project, "secrets", "x"), "utf8")).toBe("s\n");

      const update = run(["npx", "--no-install", "bounded", "update", "--from", second], project, { bun: false });
      expect(update.stderr).toBe("");
      expect(update.exitCode).toBe(0);
      expect(update.stdout).toContain("with npm");
      expect(update.stdout).toContain("bounded 99.0.0");
      // Claude Code alone, its hooks unchanged: the new version is live on the next tool call.
      expect(update.stdout).toContain(claudeCodeNoRestart("99.0.0"));
      expect(update.stdout).not.toMatch(/^Restart/m);
      expect(versionOf(project)).toBe("99.0.0");
      expect(json<{ overrides: Record<string, string> }>(join(project, "package.json")).overrides.bounded).toBe("$bounded");

      const refresh = run(["npx", "--no-install", "bounded", "update", "--no-upgrade"], project, { bun: false });
      expect(refresh.exitCode).toBe(0);
      expect(refresh.stdout).toContain("up to date");
      expect(refresh.stdout).toContain(claudeCodeNoRestart("99.0.0"));

      // The installed tarball's bin, run by node itself (npx above ran it too).
      const usage = run(["node", join(project, "node_modules", "bounded", "dist", "cli.js")], project, { bun: false });
      expect(usage.exitCode).toBe(2);
      expect(usage.stderr).toContain("bounded init");

      // Drift through the bundled hook: a command the shell guard cannot see into changes a protected file; after it ran, the file is put back.
      writeFileSync(join(project, ".gitignore"), "node_modules/\n.bounded/\n");
      const git = (...args: string[]) => mustRun(["git", "-c", "user.name=test", "-c", "user.email=test@example.com", ...args], project, { bun: false });
      git("add", "-A");
      git("commit", "--quiet", "-m", "base");
      const call = { tool_name: "Bash", tool_input: { command: "./regenerate.sh" }, tool_use_id: "toolu_drift", cwd: project, session_id: "s" };
      const beforeCall = run(["sh", "-c", command], project, { bun: false, env: { CLAUDE_PROJECT_DIR: project }, stdin: JSON.stringify({ hook_event_name: "PreToolUse", ...call }) });
      expect(beforeCall.stdout).toBe("");
      writeFileSync(join(project, "secrets", "x"), "changed\n");
      const settingsBefore = readFileSync(join(project, ".claude", "settings.json"), "utf8");
      writeFileSync(join(project, ".claude", "settings.json"), "{}\n");
      const afterCall = run(["sh", "-c", command], project, {
        bun: false,
        env: { CLAUDE_PROJECT_DIR: project },
        stdin: JSON.stringify({ hook_event_name: "PostToolUse", ...call, tool_response: { stdout: "", stderr: "", interrupted: false } }),
      });
      expect(afterCall.exitCode).toBe(0);
      expect((JSON.parse(afterCall.stdout) as { decision: string; reason: string }).reason).toContain("secrets/x");
      expect(readFileSync(join(project, "secrets", "x"), "utf8")).toBe("s\n");
      // The settings holding the hook, protected by init's default rule, are put back too.
      expect(readFileSync(join(project, ".claude", "settings.json"), "utf8")).toBe(settingsBefore);

      // With a dependency gone, the hook still answers: a deny with the reason, exit 0, not a crash.
      rmSync(join(project, "node_modules", "picomatch"), { recursive: true, force: true });
      const broken = edit("src/a.ts");
      expect(broken.exitCode).toBe(0);
      const denied = JSON.parse(broken.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
      expect(denied.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(denied.hookSpecificOutput.permissionDecisionReason).toContain("picomatch");

      // Settings that cannot be read are not skipped by a refresh: the update refuses, saying what is wrong.
      writeFileSync(join(project, ".claude", "settings.json"), "{ broken");
      const broken2 = run(["npx", "--no-install", "bounded", "update", "--no-upgrade"], project, { bun: false });
      expect(broken2.exitCode).toBe(1);
      expect(broken2.stderr).toContain(".claude/settings.json is not valid JSON");
      expect(broken2.stderr).not.toContain("No package");
    },
    300_000,
  );
});
