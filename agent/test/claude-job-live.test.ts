// Opt-in, live: the host behaviour long gates depend on (ADR 2026-073).
// Skipped unless BOUNDED_CLAUDE_LIVE=1 (it costs one short model call).
//
//   BOUNDED_CLAUDE_LIVE=1 npx vitest run test/claude-job-live.test.ts
//
// A long gate on Claude Code starts its work as a detached job and answers
// RUNNING within the call's budget. That only works if Claude Code's Bash
// tool returns when its command exits, even though a child the command
// started in a new session (setsid, stdio to files, unref) is still running,
// and if that child outlives the call. Claude Code headless runs one Bash call
// with a 20 s timeout; the command's script starts such a child, which writes
// a marker 10 s later, and exits at once. The call must return well inside
// its timeout (under 5 s from the script's exit), and the marker must appear
// after the call returned.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const LIVE = process.env["BOUNDED_CLAUDE_LIVE"] === "1";

function claudeEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of ["CLAUDE_PROJECT_DIR", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "BOUNDED_GUARD_LOG", "BOUNDED_COMMAND_TIMEOUT_MS", "VITEST"]) delete env[name];
  return env;
}

describe.skipIf(!LIVE)("a detached job under Claude Code's Bash tool, live", () => {
  test("the Bash call returns when its command exits, and a setsid'd child outlives it", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "bounded-job-live-")));
    try {
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(join(dir, ".claude/settings.json"), "{}\n");
      const marker = join(dir, "marker.txt");
      const exited = join(dir, "exited.txt");
      writeFileSync(join(dir, "child.mjs"), [
        'import { writeFileSync } from "node:fs";',
        `setTimeout(() => writeFileSync(${JSON.stringify(marker)}, String(Date.now())), 10_000);`,
      ].join("\n"));
      writeFileSync(join(dir, "probe.mjs"), [
        'import { spawn } from "node:child_process";',
        'import { openSync, writeFileSync } from "node:fs";',
        `const out = openSync(${JSON.stringify(join(dir, "child.out"))}, "a");`,
        `const child = spawn(process.execPath, [${JSON.stringify(join(dir, "child.mjs"))}], { detached: true, stdio: ["ignore", out, out] });`,
        "child.unref();",
        'console.log("started " + child.pid);',
        `writeFileSync(${JSON.stringify(exited)}, String(Date.now()));`,
      ].join("\n"));

      let toolResultAt: number | undefined;
      let timeoutGiven: unknown;
      let buffer = "";
      let raw = "";
      const claude = spawn("claude", [
        "-p", "--model", "haiku", "--max-budget-usd", "1", "--setting-sources", "project",
        "--allowedTools", "Bash(node probe.mjs)", "--output-format", "stream-json", "--verbose", "--",
        "Make exactly one tool call: the Bash tool with command `node probe.mjs` and timeout 20000. Then reply DONE. Do not retry.",
      ], { cwd: dir, env: claudeEnv(), stdio: ["ignore", "pipe", "pipe"] });
      claude.stdout.on("data", (chunk) => {
        raw += String(chunk);
        buffer += String(chunk);
        const lines = buffer.split("\n");
        buffer = lines.pop()!;
        for (const line of lines) {
          if (line.trim() === "") continue;
          const event = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
          const content = Array.isArray(event.message?.content) ? event.message!.content as Record<string, unknown>[] : [];
          for (const part of content) {
            if (event.type === "assistant" && part["type"] === "tool_use" && part["name"] === "Bash") timeoutGiven = (part["input"] as Record<string, unknown>)["timeout"];
            if (event.type === "user" && part["type"] === "tool_result" && toolResultAt === undefined) toolResultAt = Date.now();
          }
        }
      });
      await new Promise<void>((done) => { claude.on("exit", () => done()); setTimeout(() => { claude.kill(); done(); }, 180_000); });
      for (let i = 0; i < 40 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 500));
      if (process.env["BOUNDED_LIVE_KEEP"] !== undefined) writeFileSync(process.env["BOUNDED_LIVE_KEEP"], raw);

      expect(timeoutGiven, "the Bash call was given a 20 s timeout").toBe(20000);
      expect(existsSync(exited), "the probe ran").toBe(true);
      expect(toolResultAt, "the Bash call returned").toBeDefined();
      const exitedAt = Number(readFileSync(exited, "utf8"));
      expect(toolResultAt! - exitedAt, "the call returned well inside its timeout").toBeLessThan(5000);
      expect(existsSync(marker), "the detached child outlived the call").toBe(true);
      expect(Number(readFileSync(marker, "utf8")), "the marker appeared after the call returned").toBeGreaterThan(toolResultAt!);
    } finally {
      if (process.env["BOUNDED_LIVE_KEEP"] === undefined) rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);
});
