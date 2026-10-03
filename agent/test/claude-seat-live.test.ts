// Opt-in, live: two ticket architects as the lead's background Claude Code
// subagents (ADR 2026-066), through this checkout's real hook. Skipped unless
// BOUNDED_CLAUDE_LIVE=1 (it costs a few short model calls).
//
// A scratch main worktree holds two marked ticket worktrees and the project
// hook on every seat event. The lead launches two architects in the
// background. Each launch is bound by WorktreeCreate to its ticket's existing
// worktree, each architect's calls are judged against its own worktree, its
// write outside is refused, both run at once, and SubagentStop records each
// end. (The second ticket's pending launch is written by a test-only hook
// after the first launch, standing in for the lead's `bounded lead start`.)
//
// Claude Code loads a subagent definition's own hooks only in a trusted
// project, and trust follows a worktree's repository. So the scratch main
// worktree is made a worktree of BOUNDED_LIVE_REPO, a repository the user has
// trusted (this harness checkout, say); in an untrusted folder the
// architect's calls are simply all refused, which proves nothing either way.
//
//   BOUNDED_CLAUDE_LIVE=1 BOUNDED_LIVE_REPO=<trusted repo> npx vitest run test/claude-seat-live.test.ts

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { readArchitectState, writePendingLaunch } from "../src/architect-seat.ts";
import { readGuardLog } from "../src/guard-log.ts";

const AGENT_ROOT = join(import.meta.dirname, "..");
const HOOK = `node ${join(AGENT_ROOT, "hosts", "claude-code", "path-gate-hook.ts")} --project-local --harness-root ${AGENT_ROOT}`;

const write = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const brief = (n: number, main: string): string =>
  `Ticket #${n}. Do exactly these, once each, without retrying, then report each result verbatim: ` +
  `1) Use Write with file_path ${join(main, ".bounded/worktrees", String(n), "docs/tn", `TN-${n}.md`)} containing "ticket ${n}". ` +
  `2) Use Write to create the file ${join(main, `outside-${n}.txt`)} containing "x". ` +
  "3) Run the Bash command: sleep 20";

function architectDefinition(): string {
  return ["---", "name: architect", "description: Ticket architect (live test).", "tools: Read, Write, Bash",
    "permissionMode: dontAsk", "hooks:", "  PreToolUse:", '    - matcher: ""', "      hooks:", "        - type: command",
    `          command: ${JSON.stringify(`${HOOK} --role architect`)}`, "---", "", "Do exactly what you are asked.", ""].join("\n");
}

const REPO = process.env["BOUNDED_LIVE_REPO"];

