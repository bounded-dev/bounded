// End to end: `npx bounded init` and `npx bounded update` in a fresh git
// repository that installed the workspace's packages from packed tarballs
// (nothing is published to npm). The update hands over to the newer CLI it
// installs, so every later version brings its own update logic.
//
// The npm package `bounded` is still the legacy harness (2.x, ADR 2026-014),
// so its dependants would resolve `bounded@<version>` there: the project
// overrides it with the local tarball. Once published, the registry serves it.
import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../../..");
const PACKAGES = [
  { name: "bounded", dir: "contexts/core" },
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

/** Points the project's override of `bounded` at the tarball of `version` in `dir`. */
function overrideBounded(project: string, dir: string, version: string): void {
  const manifest = JSON.parse(readFileSync(join(project, "package.json"), "utf8")) as Record<string, unknown>;
  manifest.overrides = { bounded: `file:${tarball(dir, "bounded", version)}` };
  writeFileSync(join(project, "package.json"), JSON.stringify(manifest, null, 2));
}

const npx = (): string[] => (run(["npx", "--version"], tmpdir()).exitCode === 0 ? ["npx", "--no-install"] : ["bunx"]);

describe("npx bounded, installed from packed tarballs", () => {
  test("init sets a fresh repository up; update upgrades the packages, hands over to the new CLI and is idempotent", () => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "bounded-cli-e2e-")));
    const first = join(scratch, "release-1");
    const second = join(scratch, "release-2");
    const version = (JSON.parse(readFileSync(join(REPO, "contexts/core/package.json"), "utf8")) as { version: string }).version;
    packWorkspace(first);
    packRelease("99.0.0", join(scratch, "copies"), second);

    const project = join(scratch, "project");
    mkdirSync(join(project, ".pi"), { recursive: true });
    mustRun(["git", "init", "--quiet"], project);
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "demo", private: true }));
    overrideBounded(project, first, version);
    mustRun(["bun", "add", ...PACKAGES.map(({ name }) => tarball(first, name, version))], project);
    // The project's own bin, which npx runs before any `bounded` elsewhere on PATH.
    expect(existsSync(join(project, "node_modules", ".bin", "bounded"))).toBe(true);

    // init
    const init = run([...npx(), "bounded", "init"], project);
    expect(init.stderr).toBe("");
    expect(init.exitCode).toBe(0);
    expect(init.stdout).toMatch(/restart/i);
    const config = readFileSync(join(project, "bounded.config.ts"), "utf8");
    expect(config).toContain("export default defineConfig({ packs: [corePack] });");
    const settingsText = readFileSync(join(project, ".claude", "settings.json"), "utf8");
    const main = join(project, "node_modules", "bounded-claude-code", "src", "main.ts");
    expect(settingsText).toContain(main);
    expect(settingsText).not.toContain(REPO);
    const settings = JSON.parse(settingsText) as { hooks: Record<string, unknown[]> };
    for (const event of ["PreToolUse", "PostToolUse", "PostToolUseFailure"]) expect(settings.hooks[event]).toHaveLength(1);
    const loader = readFileSync(join(project, ".pi", "extensions", "bounded", "index.ts"), "utf8");
    expect(loader).toContain('"bounded-pi"');

    // init again is refused, changing nothing
    const again = run([...npx(), "bounded", "init"], project);
    expect(again.exitCode).toBe(1);
    expect(readFileSync(join(project, "bounded.config.ts"), "utf8")).toBe(config);

    // update: upgrade to the later release, then the newly installed CLI refreshes the hooks
    overrideBounded(project, second, "99.0.0");
    const update = run([...npx(), "bounded", "update", "--from", second], project);
    expect(update.exitCode).toBe(0);
    expect(update.stdout).toContain("bounded 99.0.0");
    expect((JSON.parse(readFileSync(join(project, "node_modules", "bounded", "package.json"), "utf8")) as { version: string }).version).toBe("99.0.0");
    expect((JSON.parse(readFileSync(join(project, "node_modules", "bounded-claude-code", "package.json"), "utf8")) as { version: string }).version).toBe("99.0.0");
    expect(readFileSync(join(project, "bounded.config.ts"), "utf8")).toBe(config);
    expect(readFileSync(join(project, ".claude", "settings.json"), "utf8")).toBe(settingsText);
    expect(readFileSync(join(project, ".pi", "extensions", "bounded", "index.ts"), "utf8")).toBe(loader);

    // update again: idempotent
    const refresh = run([...npx(), "bounded", "update", "--no-upgrade"], project);
    expect(refresh.exitCode).toBe(0);
    expect(refresh.stdout).toContain("up to date");
    expect(readFileSync(join(project, "bounded.config.ts"), "utf8")).toBe(config);
    expect(readFileSync(join(project, ".claude", "settings.json"), "utf8")).toBe(settingsText);
  }, 180_000);
});
