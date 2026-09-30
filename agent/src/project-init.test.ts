import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { applyInit, describeInit, exampleContracts, planInit } from "./project-init.ts";

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

  test("the TN README's example contract comes from the composed packs", () => {
    expect(exampleContracts(["ts"])).toEqual(["contracts:", "  - src/example/example.contract.ts"]);
    expect(exampleContracts([])).toEqual(["contracts: []"]);
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
    expect(pkg.scripts["check"]).toContain('--exclude="**/.bounded/**"');
    expect(pkg.scripts["test"]).toContain('--exclude="**/.bounded/**"');
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
