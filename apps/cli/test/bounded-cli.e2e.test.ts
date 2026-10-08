// End to end, from packed tarballs: the CLI ships inside `bounded` as its bin
// (dist/cli.js, bundled from apps/cli by bounded's prepack). The first install
// runs `npx -p <dir>/bounded-<v>.tgz bounded init --from <dir>` before the
// project has any bounded package; it adds bounded and the hosts' adapters
// and hands over to the installed bounded. After that, `npx bounded update
// --from` runs the project's own bin, upgrades, and hands over to the newer
// bounded it installs, so every later version brings its own update logic.
// The registry path is unit-tested with a stub runner (bounded-cli.registry.test.ts).
import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../../..");
/** The published packages; bounded's prepack bundles the CLI from apps/cli. */
const PACKAGES = [
  { name: "bounded", dir: "contexts/core" },
  { name: "bounded-claude-code", dir: "apps/claude-code" },
  { name: "bounded-pi", dir: "apps/pi" },
] as const;

function run(command: readonly string[], cwd: string): { exitCode: number; stdout: string; stderr: string } {
  // As from a user's shell: `bun run check` sets npm_config_user_agent to bun's, and npx keeps an inherited one.
  const { npm_config_user_agent: _inherited, ...env } = process.env;
  const ran = Bun.spawnSync([...command], { cwd, stdout: "pipe", stderr: "pipe", env: { ...env, npm_config_yes: "true" } });
  return { exitCode: ran.exitCode, stdout: ran.stdout.toString(), stderr: ran.stderr.toString() };
}

function mustRun(command: readonly string[], cwd: string): string {
  const ran = run(command, cwd);
  if (ran.exitCode !== 0) throw new Error(`${command.join(" ")} failed (${ran.exitCode}):\n${ran.stdout}\n${ran.stderr}`);
  return ran.stdout;
}

/** Packs the published packages as they are into `into`, the tarballs a release would publish (bounded's prepack builds its bin). */
function packWorkspace(into: string): void {
  for (const { dir } of PACKAGES) mustRun(["bun", "pm", "pack", "--destination", into, "--quiet"], join(REPO, dir));
}

/** Packs a copy of the published packages as version `version`: a later release, for the update to install. */
function packRelease(version: string, scratch: string, into: string): void {
  // bounded's prepack bundles apps/cli's sources, so the copy has them too.
  cpSync(join(REPO, "apps/cli/src"), join(scratch, "apps/cli/src"), { recursive: true });
  for (const { dir } of PACKAGES) {
    const copy = join(scratch, dir);
    mkdirSync(copy, { recursive: true });
    cpSync(join(REPO, dir, "src"), join(copy, "src"), { recursive: true });
    const manifest = JSON.parse(readFileSync(join(REPO, dir, "package.json"), "utf8")) as { version: string; dependencies?: Record<string, string> };
    manifest.version = version;
    if (manifest.dependencies?.bounded !== undefined) manifest.dependencies.bounded = version;
    writeFileSync(join(copy, "package.json"), JSON.stringify(manifest, null, 2));
    mustRun(["bun", "pm", "pack", "--destination", into, "--quiet"], copy);
  }
}

const tarball = (dir: string, name: string, version: string): string => join(dir, `${name}-${version}.tgz`);
const json = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const versionOf = (project: string, name: string): string => json<{ version: string }>(join(project, "node_modules", name, "package.json")).version;
/** npx, or bunx when npx is missing; `--no-install` runs the project's own bin, never a download. */
const npx = (): string[] => (run(["npx", "--version"], tmpdir()).exitCode === 0 ? ["npx", "--no-install"] : ["bunx"]);
const HOOK = '"$CLAUDE_PROJECT_DIR/node_modules/bounded-claude-code/src/main.ts"';
const VERSION = json<{ version: string }>(join(REPO, "contexts/core/package.json")).version;

