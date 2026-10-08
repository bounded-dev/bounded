// The configuration `bounded init` writes: live, selecting the core and the
// path gate with the two default rules that keep agents off the project's
// guardrails (the path gate ships no rules of its own, ADR 2026-009).
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openProject } from "bounded/open-project";
import { pathGateFileSystem } from "bounded/path-gate/adapters/file-system";
import { pathGateTreeSitter } from "bounded/path-gate/adapters/tree-sitter";
import { INITIAL_CONFIG } from "./initial-config.ts";

const CORE = resolve(import.meta.dir, "../../../contexts/core");

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
  test("selects the core and the path gate, contributing the two default rules with their reasons, under a comment saying they may be changed", () => {
    expect(INITIAL_CONFIG).toContain('import { contribution, corePack, defineConfig } from "bounded/domain";');
    expect(INITIAL_CONFIG).toContain('import { pathGate } from "bounded/path-gate";');
    expect(INITIAL_CONFIG).toContain("packs: [corePack, pathGate],");
    expect(INITIAL_CONFIG).toContain('match: "**/bounded.config.*"');
    expect(INITIAL_CONFIG).toContain('match: ".bounded/**"');
    expect(INITIAL_CONFIG).toContain("Ask a person to change the project's Bounded configuration; describe the change you need");
    expect(INITIAL_CONFIG).toContain("the project's guardrails are changed by people, not by agents");
    expect(INITIAL_CONFIG).toContain("Leave .bounded/ to Bounded; ask a person if its state looks wrong");
    expect(INITIAL_CONFIG).toContain("Bounded's own state and guard log");
    expect(INITIAL_CONFIG).toMatch(/defaults/i);
    expect(INITIAL_CONFIG).toContain("README");
  });

  test("is a working configuration: an agent's edit of it, or of .bounded/, is refused; other edits are allowed", async () => {
    const root = project();
    const { judge, problem } = await openProject(root, { ports: [...pathGateFileSystem(), ...pathGateTreeSitter()] });
    expect(problem).toBeNull();
    const refused = await judge(edit("bounded.config.ts"));
    expect(refused.kind).toBe("refuse");
    expect(refused.kind === "refuse" && refused.reason).toContain("the rule '**/bounded.config.*' from bounded/project");
    expect((await judge(edit(".bounded/guard-log.jsonl"))).kind).toBe("refuse");
    expect((await judge(edit("src/index.ts"))).kind).toBe("allow");
  });

  test("also keeps agents off Claude Code's settings, pi's loader and bounded's installed code, saying why", async () => {
    expect(INITIAL_CONFIG).toContain('match: ".claude/settings.json"');
    expect(INITIAL_CONFIG).toContain("Claude Code's settings hold Bounded's hook");
    expect(INITIAL_CONFIG).toContain("Ask a person to change Claude Code's settings");
    expect(INITIAL_CONFIG).toContain('match: ".pi/extensions/bounded/**"');
    expect(INITIAL_CONFIG).toContain('match: "node_modules/bounded/**"');
    const { judge } = await openProject(project(), { ports: [...pathGateFileSystem(), ...pathGateTreeSitter()] });
    for (const path of [".claude/settings.json", ".pi/extensions/bounded/index.ts", "node_modules/bounded/dist/hosts/claude-code/hook.js"]) {
      for (const change of ["create", "modify", "delete"] as const) {
        expect((await judge({ kind: "tool-use", role: null, tool: "edit", effects: [{ kind: "write", path, change }] })).kind).toBe("refuse");
      }
    }
    expect((await judge(edit(".claude/commands/review.md"))).kind).toBe("allow");
    expect((await judge({ kind: "tool-use", role: null, tool: "read", effects: [{ kind: "read", path: ".claude/settings.json" }] })).kind).toBe("allow");
  });
});
