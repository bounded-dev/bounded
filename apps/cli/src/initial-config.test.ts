// The configuration `bounded init` writes: live, selecting the protected-paths pack
// (which brings in the core) with the default rules that keep agents off the project's
// guardrails (the protected-paths pack ships no rules of its own, ADR 2026-009).
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openProject } from "bounded/open-project";
import { protectedPathsPortProvisions } from "bounded/protected-paths/adapters";
import { prereqsPortProvisions } from "bounded/prereqs/adapters";
import { TreeSitterShellCommandReader } from "bounded-shell-command-reader/adapters";
import { INITIAL_CONFIG } from "./initial-config.ts";

const CORE = resolve(import.meta.dir, "../../../contexts/core");
/** The shell command reader the hosts open projects with. */
const shellCommandReader = new TreeSitterShellCommandReader();

/** A project holding the configuration init writes, where `bounded` resolves to this workspace's package. */
function project(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bounded-initial-config-")));
  mkdirSync(join(root, "node_modules"));
  symlinkSync(CORE, join(root, "node_modules", "bounded"), "dir");
  writeFileSync(join(root, "bounded.config.ts"), INITIAL_CONFIG);
  return root;
}

const edit = (path: string) => ({ kind: "tool-use", role: null, tool: "edit", effects: [{ kind: "write", path, change: "modify" }] });

