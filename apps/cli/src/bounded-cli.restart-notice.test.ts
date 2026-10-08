// The restart notice: which agent host sessions must restart after `bounded
// init` or `bounded update`, per host. Claude Code runs the hook in a fresh
// node process on every tool call, so new code is live at once; it reads its
// hook settings at session start, so it restarts only when its installer
// changed them. pi loads bounded in-process at session start, and the CLI
// cannot know which bounded a running pi session loaded (a same-version
// tarball, the user's own `npm i`), so pi is always told to restart, as is
// any host another package installs. `init` writes the hooks for the first
// time, so it says to restart every host it set up.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runBoundedCli } from "./bounded-cli.ts";

/** The running CLI's own version: the version the notice names. */
const OWN = (JSON.parse(readFileSync(resolve(import.meta.dir, "../package.json"), "utf8")) as { version: string }).version;

const CLAUDE_CODE_RESTART = "Restart Claude Code sessions in this project so they load the new hooks.";
const CLAUDE_CODE_NO_RESTART = `No need to restart Claude Code sessions: bounded ${OWN} is live on their next tool call.`;
const PI_RESTART = `Restart pi sessions in this project to load bounded ${OWN}.`;

/** An installer for `host` that writes `<host>.hook` once and reports it; afterwards it changes nothing. It cannot say whether it is installed, so update runs it for its host's directory. */
const writesOnce = (host: string) => `import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export const hostInstaller = {
  host: "${host}",
  install: async (root) => {
    const path = join(root, "${host}.hook");
    if (existsSync(path)) return { ok: true, value: { host: "${host}", changedPaths: [], skippedBecause: null } };
    writeFileSync(path, "");
    return { ok: true, value: { host: "${host}", changedPaths: ["${host}.hook"], skippedBecause: null } };
  },
};
`;

/** An installer for `host` that skips the project, as pi's does a project with no .pi/. */
const skips = (host: string) =>
  `export const hostInstaller = { host: "${host}", install: async () => ({ ok: true, value: { host: "${host}", changedPaths: [], skippedBecause: "the project has no .${host}/ directory" } }) };\n`;

/** A project with a stand-in bounded bundling write-once installers for claude-code and pi, and the given host directories; initialised unless `fresh`. */
function project(dirs: readonly string[], options: { fresh?: boolean } = {}): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bounded-cli-restart-")));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demo", devDependencies: { bounded: OWN } }));
  const bounded = join(root, "node_modules", "bounded");
  mkdirSync(bounded, { recursive: true });
  writeFileSync(join(bounded, "package.json"), JSON.stringify({ name: "bounded", version: OWN, type: "module", exports: { "./hosts/claude-code/host-installer": "./claude-code.js", "./hosts/pi/host-installer": "./pi.js" } }));
  writeFileSync(join(bounded, "claude-code.js"), writesOnce("claude-code"));
  writeFileSync(join(bounded, "pi.js"), writesOnce("pi"));
  for (const dir of dirs) mkdirSync(join(root, dir));
  if (options.fresh !== true) writeFileSync(join(root, "bounded.config.ts"), "// mine\n");
  return root;
}

/** Runs the installers once, as the earlier init did, so the next run changes nothing. */
async function installedBefore(root: string): Promise<void> {
  const ran = await runBoundedCli(["update", "--no-upgrade"], root);
  if (ran.exitCode !== 0) throw new Error(ran.stderr);
}

