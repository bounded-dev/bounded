import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";
import {
  applyInit, defaultSelection, describeInit, exampleContracts, planInit, projectNameOf, withoutTemplateText,
} from "./project-init.ts";

const temporary: string[] = [];
function empty(): string {
  const path = mkdtempSync(join(tmpdir(), "bounded-init-test-"));
  temporary.push(path);
  return path;
}
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("project-local initialization", () => {
  test("bare discovery is explicit and does not mutate", () => {
    const choice = describeInit() as { writes: boolean; hosts: string[] };
    expect(choice.writes).toBe(false);
    expect(choice.hosts).toEqual(["pi", "claude-code"]);
  });

  test("the TN README's example contract sits under the source root the design drives", () => {
    // ts-hexagonal's roots are apps/*/src and contexts/*/src; only the second
    // has generated files in it, so that is where contracts live.
    expect(exampleContracts(["ts", "ts-hexagonal"])).toEqual(["contracts:", "  - contexts/example/src/example/example.contract.ts"]);
    // A suffix with no source root, or nothing at all, names no file.
    expect(exampleContracts(["ts"])).toEqual(["contracts: []"]);
    expect(exampleContracts([])).toEqual(["contracts: []"]);
  });

  test("the default selection is every installed capability: the whole stack", () => {
    expect(defaultSelection()).toEqual([
      "ts", "ts-desktop", "ts-drizzle-postgres", "ts-hexagonal", "ts-lambda", "ts-mcp", "ts-trpc", "ts-web",
    ]);
    expect((describeInit() as { defaultSelection: string[] }).defaultSelection).toEqual(defaultSelection());
  });

  test("imports inside template literals are generated text, not harness dependencies", () => {
    const source = [
      'import { a } from "./a.ts";',
      "const file = `",
      'import { test } from "bun:test";',
      'import type { Pool } from "pg";',
      "const x = ${`nested ${1}`};",
      "`;",
      'const s = "a ` in a string";',
      "// a ` in a comment",
      'import { b } from "picomatch";',
    ].join("\n");
    const kept = withoutTemplateText(source);
    expect(kept).toContain('import { a } from "./a.ts";');
    expect(kept).toContain('import { b } from "picomatch";');
    expect(kept).not.toContain("bun:test");
    expect(kept).not.toContain('"pg"');
    expect(kept.split("\n")).toHaveLength(source.split("\n").length);
  });

  test("the project name comes from the directory name", () => {
    expect(projectNameOf("/work/Example Project")).toBe("example-project");
    expect(projectNameOf("/work/notes_app")).toBe("notes-app");
    expect(projectNameOf("/work/---")).toBeUndefined();
  });

  test("the default stack yields the worked example's root files, apart from the harness's own", async () => {
    const parent = empty();
    const target = join(parent, "example-project");
    mkdirSync(target);
    const packs = defaultSelection();
    const plan = await planInit(target, "claude-code", packs);
    expect(plan.packs).toEqual([
      "ts", "ts-hexagonal", "ts-trpc", "ts-desktop", "ts-drizzle-postgres", "ts-lambda", "ts-mcp", "ts-web",
    ]);
    // The harness's own files: its install, its host config, the root
    // instructions, the ticket notes, the shipped checks, and the apps note.
    const harness = (path: string): boolean =>
      /^(?:\.bounded|\.claude|docs\/tn|scripts)\//.test(path) || path === "AGENTS.md" || path === "apps/README.md";
    const product = Object.keys(plan.createdFiles).filter((path) => !harness(path)).sort();
    // The worked example's committed root files (its `.env` is ignored).
    expect(product).toEqual([
      ".env.example", ".gitignore", "CLAUDE.md", "README.md", "architecture.test.ts", "bun.lock",
      "docker-compose.yml",
      ...["README.md", "adapters.md", "agent-workflow.md", "application.md", "apps-and-composition.md",
        "bounded-contexts.md", "directory-structure.md", "domain.md", "error-handling.md",
        "layers-and-dependencies.md", "persistence.md", "testing.md"].map((doc) => `docs/architecture/${doc}`),
      "package.json", "tsconfig.base.json", "tsconfig.json",
    ].sort());
    await applyInit(target, "claude-code", packs, plan.digest);
    const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8")) as { name: string; workspaces: string[] };
    // The directory's name is the project's name, so the scope is @example-project.
    expect(pkg.name).toBe("example-project");
    expect(pkg.workspaces).toEqual(["contexts/*", "apps/*"]);
  });

  test("refuses a nonempty project before any write", async () => {
    const target = empty();
    writeFileSync(join(target, "README.md"), "existing work\n");
    await expect(planInit(target, "pi", ["ts-web"])).rejects.toThrow(/requires an empty directory/);
    expect(existsSync(join(target, ".bounded"))).toBe(false);
    expect(readFileSync(join(target, "README.md"), "utf8")).toBe("existing work\n");
  });

  test("accepts a .git-only directory and refuses a partial prior installation", async () => {
    const target = empty();
    mkdirSync(join(target, ".git"));
    const plan = await planInit(target, "pi", ["ts-web"]);
    expect(existsSync(join(target, ".bounded"))).toBe(false);
    await applyInit(target, "pi", ["ts-web"], plan.digest);
    expect(existsSync(join(target, ".git"))).toBe(true);
    rmSync(join(target, ".bounded/installation.json"));
    await expect(planInit(target, "pi", ["ts-web"])).rejects.toThrow(/requires an empty directory/);
  });

  test.each(["pi", "claude-code"])("combines web and service initializers for %s", async (host) => {
    const target = empty();
    await expect(planInit(target, "pi", ["ts"])).rejects.toThrow(/cannot yet scaffold/);
    expect(existsSync(join(target, ".bounded"))).toBe(false);
    const plan = await planInit(target, host, ["ts-web", "ts-trpc"]);
    expect(plan.packs).toEqual(["ts", "ts-hexagonal", "ts-trpc", "ts-web"]);
    // Apps come from the design (ADR 2026-061); init seeds only the note saying so.
    expect(plan.createdFiles["apps/README.md"]).toBeDefined();
    await applyInit(target, host, ["ts-web", "ts-trpc"], plan.digest);
    const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8")) as { scripts: Record<string, string>; dependencies: Record<string, string> };
    expect(pkg.scripts["check"]).toContain("bun test");
    expect(pkg.scripts["test"]).toBe("bun test");
    expect(existsSync(join(target, "bun.lock"))).toBe(true);
    expect(existsSync(join(target, ".bounded/harness/packs/ts-trpc"))).toBe(true);
  });

  test("plans a service-only project", async () => {
    const plan = await planInit(empty(), "claude-code", ["ts-trpc"]);
    expect(plan.packs).toEqual(["ts", "ts-hexagonal", "ts-trpc"]);
    expect(plan.createdFiles["apps/README.md"]).toBeDefined();
  });

  test.each(["pi", "claude-code"])("plans and installs only the %s host and selected packs", async (host) => {
    const target = empty();
    const plan = await planInit(target, host, ["ts-web"]);
    expect(plan.packs).toEqual(["ts", "ts-hexagonal", "ts-trpc", "ts-web"]);
    expect(plan.createdFiles["docs/tn/README.md"]).toBeDefined();
    expect(existsSync(join(target, ".bounded"))).toBe(false);
    await expect(applyInit(target, host, ["ts-web"], "0".repeat(64))).rejects.toThrow(/Plan changed/);
    expect(existsSync(join(target, ".bounded"))).toBe(false);
    const applied = await applyInit(target, host, ["ts-web"], plan.digest);
    expect(applied.digest).toBe(plan.digest);
    expect(statSync(join(target, ".bounded/harness/scripts/bounded")).mode & 0o111).not.toBe(0);
    expect(existsSync(join(target, ".bounded/harness/packs/ts-mcp"))).toBe(false);
    expect(existsSync(join(target, ".bounded/harness/hosts", host))).toBe(true);
    expect(existsSync(join(target, ".bounded/harness/hosts", host === "pi" ? "claude-code" : "pi"))).toBe(false);
    expect(readFileSync(join(target, ".bounded/composed-packs.json"), "utf8")).toContain("ts-web");
    expect(readFileSync(join(target, ".gitignore"), "utf8")).toContain("!.bounded/harness/");
    expect(existsSync(join(target, ".bounded/guard-log.jsonl"))).toBe(false);
    expect(readFileSync(join(target, "AGENTS.md"), "utf8")).toContain(".bounded/harness/");
    expect(readFileSync(join(target, "docs/tn/README.md"), "utf8")).toContain("TN-<ticket-number>.md");
    const agents = readFileSync(join(target, "AGENTS.md"), "utf8");
    expect(agents).toContain("TN-<ticket-number>.md");
    expect(agents).not.toContain("issue-number");
    // Project dependency setup comes from the composed packs, not from the core.
    const ignore = readFileSync(join(target, ".gitignore"), "utf8").split("\n");
    expect(ignore).toEqual(expect.arrayContaining(["/node_modules/", "/dist/", ".bounded/harness/node_modules/"]));
    expect(ignore.indexOf(".bounded/harness/node_modules/")).toBeGreaterThan(ignore.indexOf("!.bounded/harness/"));
    // The lockfile fingerprint is committed (the config check verifies the
    // lockfile against it on a fresh clone); the rest of .bounded/ is not.
    execFileSync("git", ["init", "-q"], { cwd: target });
    const ignored = (path: string) =>
      spawnSync("git", ["check-ignore", "-q", "--no-index", path], { cwd: target }).status === 0;
    expect(ignored(".bounded/lockfile-fingerprint.json")).toBe(false);
    expect(ignored(".bounded/composed-packs.json")).toBe(false);
    expect(ignored(".bounded/guard-log.jsonl")).toBe(true);
    const scripts = (JSON.parse(readFileSync(join(target, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
    expect(scripts["bounded:setup"]).toBeUndefined();
    expect(readFileSync(join(target, ".bounded/harness/scripts/bounded"), "utf8")).toContain('setup) shift; exec node "$DIR/../src/setup-state.ts"');
    // Pack commands come from the composed packs' projectCommands, not a core list.
    expect(readFileSync(join(target, ".bounded/harness/scripts/bounded"), "utf8"))
      .toContain('adopt|capture-baseline|change-diff|sync-config) shift; exec node "$DIR/../packs/command.ts" "$SUB" "$@" ;;');
    expect(existsSync(join(target, ".bounded/harness/src/setup-state.ts"))).toBe(true);
    const stageSkill = readFileSync(join(target, ".bounded/harness/skills/developer-stage/SKILL.md"), "utf8");
    expect(stageSkill).not.toContain("bounded compose");
    expect(existsSync(join(target, ".bounded/harness/scripts/bounded-handoff"))).toBe(true);
    expect(existsSync(join(target, ".bounded/harness/scripts/bounded-ticket"))).toBe(true);
    expect(stageSkill).toContain("bash .bounded/harness/scripts/bounded ticket --ticket");
    const leadSkill = readFileSync(join(target, ".bounded/harness/skills/team-lead/SKILL.md"), "utf8");
    expect(leadSkill).toContain("bash .bounded/harness/scripts/bounded handoff check");
    expect(leadSkill).toContain("bash .bounded/harness/scripts/bounded gates handoff-publish");
    const architectSource = readFileSync(join(target, ".bounded/harness/agents/architect.md"), "utf8");
    expect(architectSource).not.toContain("~/.pi/agent");
    expect(architectSource).toContain("bash .bounded/harness/scripts/bounded change-run");
    if (host === "claude-code") {
      const architect = readFileSync(join(target, ".claude/agents/architect.md"), "utf8");
      const claude = readFileSync(join(target, "CLAUDE.md"), "utf8");
      expect(claude.endsWith(readFileSync(join(target, "AGENTS.md"), "utf8"))).toBe(true);
      expect(claude).toContain("`bash .bounded/harness/scripts/bounded setup`");
      expect(plan.files["CLAUDE.md"]).toBeDefined();
      expect(stageSkill).toContain("`bounded gates"); // Claude hook recognizes this literal command.
      expect(architect).toContain("`bounded gates");
    } else {
      expect(stageSkill).toContain("bash .bounded/harness/scripts/bounded gates");
      expect(readFileSync(join(target, ".gitignore"), "utf8")).toContain(".pi/npm/");
    }
    const rerun = await planInit(target, host, ["ts-web"]);
    expect(rerun.digest).toBe(plan.digest);
  });

  test("normal product edits survive rerun; installer-owned edits block", async () => {
    const target = empty();
    const plan = await planInit(target, "claude-code", ["ts-web"]);
    await applyInit(target, "claude-code", ["ts-web"], plan.digest);
    writeFileSync(join(target, "apps/notes.md"), "my notes\n");
    writeFileSync(join(target, "README.md"), "my product\n");
    expect((await applyInit(target, "claude-code", ["ts-web"], plan.digest)).digest).toBe(plan.digest);
    writeFileSync(join(target, ".bounded/composed-packs.json"), "[]\n");
    await expect(applyInit(target, "claude-code", ["ts-web"], plan.digest)).rejects.toThrow(/Installed file changed/);
  });
});