describe("npx bounded end to end, from packed tarballs: the CLI inside bounded", () => {
  test("bounded's tarball carries the bundled CLI, dist/cli.js, which runs under bun", () => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "bounded-cli-e2e-bin-")));
    const into = join(scratch, "release");
    mustRun(["bun", "pm", "pack", "--destination", into, "--quiet"], join(REPO, "contexts/core"));
    const listed = mustRun(["tar", "-tzf", tarball(into, "bounded", VERSION)], scratch).split("\n");
    expect(listed).toContain("package/dist/cli.js");
    mustRun(["tar", "-xzf", tarball(into, "bounded", VERSION)], scratch);
    expect(json<{ bin: Record<string, string> }>(join(scratch, "package", "package.json")).bin).toEqual({ bounded: "dist/cli.js" });
    const bundle = readFileSync(join(scratch, "package", "dist", "cli.js"), "utf8");
    // Run under bun: the hooks need bun anyway, and the CLI imports bounded's TypeScript sources, which node will not strip types from inside node_modules.
    expect(bundle.startsWith("#!/usr/bin/env bun")).toBe(true);
    expect(bundle).toContain('from "bounded/application"');
    const usage = run(["bun", join(scratch, "package", "dist", "cli.js")], scratch);
    expect(usage.exitCode).toBe(2);
    expect(usage.stderr).toContain("bounded init");
  }, 120_000);

  test("with bun: npx -p bounded's tarball bounded init --from adds bounded and the hosts' adapters and sets the repository up; npx bounded update --from upgrades and hands over to the new bounded; both are idempotent", () => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "bounded-cli-e2e-")));
    const first = join(scratch, "release-1");
    const second = join(scratch, "release-2");
    packWorkspace(first);
    packRelease("99.0.0", join(scratch, "copies"), second);

    // A fresh repository using bun, Claude Code (.claude/) and pi (.pi/), with no bounded package yet.
    const project = join(scratch, "project");
    mkdirSync(join(project, ".claude"), { recursive: true });
    mkdirSync(join(project, ".pi"));
    mustRun(["git", "init", "--quiet"], project);
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "demo", private: true, packageManager: `bun@${Bun.version}` }));

    // The first install: bounded through npx, given its tarball (bunx cannot run a bin from a tarball).
    const init = run(["npx", "--yes", "-p", tarball(first, "bounded", VERSION), "bounded", "init", "--from", first], project);
    expect(init.stderr).toBe("");
    expect(init.exitCode).toBe(0);
    expect(init.stdout).toContain(`bounded ${VERSION}`);
    expect(init.stdout).toMatch(/restart/i);
    const manifest = json<{ devDependencies: Record<string, string>; overrides: Record<string, string> }>(join(project, "package.json"));
    expect(Object.keys(manifest.devDependencies).sort()).toEqual(["bounded", "bounded-claude-code", "bounded-pi"]);
    expect(manifest.overrides.bounded).toBe(`file:${tarball(first, "bounded", VERSION)}`);
    expect(existsSync(join(project, "node_modules", ".bin", "bounded"))).toBe(true);
    expect(existsSync(join(project, "node_modules", "bounded", "dist", "cli.js"))).toBe(true);
    const config = readFileSync(join(project, "bounded.config.ts"), "utf8");
    expect(config).toContain("export default defineConfig({ packs: [corePack] });");
    const settingsText = readFileSync(join(project, ".claude", "settings.json"), "utf8");
    expect(settingsText).toContain(JSON.stringify(HOOK).slice(1, -1));
    expect(settingsText).not.toContain(project);
    expect(settingsText).not.toContain(REPO);
    const settings = JSON.parse(settingsText) as { hooks: Record<string, unknown[]> };
    for (const event of ["PreToolUse", "PostToolUse", "PostToolUseFailure"]) expect(settings.hooks[event]).toHaveLength(1);
    const loader = readFileSync(join(project, ".pi", "extensions", "bounded", "index.ts"), "utf8");
    expect(loader).toContain('"bounded-pi"');

    // init again, through the project's own bin, is refused, changing nothing
    const again = run([...npx(), "bounded", "init"], project);
    expect(again.exitCode).toBe(1);
    expect(readFileSync(join(project, "bounded.config.ts"), "utf8")).toBe(config);

    // update: the project's own bin upgrades to the later release, then the newly installed bounded refreshes the hooks
    const update = run([...npx(), "bounded", "update", "--from", second], project);
    expect(update.stderr).toBe("");
    expect(update.exitCode).toBe(0);
    expect(update.stdout).toContain("bounded 99.0.0");
    for (const { name } of PACKAGES) expect(versionOf(project, name)).toBe("99.0.0");
    expect(json<{ overrides: Record<string, string> }>(join(project, "package.json")).overrides.bounded).toBe(`file:${tarball(second, "bounded", "99.0.0")}`);
    expect(readFileSync(join(project, "bounded.config.ts"), "utf8")).toBe(config);
    expect(readFileSync(join(project, ".claude", "settings.json"), "utf8")).toBe(settingsText);
    expect(readFileSync(join(project, ".pi", "extensions", "bounded", "index.ts"), "utf8")).toBe(loader);

    // update again: idempotent
    const refresh = run([...npx(), "bounded", "update", "--no-upgrade"], project);
    expect(refresh.exitCode).toBe(0);
    expect(refresh.stdout).toContain("up to date");
    expect(readFileSync(join(project, "bounded.config.ts"), "utf8")).toBe(config);
    expect(readFileSync(join(project, ".claude", "settings.json"), "utf8")).toBe(settingsText);
  }, 300_000);

  test.skipIf(Bun.which("npm") === null)("under npm (skipped when npm is not installed): npx -p bounded's tarball bounded init --from, then npx bounded update --from to a later release", () => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "bounded-cli-e2e-npm-")));
    const first = join(scratch, "release-1");
    const second = join(scratch, "release-2");
    packWorkspace(first);
    packRelease("99.0.0", join(scratch, "copies"), second);

    // A fresh repository as `npm init -y` leaves it, using Claude Code: no lockfile, no packageManager field, so npx's npm is used.
    const project = join(scratch, "project");
    mkdirSync(join(project, ".claude"), { recursive: true });
    mustRun(["git", "init", "--quiet"], project);
    mustRun(["npm", "init", "-y"], project);

    const init = run(["npx", "--yes", "-p", tarball(first, "bounded", VERSION), "bounded", "init", "--from", first], project);
    expect(init.stderr).toBe("");
    expect(init.exitCode).toBe(0);
    expect(init.stdout).toContain("with npm");
    const manifest = json<{ devDependencies: Record<string, string>; overrides: Record<string, string> }>(join(project, "package.json"));
    expect(Object.keys(manifest.devDependencies).sort()).toEqual(["bounded", "bounded-claude-code"]);
    expect(manifest.overrides.bounded).toBe("$bounded");
    expect(existsSync(join(project, "package-lock.json"))).toBe(true);
    expect(existsSync(join(project, "node_modules", "bounded", "dist", "cli.js"))).toBe(true);
    const config = readFileSync(join(project, "bounded.config.ts"), "utf8");
    const settingsText = readFileSync(join(project, ".claude", "settings.json"), "utf8");
    expect(settingsText).toContain(JSON.stringify(HOOK).slice(1, -1));

    const update = run(["npx", "--no-install", "bounded", "update", "--from", second], project);
    expect(update.stderr).toBe("");
    expect(update.exitCode).toBe(0);
    expect(update.stdout).toContain("with npm");
    expect(update.stdout).toContain("bounded 99.0.0");
    for (const name of ["bounded", "bounded-claude-code"]) expect(versionOf(project, name)).toBe("99.0.0");
    expect(json<{ overrides: Record<string, string> }>(join(project, "package.json")).overrides.bounded).toBe("$bounded");
    expect(readFileSync(join(project, "bounded.config.ts"), "utf8")).toBe(config);
    expect(readFileSync(join(project, ".claude", "settings.json"), "utf8")).toBe(settingsText);

    const refresh = run(["npx", "--no-install", "bounded", "update", "--no-upgrade"], project);
    expect(refresh.exitCode).toBe(0);
    expect(refresh.stdout).toContain("up to date");
  }, 300_000);
});
