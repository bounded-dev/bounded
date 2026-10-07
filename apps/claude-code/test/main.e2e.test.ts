// The hook as Claude Code runs it: a subprocess given the payload on stdin,
// answering on stdout, always exiting 0.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const APP = join(import.meta.dir, "..");
let root = "";
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "bounded-cc-e2e-")));
  mkdirSync(join(root, "src"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function run(entry: string, stdin: string): Promise<{ stdout: string; exitCode: number }> {
  const child = Bun.spawn(["bun", join(APP, entry)], { stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe", env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { stdout, exitCode };
}
const deny = (reason: string): string => JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });

describe("main.ts as a Claude Code PreToolUse hook", () => {
  test("a refusing decide is a deny on stdout, exit 0", async () => {
    const payload = { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: join(root, "src", "new.ts"), content: "x" }, cwd: root, session_id: "s", tool_use_id: "t" };
    const { stdout, exitCode } = await run("test/fixtures/refusing-hook.ts", JSON.stringify(payload));
    expect(stdout).toBe(deny('Refused write: [{"kind":"write","path":"src/new.ts","change":"create"}]\nAsk the project\'s maintainer'));
    expect(exitCode).toBe(0);
  });

  test("garbage on stdin is a deny, exit 0: never a crash Claude Code would read as allow", async () => {
    const { stdout, exitCode } = await run("src/main.ts", "\u0000 not json");
    expect(stdout).toStartWith('{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"The hook\'s input is not JSON: ');
    expect(exitCode).toBe(0);
  });

  test("main.ts alone, before bounded.config.ts is wired in, refuses", async () => {
    const payload = { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: join(root, "src") }, cwd: root };
    const { stdout, exitCode } = await run("src/main.ts", JSON.stringify(payload));
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(exitCode).toBe(0);
  });
});