describe("the restart notice: per host, only when a session must restart", () => {
  test("Claude Code settings changed by an update: says to restart Claude Code sessions, and no no-restart line", async () => {
    const root = project([".claude"]);
    const ran = await runBoundedCli(["update", "--no-upgrade"], root);
    expect(ran.stderr).toBe("");
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout).toContain("claude-code: updated claude-code.hook");
    expect(ran.stdout).toContain(CLAUDE_CODE_RESTART);
    expect(ran.stdout).not.toContain("No need to restart");
    expect(ran.stdout).not.toContain("Restart pi");
  });

  test("Claude Code settings unchanged by an update: no restart line, and Claude Code's own no-restart line", async () => {
    const root = project([".claude"]);
    await installedBefore(root);
    const ran = await runBoundedCli(["update", "--no-upgrade"], root);
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout).toContain("claude-code: up to date");
    expect(ran.stdout).not.toMatch(/^Restart/m);
    expect(ran.stdout).toContain(CLAUDE_CODE_NO_RESTART);
  });

  test("pi installed, nothing changed (as after a same-version --from tarball): still told to restart, since the CLI cannot know which bounded a running pi session loaded", async () => {
    const root = project([".claude", ".pi"]);
    await installedBefore(root);
    const ran = await runBoundedCli(["update", "--no-upgrade"], root);
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout).toContain("pi: up to date");
    expect(ran.stdout).toContain(PI_RESTART);
    expect(ran.stdout).not.toContain(CLAUDE_CODE_RESTART);
    expect(ran.stdout).toContain(CLAUDE_CODE_NO_RESTART);
  });

  test("pi's loader changed by an update: says to restart pi sessions, and no no-restart line", async () => {
    const root = project([".pi"]);
    const ran = await runBoundedCli(["update", "--no-upgrade"], root);
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout).toContain("pi: updated pi.hook");
    expect(ran.stdout).toContain(PI_RESTART);
    expect(ran.stdout).not.toContain("No need to restart");
  });

  test("pi alone, nothing changed: told to restart, with no line saying anything is live", async () => {
    const root = project([".pi"]);
    await installedBefore(root);
    const ran = await runBoundedCli(["update", "--no-upgrade"], root);
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout).toContain(PI_RESTART);
    expect(ran.stdout).not.toContain("No need to restart");
    expect(ran.stdout).not.toContain("live");
  });

  test("init: says to restart the sessions of every host it set up", async () => {
    const both = project([".claude", ".pi"], { fresh: true });
    const ran = await runBoundedCli(["init", "--no-install"], both);
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout).toContain(CLAUDE_CODE_RESTART);
    expect(ran.stdout).toContain(PI_RESTART);
    expect(ran.stdout).not.toContain("No need to restart");
    const claudeOnly = project([".claude"], { fresh: true });
    const claude = await runBoundedCli(["init", "--no-install"], claudeOnly);
    expect(claude.exitCode).toBe(0);
    expect(claude.stdout).toContain(CLAUDE_CODE_RESTART);
    expect(claude.stdout).not.toContain("Restart pi");
  });

  test("every host skipped (init --no-install --host pi without .pi/): no restart line, and no line saying bounded is live", async () => {
    const root = project([], { fresh: true });
    writeFileSync(join(root, "node_modules", "bounded", "pi.js"), skips("pi"));
    const ran = await runBoundedCli(["init", "--no-install", "--host", "pi"], root);
    expect(ran.stderr).toBe("");
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout).toContain("pi: skipped");
    expect(ran.stdout).not.toMatch(/restart/i);
    expect(ran.stdout).not.toContain("live");
  });

  test("a host another package installs: told to restart after every update, to load the new hooks or the new bounded", async () => {
    const root = project([]);
    const third = join(root, "node_modules", "third-party");
    mkdirSync(third, { recursive: true });
    writeFileSync(join(third, "package.json"), JSON.stringify({ name: "third-party", version: "1.0.0", type: "module", exports: { "./host-installer": "./host-installer.js" } }));
    writeFileSync(join(third, "host-installer.js"), writesOnce("third"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demo", devDependencies: { bounded: OWN, "third-party": "1.0.0" } }));
    const first = await runBoundedCli(["update", "--no-upgrade"], root);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("Restart third sessions in this project so they load the new hooks.");
    const second = await runBoundedCli(["update", "--no-upgrade"], root);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain(`Restart third sessions in this project to load bounded ${OWN}.`);
    expect(second.stdout).not.toContain("No need to restart");
  });
});
