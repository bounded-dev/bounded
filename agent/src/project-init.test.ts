import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";
import { decide } from "./path-policy.ts";
import { setupPlan } from "./setup-state.ts";
import {
  applyInit, declaresNoInitializer, defaultSelection, describeInit, exampleContracts, exampleWorkspaces, localPackPaths,
  importedPackageNames, planInit, projectNameOf, runtimeBuiltinModules, surfaceSelection, withoutTemplateText,
} from "./project-init.ts";

/** The whole stack, in the order packs/default-stack.json records it. */
const DEFAULT_STACK = ["ts", "ts-hexagonal", "ts-trpc", "ts-mcp", "ts-lambda", "ts-web", "ts-desktop", "ts-drizzle-postgres"];

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

  test("the TN README's example follows the composed layout: a concept, a feature, and the apps", () => {
    expect(exampleContracts(["ts", "ts-hexagonal"])).toEqual([
      "contracts:",
      "  - contexts/<context>/src/domain/<area>/<concept>.contract.ts",
      "  - contexts/<context>/src/application/<area>/<feature>/<feature>.contract.ts",
    ]);
    // The core invents no path: without a pack naming one, the list is empty.
    expect(exampleContracts(["ts"])).toEqual(["contracts: []"]);
    expect(exampleContracts([])).toEqual(["contracts: []"]);
    expect(exampleWorkspaces(DEFAULT_STACK)).toEqual([
      "workspaces:", "  apps/desktop: desktop", "  apps/lambdas: lambdas", "  apps/mcp: mcp", "  apps/web: web",
    ]);
    expect(exampleWorkspaces(["ts", "ts-hexagonal", "ts-trpc", "ts-web"])).toEqual(["workspaces:", "  apps/web: web"]);
    expect(exampleWorkspaces(["ts", "ts-hexagonal"])).toEqual([]);
  });

  test("the default selection is the explicit stack list, installed and closed under its dependencies", () => {
    expect(defaultSelection()).toEqual(DEFAULT_STACK);
    const installed = readdirSync(join(import.meta.dirname, "..", "packs"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(import.meta.dirname, "..", "packs", entry.name, "pack.ts")))
      .map((entry) => entry.name);
    for (const pack of DEFAULT_STACK) {
      expect(installed, pack).toContain(pack);
      const deps = (JSON.parse(readFileSync(join(import.meta.dirname, "..", "packs", pack, "contrib.json"), "utf8")) as
        { dependsOnPacks?: string[] }).dependsOnPacks ?? [];
      for (const dep of deps) expect(DEFAULT_STACK, `${pack} needs ${dep}`).toContain(dep);
    }
    expect((describeInit() as { defaultSelection: string[] }).defaultSelection).toEqual(DEFAULT_STACK);
  });

  test("a pack without an initializer counts as covered only when it says so", () => {
    expect(declaresNoInitializer("ts-drizzle-postgres")).toBe(true);
    // Omitting the field is not the declaration.
    expect(declaresNoInitializer("ts-hexagonal")).toBe(false);
    expect(declaresNoInitializer("ts-web")).toBe(false);
  });

  test("harness pack paths in instructions become the project-local ones", () => {
    expect(localPackPaths("read `packs/ts-hexagonal/reference/` and `packs/ts/x.md`"))
      .toBe("read `.bounded/harness/packs/ts-hexagonal/reference/` and `.bounded/harness/packs/ts/x.md`");
    expect(localPackPaths("the packs/ directory")).toBe("the packs/ directory");
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

  test("the import scan names packages, never relative paths or the runtimes' builtins", () => {
    const source = [
      'import { describe, test } from "bun:test";',
      'import { Database } from "bun:sqlite";',
      'import { $ } from "bun";',
      'import { readFileSync } from "node:fs";',
      'import { a } from "./a.ts";',
      'import type { Pool } from "pg";',
      'import { initTRPC } from "@trpc/server/adapters/standalone";',
      'export { b } from "picomatch";',
      "const generated = `",
      'import { z } from "zod";',
      "`;",
    ].join("\n");
    // The Bun names come from the ts pack's data, never from the core.
    const builtins = runtimeBuiltinModules(["ts"]);
    expect(builtins).toEqual(["bun", "bun:"]);
    expect(importedPackageNames(source, builtins)).toEqual(["@trpc/server", "pg", "picomatch"]);
    expect(importedPackageNames(source)).toEqual(["@trpc/server", "bun", "bun:sqlite", "bun:test", "pg", "picomatch"]);
  });

  test("the core names no Bun module: the runtime builtins it skips are the packs' data", () => {
    const core = readFileSync(join(import.meta.dirname, "project-init.ts"), "utf8");
    expect(core).not.toMatch(/["'`]bun:?["'`]|startsWith\("bun/);
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
    expect(plan.packs).toEqual(DEFAULT_STACK);
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

    // The worked example ships with its tests: the briefs tell the workers to
    // copy their shape, so they must exist where the briefs point.
    const reference = ".bounded/harness/packs/ts-hexagonal/reference/contexts/project-management/src";
    for (const file of ["domain/projects/project-name.test.ts", "application/notes/create-note/create-note.test.ts",
      "application/notes/create-note/create-note.store.test-support.ts",
      "adapters/out/in-memory/notes/create-note.store.test.ts"]) {
      expect(existsSync(join(target, reference, file)), file).toBe(true);
    }
    // They are harness reference, not project source: in no source root, so
    // not test-side for either blind role, and readable by both.
    const refTest = `${reference}/application/notes/create-note/create-note.test.ts`;
    const refImpl = `${reference}/application/notes/create-note/create-note.handler.ts`;
    const ctx = {
      cwd: target, sourceRoots: ["apps/*/src", "contexts/*/src"],
      testSuffixes: [".test.ts", ".test.tsx", ".test-support.ts"], contractGlobs: [], generatedGlobs: [],
    };
    for (const role of ["builder", "test-writer"] as const) {
      for (const path of [refTest, refImpl]) expect(decide(role, "read", { path }, ctx).allow, `${role} ${path}`).toBe(true);
    }
    // The briefs and skills name those paths as the project sees them.
    for (const brief of [".bounded/harness/agents/builder.md", ".claude/agents/test-writer.md", ".claude/agents/architect.md",
      ".claude/skills/developer-stage/SKILL.md"]) {
      const text = readFileSync(join(target, brief), "utf8");
      expect(text, brief).toContain("`.bounded/harness/packs/ts-hexagonal/");
      expect(text, brief).not.toMatch(/`packs\//);
    }
    // On Claude Code the composed packs' skills are installed as skills.
    for (const skill of ["ts-hexagonal", "ts-contract-authoring", "ts-api-service", "ts-web-app", "ts-drizzle-postgres"]) {
      expect(existsSync(join(target, ".claude/skills", skill, "SKILL.md")), skill).toBe(true);
    }
    // The TN README shows a real layout path and the apps' workspaces block.
    const tnReadme = readFileSync(join(target, "docs/tn/README.md"), "utf8");
    expect(tnReadme).toContain("  - contexts/<context>/src/application/<area>/<feature>/<feature>.contract.ts");
    expect(tnReadme).toContain("workspaces:\n  apps/desktop: desktop");
  }, 120_000);

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

  test("initializes a persistence-only project, named after its directory, not bounded-project", async () => {
    const target = join(empty(), "notes-store");
    mkdirSync(target);
    const plan = await planInit(target, "claude-code", ["ts-drizzle-postgres"]);
    expect(plan.packs).toEqual(["ts", "ts-hexagonal", "ts-drizzle-postgres"]);
    expect(plan.createdFiles["docker-compose.yml"]).toBeDefined();
    await applyInit(target, "claude-code", ["ts-drizzle-postgres"], plan.digest);
    const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8")) as { name: string; scripts: Record<string, string> };
    expect(pkg.name).toBe("notes-store");
    expect(pkg.scripts["check:db"]).toBeDefined();
    expect(readFileSync(join(target, "docker-compose.yml"), "utf8")).toContain("notes-store");
    expect(readFileSync(join(target, "docker-compose.yml"), "utf8")).not.toContain("bounded-project");

    // The project's composed setup leaves its probe behind even before the
    // design adds a workspace: with no workspace yet, Bun would pick the
    // hoisted linker and never write node_modules/.bun.
    if (spawnSync("bun", ["--version"]).status !== 0) {
      console.warn("project-init.test.ts: skipping the setup probe — `bun` is not on PATH");
      return;
    }
    const plan2 = setupPlan(target);
    for (const step of plan2.steps.filter((s) => s.label.startsWith("project"))) {
      const run = spawnSync(step.command, [...step.args], { cwd: step.cwd, encoding: "utf8" });
      expect(run.status, `${step.command} ${step.args.join(" ")}: ${run.stderr}`).toBe(0);
    }
    for (const probe of plan2.probes.filter((p) => !p.includes("/.bounded/"))) expect(existsSync(probe), probe).toBe(true);
  }, 240_000);

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

  test("before the first ticket, a wrong selection is re-planned in place from the spec's surfaces", async () => {
    // The dogfood: "web app for project management" chose web and Postgres;
    // the spec then needed the desktop, assistants and the scheduled export.
    const target = join(empty(), "pm-notes");
    mkdirSync(join(target, ".git"), { recursive: true });
    writeFileSync(join(target, ".git", "HEAD"), "ref: refs/heads/main\n");
    const first = surfaceSelection({ needed: ["browser-ui", "persistence"], declined: ["desktop", "assistant-tools", "scheduled-jobs"] });
    if (first.kind !== "selected") throw new Error(first.kind);
    const narrow = await planInit(target, "claude-code", first.packs);
    await applyInit(target, "claude-code", first.packs, narrow.digest);
    // What setup and the lead leave behind before any ticket.
    mkdirSync(join(target, "node_modules", ".bun"), { recursive: true });
    writeFileSync(join(target, "node_modules", ".bun", "x"), "");
    mkdirSync(join(target, ".bounded", "harness", "node_modules"), { recursive: true });
    writeFileSync(join(target, ".bounded", "setup-complete"), "complete\n");
    writeFileSync(join(target, ".bounded", "guard-log.jsonl"),
      JSON.stringify({ ts: "t", guard: "team-lead", verdict: "pass", summary: "setup", detail: { kind: "setup" } }) + "\n");

    const full = surfaceSelection({ needed: ["browser-ui", "desktop", "assistant-tools", "scheduled-jobs", "persistence"], declined: [] });
    if (full.kind !== "selected") throw new Error(full.kind);
    const replan = await planInit(target, "claude-code", full.packs);
    expect(replan.packs).toEqual(DEFAULT_STACK);
    expect(replan.replaces).toBe(narrow.digest);
    // Planning writes nothing.
    expect(readFileSync(join(target, ".bounded/composed-packs.json"), "utf8")).not.toContain("ts-desktop");
    await expect(applyInit(target, "claude-code", full.packs, narrow.digest)).rejects.toThrow(/Plan changed/);
    expect(existsSync(join(target, ".bounded/setup-complete"))).toBe(true);

    const applied = await applyInit(target, "claude-code", full.packs, replan.digest);
    expect(applied.digest).toBe(replan.digest);
    expect(JSON.parse(readFileSync(join(target, ".bounded/composed-packs.json"), "utf8"))).toEqual([...DEFAULT_STACK].sort());
    expect(existsSync(join(target, ".bounded/harness/packs/ts-desktop"))).toBe(true);
    // Setup output and state went with the old installation: setup runs again.
    for (const gone of ["node_modules", ".bounded/setup-complete", ".bounded/guard-log.jsonl", ".bounded/harness/node_modules"]) {
      expect(existsSync(join(target, gone)), gone).toBe(false);
    }
    expect(readFileSync(join(target, ".git", "HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
    // The result is what a fresh init of the full stack would have written.
    const fresh = join(empty(), "pm-notes");
    mkdirSync(fresh);
    expect(Object.keys((await planInit(fresh, "claude-code", full.packs)).createdFiles)).toEqual(Object.keys(applied.createdFiles));
    // Re-running the applied plan is a no-op.
    expect((await planInit(target, "claude-code", full.packs)).digest).toBe(replan.digest);
  }, 300_000);

  test("re-planning refuses once work has started or the project has changed", async () => {
    const target = empty();
    const plan = await planInit(target, "claude-code", ["ts-trpc"]);
    await applyInit(target, "claude-code", ["ts-trpc"], plan.digest);
    const wider = ["ts-web", "ts-trpc"];

    writeFileSync(join(target, "notes.md"), "my notes\n");
    await expect(planInit(target, "claude-code", wider)).rejects.toThrow(/cannot be re-planned: files were added since initialization \(notes\.md\)/);
    rmSync(join(target, "notes.md"));

    const readme = readFileSync(join(target, "README.md"), "utf8");
    writeFileSync(join(target, "README.md"), "my product\n");
    await expect(planInit(target, "claude-code", wider)).rejects.toThrow(/README\.md changed since initialization/);
    writeFileSync(join(target, "README.md"), readme);

    writeFileSync(join(target, ".bounded", "active-ticket"), "1\n");
    await expect(planInit(target, "claude-code", wider)).rejects.toThrow(/a ticket has already been prepared or run/);
    rmSync(join(target, ".bounded", "active-ticket"));

    // Otherwise the project can be re-planned.
    expect((await planInit(target, "claude-code", wider)).replaces).toBe(plan.digest);
  }, 120_000);

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