describe.skipIf(process.env["BOUNDED_CLAUDE_LIVE"] !== "1" || REPO === undefined)("two architects as background subagents, live", () => {
  test("bound to their worktrees, judged there, refused outside, running at once, ended by SubagentStop", () => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "bounded-seat-live-")));
    const main = join(scratch, "main");
    const tag = scratch.split("-").at(-1)!;
    const branches: string[] = [];
    try {
      execFileSync("git", ["-C", REPO!, "worktree", "add", "-q", "--detach", main, "HEAD"]);
      const installation = (dir: string): void => {
        write(join(dir, ".bounded/installation.json"), "{}\n");
        write(join(dir, ".bounded/harness/.keep"), "");
        write(join(dir, ".bounded/composed-packs.json"), '["ts"]\n');
        write(join(dir, ".claude/agents/architect.md"), architectDefinition());
      };
      installation(main);
      const worktrees = new Map<number, string>();
      for (const n of [7, 8]) {
        const wt = join(main, ".bounded/worktrees", String(n));
        branches.push(`seat-live-${tag}-${n}`);
        execFileSync("git", ["-C", main, "worktree", "add", "-q", "-b", branches.at(-1)!, wt, "HEAD"]);
        installation(wt);
        write(join(wt, ".bounded/ticket-worktree.json"), JSON.stringify({ issue: n, branch: `ticket/${n}`, main, owns: [] }));
        write(join(wt, "docs/tn/README.md"), "# TNs\n");
        write(join(wt, ".bounded/active-ticket"), `${n}\n`);
        write(join(wt, ".bounded/guard-log.jsonl"), JSON.stringify({ ts: "t", guard: "team-lead", verdict: "pass", summary: "prepared", detail: { kind: "run-prepared", ticket: String(n), boundary: "first" } }) + "\n");
        worktrees.set(n, wt);
      }
      writePendingLaunch(main, { issue: 7, worktree: worktrees.get(7)!, brief: brief(7, main), createdAt: "t" });
      write(join(main, "next-pending.mjs"), [
        'import { existsSync, writeFileSync } from "node:fs";',
        `const path = ${JSON.stringify(join(main, ".bounded/lead/pending-launch.json"))};`,
        `if (!existsSync(path) && !existsSync(${JSON.stringify(join(worktrees.get(8)!, ".bounded/architect/state.json"))})) {`,
        `  writeFileSync(path, ${JSON.stringify(JSON.stringify({ issue: 8, worktree: worktrees.get(8)!, brief: brief(8, main), createdAt: "t" }))});`,
        "}",
      ].join("\n"));
      const entry = (command: string, matcher = "") => [{ matcher, hooks: [{ type: "command", command }] }];
      write(join(main, ".claude/settings.json"), JSON.stringify({
        env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "0" },
        hooks: {
          PreToolUse: entry(HOOK),
          PostToolUse: [...entry(HOOK, "Agent|Task|SendMessage"), ...entry(`node ${join(main, "next-pending.mjs")}`, "Agent")],
          PostToolUseFailure: entry(HOOK, "Agent|Task|SendMessage"),
          WorktreeCreate: entry(HOOK),
          SubagentStop: entry(HOOK),
        },
      }, null, 2));
      const env: Record<string, string | undefined> = { ...process.env };
      for (const name of ["CLAUDE_PROJECT_DIR", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS", "BOUNDED_GUARD_LOG"]) delete env[name];
      const run = spawnSync("claude", [
        "-p", "--model", "haiku", "--max-budget-usd", "3", "--setting-sources", "project", "--output-format", "text", "--",
        "Call the Agent tool with subagent_type architect, isolation worktree and run_in_background true, prompt 'go'. " +
        "Then call the Agent tool again exactly the same way. Then wait until both have finished and report both results verbatim. Do not retry anything.",
      ], { cwd: main, env, encoding: "utf8", timeout: 420_000, stdio: ["ignore", "pipe", "pipe"] });

      if (process.env["BOUNDED_LIVE_KEEP"] !== undefined) writeFileSync(process.env["BOUNDED_LIVE_KEEP"], `${main}\n${run.stdout}\n${run.stderr}`);
      const seats = [7, 8].map((n) => ({ n, wt: worktrees.get(n)!, state: readArchitectState(worktrees.get(n)!) }));
      for (const { n, wt, state } of seats) {
        expect(state, `#${n} was bound`).toMatchObject({ state: "ended", turn: 1 });
        expect(readFileSync(join(wt, `docs/tn/TN-${n}.md`), "utf8")).toContain(`ticket ${n}`);
        // Refused outside: by the gate, judged against this worktree, or before it by Claude Code's own isolation.
        expect(existsSync(join(main, `outside-${n}.txt`))).toBe(false);
        expect(readGuardLog(wt).some((e) => e.guard === "host"), `#${n}'s calls were judged in its worktree`).toBe(true);
      }
      expect(readGuardLog(main).some((e) => e.guard === "host")).toBe(false);
      expect(seats[0]!.state!.agent).not.toBe(seats[1]!.state!.agent);
      // Both ran at once: the second started before the first ended.
      expect(Date.parse(seats[1]!.state!.startedAt)).toBeLessThan(Date.parse(seats[0]!.state!.endedAt!));
    } finally {
      if (process.env["BOUNDED_LIVE_KEEP"] === undefined) {
        for (const n of [7, 8]) spawnSync("git", ["-C", REPO!, "worktree", "remove", "--force", join(main, ".bounded/worktrees", String(n))]);
        spawnSync("git", ["-C", REPO!, "worktree", "remove", "--force", main]);
        for (const branch of branches) spawnSync("git", ["-C", REPO!, "branch", "-D", branch]);
        rmSync(scratch, { recursive: true, force: true });
      }
    }
  }, 480_000);
});
