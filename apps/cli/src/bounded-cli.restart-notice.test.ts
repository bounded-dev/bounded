// The restart notice: which agent host sessions must restart after `bounded
// init` or `bounded update`, per host, from what the CLI knows. Claude Code
// runs the hook in a fresh node process on every tool call, so new code is
// live at once; it reads its hook settings at session start, so it restarts
// only when its installer changed them. pi loads bounded in-process at
// session start, so it restarts when its loader changed or the installed
// bounded's version changed (or when that cannot be known). `init` writes
// the hooks for the first time, so it says to restart every host it set up.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runBoundedCli } from "./bounded-cli.ts";

/** The running CLI's own version: the version the notice names. */
const OWN = (JSON.parse(readFileSync(resolve(import.meta.dir, "../package.json"), "utf8")) as { version: string }).version;

const CLAUDE_CODE_RESTART = "Restart Claude Code sessions in this project so they load the new hooks.";
const PI_RESTART = `Restart pi sessions in this project to load bounded ${OWN}.`;
const PI_RESTART_VERSION_UNKNOWN = `Restart pi sessions in this project to load bounded ${OWN} (the version it replaced is not known).`;
const NO_RESTART = `No need to restart existing sessions: bounded ${OWN} is live on the next tool call.`;

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
  const ran = await runBoundedCli(["update", "--no-upgrade", "--previous-version", OWN], root);
  if (ran.exitCode !== 0) throw new Error(ran.stderr);
}

describe("the restart notice: per host, only when a session must restart", () => {
  test("Claude Code settings changed: says to restart Claude Code sessions, and nothing else", async () => {
    const root = project([".claude"]);
    const ran = await runBoundedCli(["update", "--no-upgrade", "--previous-version", OWN], root);
    expect(ran.stderr).toBe("");
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout).toContain("claude-code: updated claude-code.hook");
    expect(ran.stdout).toContain(CLAUDE_CODE_RESTART);
    expect(ran.stdout).not.toContain("No need to restart");
    expect(ran.stdout).not.toContain("Restart pi");
  });

  test("Claude Code settings unchanged, even across a version change: no restart line, and the one no-restart line", async () => {
    const root = project([".claude"]);
    await installedBefore(root);
    for (const previous of [OWN, "3.0.0"]) {
      const ran = await runBoundedCli(["update", "--no-upgrade", "--previous-version", previous], root);
      expect(ran.exitCode).toBe(0);
      expect(ran.stdout).toContain("claude-code: up to date");
      expect(ran.stdout).not.toMatch(/^Restart/m);
      expect(ran.stdout).toContain(NO_RESTART);
    }
  });

  test("update --no-upgrade with nothing changed and only Claude Code installed prints the no-restart line, with or without the previous version", async () => {
    const root = project([".claude"]);
    await installedBefore(root);
    const ran = await runBoundedCli(["update", "--no-upgrade"], root);
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout).not.toMatch(/^Restart/m);
    expect(ran.stdout).toContain(NO_RESTART);
  });

  test("pi installed with a version change: says to restart pi sessions to load the new version", async () => {
    const root = project([".claude", ".pi"]);
    await installedBefore(root);
    const ran = await runBoundedCli(["update", "--no-upgrade", "--previous-version", "3.0.0"], root);
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout).toContain("pi: up to date");
    expect(ran.stdout).toContain(PI_RESTART);
    expect(ran.stdout).not.toContain(CLAUDE_CODE_RESTART);
    expect(ran.stdout).not.toContain("No need to restart");
  });

  test("pi's loader changed with the version unchanged: says to restart pi sessions", async () => {
    const root = project([".pi"]);
    const ran = await runBoundedCli(["update", "--no-upgrade", "--previous-version", OWN], root);
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout).toContain("pi: updated pi.hook");
    expect(ran.stdout).toContain(PI_RESTART);
    expect(ran.stdout).not.toContain("No need to restart");
  });

  test("pi installed, nothing changed: no restart line, and the one no-restart line", async () => {
    const root = project([".claude", ".pi"]);
    await installedBefore(root);
    const ran = await runBoundedCli(["update", "--no-upgrade", "--previous-version", OWN], root);
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout).toContain("pi: up to date");
    expect(ran.stdout).not.toMatch(/^Restart/m);
    expect(ran.stdout).toContain(NO_RESTART);
  });

  test("a hand-off without the previous version (an older CLI's): the version change is unknown, so pi is told to restart, conservatively", async () => {
    const root = project([".claude", ".pi"]);
    await installedBefore(root);
    const ran = await runBoundedCli(["update", "--no-upgrade"], root);
    expect(ran.stderr).toBe("");
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout).toContain(PI_RESTART_VERSION_UNKNOWN);
    expect(ran.stdout).not.toContain(CLAUDE_CODE_RESTART);
    expect(ran.stdout).not.toContain("No need to restart");
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

  test("a host another package installs: told to restart only when its installer changed a file", async () => {
    const root = project([]);
    const third = join(root, "node_modules", "third-party");
    mkdirSync(third, { recursive: true });
    writeFileSync(join(third, "package.json"), JSON.stringify({ name: "third-party", version: "1.0.0", type: "module", exports: { "./host-installer": "./host-installer.js" } }));
    writeFileSync(join(third, "host-installer.js"), writesOnce("third"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demo", devDependencies: { bounded: OWN, "third-party": "1.0.0" } }));
    const first = await runBoundedCli(["update", "--no-upgrade", "--previous-version", OWN], root);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("Restart third sessions in this project so they load the new hooks.");
    const second = await runBoundedCli(["update", "--no-upgrade", "--previous-version", OWN], root);
    expect(second.stdout).not.toMatch(/^Restart/m);
    expect(second.stdout).toContain(NO_RESTART);
  });

  test("update --no-upgrade refuses a previous version that is not one, as not understood", async () => {
    const root = project([".claude"]);
    for (const args of [["update", "--no-upgrade", "--previous-version"], ["update", "--no-upgrade", "--previous-version", "../x"], ["update", "--no-upgrade", "--previous-version", "3.0.0", "--previous-version", "3.0.0"]]) {
      const ran = await runBoundedCli(args, root);
      expect(ran.exitCode).toBe(2);
      expect(ran.stderr).toContain("--previous-version");
    }
  });
});
