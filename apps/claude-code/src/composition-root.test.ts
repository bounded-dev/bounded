import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolResult, Verdict } from "bounded/domain";
import { afterToolFromConfig, composeHook, DEADLINE_MS, DRAIN_MS, decideFromConfig, recordFromConfig } from "./composition-root.ts";
import type { ToolUse } from "./event.ts";
import type { Decide } from "./hook.ts";
import { HOOK_TIMEOUT_SECONDS } from "./install.ts";

/** A value's wire form: its JSON, parsed. */
const wireOf = (value: unknown): unknown => JSON.parse(JSON.stringify(value) ?? "null");

let root = "";
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "bounded-cc-root-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const recording =
  (seen: ToolUse[]): Decide =>
  (event) => {
    seen.push(event);
    return Verdict.allow;
  };
const reasonOf = (out: string): string => JSON.parse(out).hookSpecificOutput.permissionDecisionReason;
const write = (cwd: string): string => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: join(root, "src", "a.ts"), content: "" }, cwd });

describe("composeHook: the hook wired to the file system, the environment and argv", () => {
  test("builds events from real paths, with the role from --role", async () => {
    for (const argv of [["--role", "builder"], ["--role=builder"]]) {
      const seen: ToolUse[] = [];
      const hook = composeHook({ env: { CLAUDE_PROJECT_DIR: root }, argv, decide: recording(seen) });
      expect(await hook(write(join(root, "src")))).toBe("");
      expect(wireOf(seen)).toEqual([{ kind: "tool-use", role: "builder", tool: "write", effects: [{ kind: "write", path: "src/a.ts", change: "modify" }] }]);
    }
  });

  test("no --role is no role", async () => {
    const seen: ToolUse[] = [];
    await composeHook({ env: { CLAUDE_PROJECT_DIR: root }, argv: [], decide: recording(seen) })(write(root));
    expect(seen[0]?.role).toBeNull();
  });

  test("without an absolute CLAUDE_PROJECT_DIR every call is denied", async () => {
    for (const env of [{}, { CLAUDE_PROJECT_DIR: "" }, { CLAUDE_PROJECT_DIR: "relative/dir" }]) {
      const out = await composeHook({ env, argv: [], decide: () => Verdict.allow })(write(root));
      expect(reasonOf(out)).toBe("CLAUDE_PROJECT_DIR is not set to an absolute directory, so no path can be checked\nRun the hook from Claude Code, which sets CLAUDE_PROJECT_DIR to the project's root");
    }
  });

  test("--role without a label denies every call", async () => {
    const out = await composeHook({ env: { CLAUDE_PROJECT_DIR: root }, argv: ["--role"], decide: () => Verdict.allow })(write(root));
    expect(reasonOf(out)).toBe("--role is given without a role label\nGive the role after it, as in --role builder");
  });

  test("decideFromConfig judges with the project's configuration; a project without one refuses, saying why", async () => {
    const event = { kind: "tool-use", role: null, tool: "read", effects: [{ kind: "read", path: "src/a.ts" }] } as unknown as ToolUse;
    const verdict = await decideFromConfig(event, { projectDir: root });
    expect(verdict.kind === "refuse" && verdict.reason).toStartWith("This project's configuration cannot be used: ");
  });

  test("recordFromConfig records the adapter's own refusal in the project's guard log", async () => {
    await recordFromConfig({ tool: "Read", reason: "no file_path", redirect: "give one", role: null, input: {} }, { projectDir: root });
    const file = join(root, ".bounded", "guard-log.jsonl");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain('"event":"adapter"');
  });

  test("afterToolFromConfig asks the project's judge; with no snapshot there is nothing to undo", async () => {
    const result = ToolResult.parse({ kind: "tool-result", role: null, tool: "shell", effects: [{ kind: "execute", command: "ls" }], ok: true, callId: "toolu_x" });
    if (!result.ok) throw new Error(result.error);
    expect(await afterToolFromConfig(result.value, { projectDir: root })).toEqual({ message: null });
  });

  test("bounded answers before Claude Code's timeout for the installed hook", () => {
    expect(DEADLINE_MS).toBeLessThan(HOOK_TIMEOUT_SECONDS * 1000 - 2000);
  });

  test("the deadline and the drain after the answer both end before Claude Code's timeout for the hook", () => {
    expect(DEADLINE_MS + DRAIN_MS).toBeLessThan(HOOK_TIMEOUT_SECONDS * 1000 - 2000);
  });
});
