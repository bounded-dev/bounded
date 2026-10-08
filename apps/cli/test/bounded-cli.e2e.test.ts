// End to end, from packed tarballs (nothing is published to npm): the first
// install runs bounded-cli through npx, before the project has any bounded
// package; `bounded init --from` adds the packages and hands over to the
// installed CLI. After that, `npx bounded update --from` runs the project's
// own bin, upgrades, and hands over to the newer CLI it installs, so every
// later version brings its own update logic.
//
// The npm package `bounded` is still the legacy harness (2.x, ADR 2026-014),
// so npx is given the bounded tarball beside bounded-cli's, and init points
// the project's override of `bounded` at the local tarball.
import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../../..");
const PACKAGES = [
  { name: "bounded", dir: "contexts/core" },
  { name: "bounded-cli", dir: "apps/cli" },
  { name: "bounded-claude-code", dir: "apps/claude-code" },
  { name: "bounded-pi", dir: "apps/pi" },
] as const;

function run(command: readonly string[], cwd: string): { exitCode: number; stdout: string; stderr: string } {
  const ran = Bun.spawnSync([...command], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, npm_config_yes: "true" } });
  return { exitCode: ran.exitCode, stdout: ran.stdout.toString(), stderr: ran.stderr.toString() };
}

function mustRun(command: readonly string[], cwd: string): string {
  const ran = run(command, cwd);
  if (ran.exitCode !== 0) throw new Error(`${command.join(" ")} failed (${ran.exitCode}):\n${ran.stdout}\n${ran.stderr}`);
  return ran.stdout;
}

/** Packs the workspace's packages as they are into `into`, the tarballs a release would publish. */
function packWorkspace(into: string): void {
  for (const { dir } of PACKAGES) mustRun(["bun", "pm", "pack", "--destination", into, "--quiet"], join(REPO, dir));
}

/** Packs a copy of the workspace's packages as version `version`: a later release, for the update to install. */
function packRelease(version: string, scratch: string, into: string): void {
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

describe("bounded-cli end to end, from packed tarballs", () => {
  test("npx bounded-cli init --from adds the packages and sets the repository up; npx bounded update --from upgrades and hands over to the new CLI; both are idempotent", () => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "bounded-cli-e2e-")));
    const first = join(scratch, "release-1");
    const second = join(scratch, "release-2");
    const version = json<{ version: string }>(join(REPO, "apps/cli/package.json")).version;
    packWorkspace(first);
    packRelease("99.0.0", join(scratch, "copies"), second);

    // A fresh repository using bun, Claude Code (.claude/) and pi (.pi/), with no bounded package yet.
    const project = join(scratch, "project");
    mkdirSync(join(project, ".claude"), { recursive: true });
    mkdirSync(join(project, ".pi"));
    mustRun(["git", "init", "--quiet"], project);
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "demo", private: true, packageManager: `bun@${Bun.version}` }));

    // The first install: bounded-cli through npx (bunx cannot be given a tarball beside another).
    const init = run(["npx", "--yes", "-p", tarball(first, "bounded", version), "-p", tarball(first, "bounded-cli", version), "bounded", "init", "--from", first], project);
    expect(init.stderr).toBe("");
    expect(init.exitCode).toBe(0);
    expect(init.stdout).toContain(`bounded ${version}`);
    expect(init.stdout).toMatch(/restart/i);
    const manifest = json<{ devDependencies: Record<string, string>; overrides: Record<string, string> }>(join(project, "package.json"));
    expect(Object.keys(manifest.devDependencies).sort()).toEqual(["bounded", "bounded-claude-code", "bounded-cli", "bounded-pi"]);
    expect(manifest.overrides.bounded).toBe(`file:${tarball(first, "bounded", version)}`);
    expect(existsSync(join(project, "node_modules", ".bin", "bounded"))).toBe(true);
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

    // update: the project's own bin upgrades to the later release, then the newly installed CLI refreshes the hooks
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

  test.skipIf(Bun.which("npm") === null)("under npm (skipped when npm is not installed): npx bounded-cli init --from, then npx bounded update --from to a later release", () => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "bounded-cli-e2e-npm-")));
    const first = join(scratch, "release-1");
    const second = join(scratch, "release-2");
    const version = json<{ version: string }>(join(REPO, "apps/cli/package.json")).version;
    packWorkspace(first);
    packRelease("99.0.0", join(scratch, "copies"), second);

    // A fresh repository as `npm init -y` leaves it, using Claude Code: no lockfile, no packageManager field, so npx's npm is used.
    const project = join(scratch, "project");
    mkdirSync(join(project, ".claude"), { recursive: true });
    mustRun(["git", "init", "--quiet"], project);
    mustRun(["npm", "init", "-y"], project);

    const init = run(["npx", "--yes", "-p", tarball(first, "bounded", version), "-p", tarball(first, "bounded-cli", version), "bounded", "init", "--from", first], project);
    expect(init.stderr).toBe("");
    expect(init.exitCode).toBe(0);
    expect(init.stdout).toContain("with npm");
    const manifest = json<{ devDependencies: Record<string, string>; overrides: Record<string, string> }>(join(project, "package.json"));
    expect(Object.keys(manifest.devDependencies).sort()).toEqual(["bounded", "bounded-claude-code", "bounded-cli"]);
    expect(manifest.overrides.bounded).toBe("$bounded");
    expect(existsSync(join(project, "package-lock.json"))).toBe(true);
    const config = readFileSync(join(project, "bounded.config.ts"), "utf8");
    const settingsText = readFileSync(join(project, ".claude", "settings.json"), "utf8");
    expect(settingsText).toContain(JSON.stringify(HOOK).slice(1, -1));

    const update = run(["npx", "--no-install", "bounded", "update", "--from", second], project);
    expect(update.stderr).toBe("");
    expect(update.exitCode).toBe(0);
    expect(update.stdout).toContain("with npm");
    expect(update.stdout).toContain("bounded 99.0.0");
    for (const name of ["bounded", "bounded-cli", "bounded-claude-code"]) expect(versionOf(project, name)).toBe("99.0.0");
    expect(json<{ overrides: Record<string, string> }>(join(project, "package.json")).overrides.bounded).toBe("$bounded");
    expect(readFileSync(join(project, "bounded.config.ts"), "utf8")).toBe(config);
    expect(readFileSync(join(project, ".claude", "settings.json"), "utf8")).toBe(settingsText);

    const refresh = run(["npx", "--no-install", "bounded", "update", "--no-upgrade"], project);
    expect(refresh.exitCode).toBe(0);
    expect(refresh.stdout).toContain("up to date");
  }, 300_000);
});