describe("bounded init's configuration", () => {
  test("selects the protected-paths pack, which brings in the core, contributing its default rules with their reasons, under a comment saying they may be changed", () => {
    expect(INITIAL_CONFIG).toContain('import { contribution, defineConfig } from "bounded/domain";');
    expect(INITIAL_CONFIG).toContain('import { protectedPathsPack } from "bounded/protected-paths";');
    expect(INITIAL_CONFIG).toContain("packs: [protectedPathsPack],");
    expect(INITIAL_CONFIG).not.toContain("corePack");
    expect(INITIAL_CONFIG).toContain('match: "**/bounded.config.*"');
    expect(INITIAL_CONFIG).toContain('match: ".bounded/**"');
    expect(INITIAL_CONFIG).toContain("Ask a person to change the project's Bounded configuration; describe the change you need");
    expect(INITIAL_CONFIG).toContain("the project's guardrails are changed by people, not by agents");
    expect(INITIAL_CONFIG).toContain("Leave .bounded/ to Bounded; ask a person if its state looks wrong");
    expect(INITIAL_CONFIG).toContain("Bounded's own state and guard log");
    expect(INITIAL_CONFIG).toMatch(/defaults/i);
    expect(INITIAL_CONFIG).toContain("README");
  });

  test("names the protected-paths pack only by its current name (ADR 2026-021)", () => {
    // The former name, built from its parts so this file does not spell it.
    const formerName = new RegExp(["path", "gate"].join("[-\\s_./]?"), "i");
    expect(INITIAL_CONFIG).toContain("the protected-paths pack");
    expect(INITIAL_CONFIG).not.toMatch(formerName);
  });

  test("is a working configuration: an agent's edit of it, or of .bounded/, is refused; other edits are allowed", async () => {
    const root = project();
    const { judge, problem } = await openProject(root, { ports: [...protectedPathsPortProvisions(), ...prereqsPortProvisions()], shellCommandReader });
    expect(problem).toBeNull();
    const refused = await judge(edit("bounded.config.ts"));
    expect(refused.kind).toBe("refuse");
    expect(refused.kind === "refuse" && refused.reason).toContain("the rule '**/bounded.config.*' from bounded/project");
    expect((await judge(edit(".bounded/guard-log.jsonl"))).kind).toBe("refuse");
    expect((await judge(edit("src/index.ts"))).kind).toBe("allow");
  });

  test("also keeps agents off every Claude Code settings file (settings.local.json can disable all hooks), pi's loader and bounded's installed code, saying why", async () => {
    expect(INITIAL_CONFIG).toContain('match: ".claude/settings*.json"');
    expect(INITIAL_CONFIG).toContain("Claude Code's settings hold Bounded's hook");
    expect(INITIAL_CONFIG).toContain("Ask a person to change Claude Code's settings");
    expect(INITIAL_CONFIG).toContain('match: ".pi/extensions/bounded/**"');
    expect(INITIAL_CONFIG).toContain('match: "node_modules/bounded/**"');
    const { judge } = await openProject(project(), { ports: [...protectedPathsPortProvisions(), ...prereqsPortProvisions()], shellCommandReader });
    for (const path of [".claude/settings.json", ".claude/settings.local.json", ".pi/extensions/bounded/index.ts", "node_modules/bounded/dist/hosts/claude-code/hook.js"]) {
      for (const change of ["create", "modify", "delete"] as const) {
        expect((await judge({ kind: "tool-use", role: null, tool: "edit", effects: [{ kind: "write", path, change }] })).kind).toBe("refuse");
      }
    }
    expect((await judge(edit(".claude/commands/review.md"))).kind).toBe("allow");
    // Agents may write the rest of .claude/: their agents and skills.
    expect((await judge(edit(".claude/agents/reviewer.md"))).kind).toBe("allow");
    expect((await judge(edit(".claude/skills/release/SKILL.md"))).kind).toBe("allow");
    expect((await judge({ kind: "tool-use", role: null, tool: "read", effects: [{ kind: "read", path: ".claude/settings.json" }] })).kind).toBe("allow");
  });

  test("also keeps agents off git's hooks (git runs them later, outside Bounded's view) and git's config (it can point core.hooksPath elsewhere), by edit and by shell, saying why", async () => {
    expect(INITIAL_CONFIG).toContain('match: ".git/hooks/**"');
    expect(INITIAL_CONFIG).toContain('match: ".git/config"');
    expect(INITIAL_CONFIG).toContain("git runs these hooks later, outside Bounded's view");
    expect(INITIAL_CONFIG).toContain("core.hooksPath");
    const { judge, problem } = await openProject(project(), { ports: [...protectedPathsPortProvisions(), ...prereqsPortProvisions()], shellCommandReader });
    expect(problem).toBeNull();
    const byRule = (verdict: { kind: string; reason?: string }, rule: string) => [verdict.kind, verdict.kind === "refuse" && verdict.reason?.includes(`the rule '${rule}' from bounded/project`)];
    for (const [path, rule] of [[".git/hooks/pre-commit", ".git/hooks/**"], [".git/config", ".git/config"]] as const) {
      for (const change of ["create", "modify", "delete"] as const) {
        const edited = await judge({ kind: "tool-use", role: null, tool: "edit", effects: [{ kind: "write", path, change }] });
        expect([path, change, edited.kind]).toEqual([path, change, "refuse"]);
        expect([path, change, ...byRule(edited, rule)]).toEqual([path, change, "refuse", true]);
      }
      const command = `echo x > ${path}`;
      const shell = await judge({ kind: "tool-use", role: null, tool: "shell", effects: [{ kind: "execute", command, cwd: null }], callId: "call-1" });
      expect([command, shell.kind]).toEqual([command, "refuse"]);
      expect([command, ...byRule(shell, rule)]).toEqual([command, "refuse", true]);
    }
    const appended = await judge({ kind: "tool-use", role: null, tool: "shell", effects: [{ kind: "execute", command: "echo x >> .git/hooks/post-commit", cwd: null }], callId: "call-2" });
    expect(appended.kind).toBe("refuse");
    expect(byRule(appended, ".git/hooks/**")).toEqual(["refuse", true]);
    // Reading them, and git's other files, is left alone.
    expect((await judge({ kind: "tool-use", role: null, tool: "read", effects: [{ kind: "read", path: ".git/config" }] })).kind).toBe("allow");
    expect((await judge(edit(".git/info/exclude"))).kind).toBe("allow");
  });

  test("a shell write to git's hooks or config is refused by the git rules themselves, naming them", async () => {
    const { judge } = await openProject(project(), { ports: [...protectedPathsPortProvisions(), ...prereqsPortProvisions()], shellCommandReader });
    const shell = (command: string) => judge({ kind: "tool-use", role: null, tool: "shell", effects: [{ kind: "execute", command, cwd: null }], callId: "call-1" });
    for (const [command, rule] of [
      ["echo x > .git/hooks/pre-commit", ".git/hooks/**"],
      ["echo x >> .git/hooks/post-commit", ".git/hooks/**"],
      ["echo x > .git/config", ".git/config"],
    ] as const) {
      const verdict = await shell(command);
      expect([command, verdict.kind === "refuse" ? verdict.reason : "allowed"]).toEqual([command, expect.stringContaining(`the rule '${rule}' from bounded/project`)]);
    }
    expect((await shell("echo x > notes.txt")).kind).toBe("allow");
  });

  test("a copy through xargs into git's hooks is refused by the git rule: its input never takes the literal destination out of judgement", async () => {
    const { judge } = await openProject(project(), { ports: [...protectedPathsPortProvisions(), ...prereqsPortProvisions()], shellCommandReader });
    let calls = 0;
    const shell = (command: string) => judge({ kind: "tool-use", role: null, tool: "shell", effects: [{ kind: "execute", command, cwd: null }], callId: `call-${++calls}` });
    for (const command of ["ls | xargs -I % cp % .git/hooks/pre-commit", "ls | xargs -I{} cp {} .git/hooks/pre-commit", "echo x | xargs cp notes.txt .git/hooks/pre-commit"]) {
      const verdict = await shell(command);
      expect([command, verdict.kind === "refuse" ? verdict.reason : "allowed"]).toEqual([command, expect.stringContaining("the rule '.git/hooks/**' from bounded/project")]);
    }
  });

  test("a known way round the git rules, pinned so it stays documented: the protected-paths pack sees `git config core.hooksPath …` as reads, and allows it", async () => {
    expect(INITIAL_CONFIG).not.toContain("git -c");
    const { judge } = await openProject(project(), { ports: [...protectedPathsPortProvisions(), ...prereqsPortProvisions()], shellCommandReader });
    const command = "git config core.hooksPath tools/hooks";
    expect((await judge({ kind: "tool-use", role: null, tool: "shell", effects: [{ kind: "execute", command, cwd: null }], callId: "call-1" })).kind).toBe("allow");
  });
});
