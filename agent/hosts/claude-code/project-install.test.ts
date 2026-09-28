import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { PIPELINE_ROLES } from "../../src/path-gate.ts";
import { boundDefinitionInForce } from "./lead-hook.ts";
import { installProjectClaude } from "./project-install.ts";
import { BOOTSTRAP_RUNTIME, markDependenciesReady } from "../../test/support/bootstrap-project.ts";

const SOURCE = fileURLToPath(new URL("../../", import.meta.url));
const HOOK = join(dirname(fileURLToPath(import.meta.url)), "path-gate-hook.ts");
const projects: string[] = [];
afterEach(() => {
  while (projects.length) rmSync(projects.pop()!, { recursive: true, force: true });
});

function project(): { target: string; harness: string } {
  const target = mkdtempSync(join(tmpdir(), "bounded-claude-project-"));
  projects.push(target);
  const harness = join(target, ".bounded", "harness");
  writeFileSync(join(target, "AGENTS.md"), "# Project instructions\n");
  for (const role of PIPELINE_ROLES) {
    const dest = join(harness, "agents", `${role}.md`);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(SOURCE, "agents", `${role}.md`), dest);
  }
  cpSync(join(SOURCE, "skills", "developer-stage"), join(harness, "skills", "developer-stage"), { recursive: true });
  cpSync(join(SOURCE, "skills", "team-lead"), join(harness, "skills", "team-lead"), { recursive: true });
  for (const rel of ["hosts/claude-code/path-gate-hook.ts", "scripts/bounded", "agents/scout.md", ...BOOTSTRAP_RUNTIME]) {
    const dest = join(harness, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(SOURCE, rel), dest);
  }
  return { target, harness };
}

test("Claude Code discovery uses only project-relative paths and copied skills", () => {
  const { target, harness } = project();
  installProjectClaude(target, harness);
  const settings = readFileSync(join(target, ".claude", "settings.json"), "utf8");
  expect(settings).toContain("${CLAUDE_PROJECT_DIR}/.bounded/harness/hosts/claude-code/bootstrap-hook.ts");
  expect(settings).not.toContain("path-gate-hook.ts");
  expect(settings).toContain("--project-local");
  expect(settings).not.toContain(target);
  expect(settings).not.toContain(SOURCE);
  for (const role of PIPELINE_ROLES) {
    const rendered = readFileSync(join(target, ".claude", "agents", `${role}.md`), "utf8");
    expect(rendered).toContain(`--project-local --role ${role}`);
    expect(rendered).not.toContain(target);
    expect(rendered).not.toContain(SOURCE);
  }
  const skill = join(target, ".claude", "skills", "developer-stage");
  expect(lstatSync(skill).isDirectory()).toBe(true);
  expect(lstatSync(skill).isSymbolicLink()).toBe(false);
  expect(readFileSync(join(skill, "SKILL.md"), "utf8")).toBe(
    readFileSync(join(harness, "skills", "developer-stage", "SKILL.md"), "utf8"),
  );
  const instructions = readFileSync(join(target, "CLAUDE.md"), "utf8");
  expect(instructions).toContain("# Bounded project entry");
  expect(instructions).toContain("`bash .bounded/harness/scripts/bounded setup`");
  expect(instructions).not.toContain("npm");
  expect(instructions.endsWith(readFileSync(join(target, "AGENTS.md"), "utf8"))).toBe(true);
  const scout = readFileSync(join(target, ".claude", "agents", "scout.md"), "utf8");
  expect(scout).toContain("name: scout\n");
  expect(scout).toContain("tools: Read, Grep, Glob");
  expect(scout).toContain('hooks:\n  PreToolUse:\n    - matcher: ""\n      hooks:\n        - type: command\n');
  expect(scout).toContain("--project-local --role scout");
  expect(scout).not.toContain(target);
  expect(boundDefinitionInForce(target, "scout")).toBe(true);
  expect(existsSync(join(target, ".claude", "skills", "team-lead", "SKILL.md"))).toBe(true);
});

test("the stored hook command works from a nested working directory", () => {
  const { target, harness } = project();
  const copiedHook = join(harness, "hosts", "claude-code", "path-gate-hook.ts");
  writeFileSync(copiedHook, "process.stdout.write(process.argv.slice(2).join('|'))\n");
  installProjectClaude(target, harness);
  markDependenciesReady(target); // the bootstrap entry then hands every call to the full hook
  const settings = JSON.parse(readFileSync(join(target, ".claude", "settings.json"), "utf8")) as {
    hooks: { PreToolUse: { hooks: { command: string }[] }[] };
  };
  const command = settings.hooks.PreToolUse[0].hooks[0].command;
  mkdirSync(join(target, "src"));
  const run = spawnSync("/bin/sh", ["-c", command], {
    cwd: join(target, "src"),
    env: { ...process.env, CLAUDE_PROJECT_DIR: target },
    input: "{}",
    encoding: "utf8",
  });
  expect(run.status).toBe(0);
  expect(run.stdout).toBe("--project-local");
});

test("an existing CLAUDE.md refuses before writing host files", () => {
  const { target, harness } = project();
  writeFileSync(join(target, "CLAUDE.md"), "my own instructions\n");
  expect(() => installProjectClaude(target, harness)).toThrow("existing CLAUDE.md");
  expect(readFileSync(join(target, "CLAUDE.md"), "utf8")).toBe("my own instructions\n");
  expect(existsSync(join(target, ".claude"))).toBe(false);
});

test("the bound hook rewrites a validated gate call to the copied CLI", () => {
  const { target, harness } = project();
  writeFileSync(join(target, ".bounded", "dev-stage-role"), "builder\n");
  const payload = JSON.stringify({
    cwd: target,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: '"bounded" gates typecheck --json' },
  });
  const run = spawnSync(process.execPath, [HOOK, "--role", "builder", "--project-local", "--harness-root", harness], {
    cwd: target,
    input: payload,
    encoding: "utf8",
  });
  expect(run.status).toBe(0);
  const output = JSON.parse(run.stdout) as {
    hookSpecificOutput: { updatedInput: { command: string } };
  };
  expect(output.hookSpecificOutput.updatedInput.command).toContain(`${harness}/scripts/bounded' 'gates' 'typecheck' '--json'`);
  expect(output.hookSpecificOutput.updatedInput.command).not.toContain(" 'bounded' ");
});
