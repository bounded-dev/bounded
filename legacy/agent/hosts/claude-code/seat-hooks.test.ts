import { describe, expect, test } from "vitest";
import { isClaudeProcess, sessionProcess } from "./seat-hooks.ts";

// The Claude Code process a seat runs in (final review): found for the
// native and the npm builds, and never the short-lived hook process.

describe("sessionProcess", () => {
  test.each([
    ["/Users/me/.local/share/claude/versions/2.1.288", "", true],
    ["claude", "", true],
    ["/opt/homebrew/bin/claude", "", true],
    ["/usr/local/bin/node", "node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js", true],
    ["node", "node /Users/me/.npm-global/bin/claude --resume x", true],
    ["/bin/zsh", "zsh -c node hook.ts", false],
    ["node", "node /project/.bounded/harness/hosts/claude-code/bootstrap-hook.ts", false],
  ])("%s %s is Claude Code: %s", (comm, args, expected) => {
    expect(isClaudeProcess(comm, args)).toBe(expected);
  });

  test("walks up past the shell and the hook to the Claude Code process", () => {
    const table = new Map([
      [process.ppid, { ppid: 500, comm: "/bin/sh", args: "sh -c node hook" }],
      [500, { ppid: 400, comm: "/Users/me/.local/share/claude/versions/2.1.288", args: "claude" }],
    ]);
    expect(sessionProcess((pid) => table.get(pid)).pid).toBe(500);
  });

  test("with no Claude Code ancestor the start time is unknown, never the hook's own", () => {
    expect(sessionProcess(() => undefined)).toEqual({ pid: 0, pidStarted: "unknown" });
  });
});
