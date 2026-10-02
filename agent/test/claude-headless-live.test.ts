// Opt-in, live: a launched Claude Code architect session whose gate hook does
// not run can change nothing (ADR 2026-066). It launches the exact command
// line `bounded lead start` uses, in a scratch git checkout whose settings
// register no hook, and asks for a file write and a shell write. Claude Code
// in dontAsk mode with nothing pre-approved refuses both: only the hook's
// explicit allow lets such a call run. Skipped unless BOUNDED_CLAUDE_LIVE=1
// (it costs one short model call).
//
//   BOUNDED_CLAUDE_LIVE=1 npx vitest run test/claude-headless-live.test.ts

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { CLAUDE_ARCHITECT_HOST } from "../hosts/claude-code/architect-launch.ts";

/** Run the launch command line in a scratch checkout with `settings`; say which writes landed. */
function launch(settings: unknown): { written: boolean; touched: boolean } {
  const dir = mkdtempSync(join(tmpdir(), "bounded-cc-live-"));
  try {
    execFileSync("git", ["init", "-q", dir]);
    mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify(settings));
    writeFileSync(join(dir, "allow.sh"), "#!/bin/sh\ncat >/dev/null\necho '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"allow\"}}'\n", { mode: 0o755 });
    writeFileSync(join(dir, ".claude", "agents", "architect.md"), "---\nname: architect\ntools: Read, Write, Bash\n---\nDo exactly what you are asked, once each.\n");
    const command = CLAUDE_ARCHITECT_HOST.command({
      worktree: dir, sessionId: crypto.randomUUID(), resume: false, model: "haiku",
      message: "Do these two things once each, without retrying: 1) Write the file written.txt containing hi. 2) Run the Bash command: touch touched.txt",
    });
    const env: Record<string, string | undefined> = { ...process.env, ...command.env };
    for (const name of command.unset ?? []) delete env[name];
    spawnSync(command.command, [...command.args], { cwd: dir, env, encoding: "utf8", timeout: 240_000, stdio: ["ignore", "pipe", "pipe"] });
    return { written: existsSync(join(dir, "written.txt")), touched: existsSync(join(dir, "touched.txt")) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(process.env["BOUNDED_CLAUDE_LIVE"] !== "1")("a launched Claude Code session without its hook", () => {
  test("writes nothing: not a file, not through the shell", () => {
    expect(launch({})).toEqual({ written: false, touched: false });
  }, 300_000);

  // The control: the same command line, with a hook that allows in words,
  // does write — so the refusal above is the missing hook, not a broken run.
  test("with a hook that allows explicitly, the same calls run", () => {
    expect(launch({ hooks: { PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: "./allow.sh" }] }] } }))
      .toEqual({ written: true, touched: true });
  }, 300_000);
});
