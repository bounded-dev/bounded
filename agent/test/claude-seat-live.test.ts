// Opt-in, live: ticket architects as the lead's background Claude Code
// subagents (ADR 2026-066), through this checkout's real hook entry. Skipped
// unless BOUNDED_CLAUDE_LIVE=1 and BOUNDED_LIVE_REPO is set (it costs a few
// short model calls).
//
// Claude Code loads a project's subagent definitions and their permission
// mode only in a trusted project, and trust follows a worktree's repository.
// So each scratch project is made a worktree of BOUNDED_LIVE_REPO, a
// repository the user has trusted (this harness checkout, say).
//
//   BOUNDED_CLAUDE_LIVE=1 BOUNDED_LIVE_REPO=<trusted repo> npx vitest run test/claude-seat-live.test.ts
//
// 1. The seat. A scratch main worktree with a copied harness, the installer's
//    own settings, and two marked ticket worktrees, each with its own harness
//    copy. The lead launches two architects in the background. Each launch is
//    bound by WorktreeCreate to its ticket's existing worktree; each call is
//    routed by the real bootstrap entry to that worktree's harness and judged
//    there; a write outside is refused; both run at once and are seen running
//    while they work; SubagentStop records each end; the ticket whose
//    architect wrote nothing keeps its worktree. (The second ticket's pending
//    launch is written by a test-only hook after the lead's next call, standing
//    in for the lead's `bounded lead start`.)
// 2. A worker's continuation. With background tasks on, an architect
//    commissions a reviewer in the foreground and continues it with
//    SendMessage. Claude Code 2.1.288 resumes the worker in the BACKGROUND:
//    the SendMessage result is "Resuming agent ..." with its id, not the
//    reply. That is why the hook records such a resume and no gate runs in a
//    ticket worktree until the worker's stop is recorded (board-sync.ts).
//    This test pins the host behaviour the safeguard depends on.
// 3. The block's release (re-review U2). The same continuation, with the
//    architect in a marked ticket worktree and the real project hook on
//    PostToolUse(SendMessage) and SubagentStop: the hook records the
//    background resume, SubagentStop fires for the resumed worker with its
//    agent_id and the worktree as cwd, and the gates are free again.
//    (PreToolUse is left off, so no run need be prepared for the phase gate;
//    a test WorktreeCreate hook stands in for the lead's binding.)
// 4. A seat outlives its session only on disk (re-review U1). A new session
//    cannot continue an agent a finished session started: SendMessage finds
//    no transcript. So a seat whose session has gone is relaunched into its
//    worktree by `bounded lead start`, never continued.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { architectStatus, readArchitectState, writePendingLaunch } from "../src/architect-seat.ts";
import { readGuardLog } from "../src/guard-log.ts";
import { backgroundWorkers, SUBAGENT_STOPPED, WORKER_RESUMED } from "../src/lead-state.ts";
import { mergeAmbientHook } from "../hosts/claude-code/install.ts";

const AGENT_ROOT = join(import.meta.dirname, "..");
const REPO = process.env["BOUNDED_LIVE_REPO"];
const LIVE = process.env["BOUNDED_CLAUDE_LIVE"] === "1" && REPO !== undefined;
const ENTRY = 'node "${CLAUDE_PROJECT_DIR}/.bounded/harness/hosts/claude-code/bootstrap-hook.ts" --project-local';

const write = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

/** A project-local installation, as init and setup leave it: the harness
 *  copy (with its dependencies) and the marks that say setup is done. */
function installHarness(dir: string): void {
  const harness = join(dir, ".bounded", "harness");
  const skip = (path: string): boolean => /(^|\/)(node_modules|testdata|reference)(\/|$)/.test(path) || /\.test\.tsx?$/.test(path);
  for (const tree of ["src", "trackers", join("hosts", "claude-code"), join("packs", "ts")]) {
    cpSync(join(AGENT_ROOT, tree), join(harness, tree), { recursive: true, filter: (source) => !skip(source.slice(AGENT_ROOT.length)) });
  }
  symlinkSync(join(AGENT_ROOT, "node_modules"), join(harness, "node_modules"));
  write(join(dir, ".bounded/installation.json"), '{"host":"claude-code"}\n');
  write(join(dir, ".bounded/composed-packs.json"), '["ts"]\n');
  write(join(dir, ".bounded/setup-complete"), "complete\n");
  mkdirSync(join(dir, "node_modules/.bun"), { recursive: true });
}

function definition(role: string, tools: string, body: string): string {
  return ["---", `name: ${role}`, `description: ${role} (live test).`, `tools: ${tools}`, "permissionMode: dontAsk", "hooks:",
    "  PreToolUse:", '    - matcher: ""', "      hooks:", "        - type: command", `          command: ${JSON.stringify(`${ENTRY} --role ${role}`)}`,
    "---", "", body, ""].join("\n");
}

/** A scratch worktree of the trusted repository, and how to remove it. */
function scratchProject(): { main: string; cleanup: (extra: readonly string[]) => void; branch: (n: number) => string } {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "bounded-seat-live-")));
  const main = join(scratch, "main");
  const tag = scratch.split("-").at(-1)!;
  const branches: string[] = [];
  execFileSync("git", ["-C", REPO!, "worktree", "add", "-q", "--detach", main, "HEAD"]);
  return {
    main,
    branch: (n) => { branches.push(`seat-live-${tag}-${n}`); return branches.at(-1)!; },
    cleanup: (worktrees) => {
      if (process.env["BOUNDED_LIVE_KEEP"] !== undefined) return;
      for (const wt of worktrees) spawnSync("git", ["-C", REPO!, "worktree", "remove", "--force", wt]);
      spawnSync("git", ["-C", REPO!, "worktree", "remove", "--force", main]);
      for (const b of branches) spawnSync("git", ["-C", REPO!, "branch", "-D", b]);
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}

function claudeEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of ["CLAUDE_PROJECT_DIR", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS", "BOUNDED_GUARD_LOG", "VITEST"]) delete env[name];
  return env;
}

describe.skipIf(!LIVE)("ticket architects as background subagents, live", () => {
  test("bound, routed by the real entry, judged in their worktrees, refused outside, running at once, ended, worktrees kept", async () => {
    const { main, cleanup, branch } = scratchProject();
    const worktrees = new Map<number, string>();
    try {
      installHarness(main);
      write(join(main, ".claude/agents/architect.md"), definition("architect", "Read, Write, Bash", "Do exactly what you are asked."));
      for (const n of [7, 8]) {
        const wt = join(main, ".bounded/worktrees", String(n));
        execFileSync("git", ["-C", main, "worktree", "add", "-q", "-b", branch(n), wt, "HEAD"]);
        installHarness(wt);
        write(join(wt, ".claude/agents/architect.md"), definition("architect", "Read, Write, Bash", "Do exactly what you are asked."));
        write(join(wt, ".bounded/ticket-worktree.json"), JSON.stringify({ issue: n, branch: `ticket/${n}`, main, owns: [] }));
        write(join(wt, ".bounded/active-ticket"), `${n}\n`);
        worktrees.set(n, wt);
      }
      const wt7 = worktrees.get(7)!;
      const wt8 = worktrees.get(8)!;
      const brief = (n: number, steps: string) => `Ticket #${n}. Do exactly these, once each, without retrying, then report each result verbatim: ${steps}`;
      const outside = (n: number) => `Use Write with file_path ${join(main, `outside-${n}.txt`)} containing "x".`;
      writePendingLaunch(main, {
        issue: 7, worktree: wt7, createdAt: "t",
        brief: brief(7, `1) Use Write with file_path ${join(wt7, "docs/tn/TN-7.md")} containing "ticket 7". 2) ${outside(7)} 3) Use Read on README.md, then on AGENTS.md, then on LICENSE.`),
      });
      // Ticket 8's architect writes nothing at all: its worktree must survive.
      write(join(main, "next-pending.mjs"), [
        'import { existsSync, writeFileSync } from "node:fs";',
        `const path = ${JSON.stringify(join(main, ".bounded/lead/pending-launch.json"))};`,
        `if (!existsSync(path) && !existsSync(${JSON.stringify(join(wt8, ".bounded/architect/state.json"))})) {`,
        `  writeFileSync(path, ${JSON.stringify(JSON.stringify({ issue: 8, worktree: wt8, createdAt: "t", brief: brief(8, `1) ${outside(8)} 2) Use Read on README.md, then on AGENTS.md, then on LICENSE.`) }))});`,
        "}",
      ].join("\n"));
      const merged = mergeAmbientHook({}, ENTRY);
      if (!merged.ok) throw new Error(merged.reason);
      const hooks = { ...(merged.value["hooks"] as Record<string, unknown[]>) };
      hooks["PostToolUse"] = [...hooks["PostToolUse"]!, { matcher: "Read", hooks: [{ type: "command", command: `node ${join(main, "next-pending.mjs")}` }] }];
      write(join(main, ".claude/settings.json"), JSON.stringify({ ...merged.value, hooks }, null, 2));

      const seenRunning = new Set<number>();
      const lead = spawn("claude", [
        "-p", "--model", "haiku", "--max-budget-usd", "3", "--setting-sources", "project", "--output-format", "text", "--",
        "Make exactly one tool call per message, in this order. 1) Call the Agent tool with subagent_type architect, isolation worktree " +
        "and run_in_background true, prompt 'go'. 2) Read the file README.md. 3) Call the Agent tool again exactly as in step 1. " +
        "Then wait until both architects have finished and report both results verbatim. Do not retry anything.",
      ], { cwd: main, env: claudeEnv(), stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      lead.stdout.on("data", (chunk) => { output += String(chunk); });
      const poll = setInterval(() => {
        for (const [n, wt] of worktrees) if (architectStatus(wt).kind === "running") seenRunning.add(n);
      }, 1000);
      await new Promise<void>((done) => { lead.on("exit", () => done()); setTimeout(() => { lead.kill(); done(); }, 420_000); });
      clearInterval(poll);
      if (process.env["BOUNDED_LIVE_KEEP"] !== undefined) writeFileSync(process.env["BOUNDED_LIVE_KEEP"], `${main}\n${output}`);

      const seats = [7, 8].map((n) => ({ n, wt: worktrees.get(n)!, state: readArchitectState(worktrees.get(n)!) }));
      for (const { n, wt, state } of seats) {
        expect(state, `#${n} was bound`).toMatchObject({ state: "ended", turn: 1 });
        expect(seenRunning.has(n), `#${n} was seen running while it worked`).toBe(true);
        expect(existsSync(join(main, `outside-${n}.txt`))).toBe(false);
        // Routed by the real entry: its calls were judged in its own worktree.
        expect(readGuardLog(wt).some((e) => e.guard === "host"), `#${n} judged in its worktree`).toBe(true);
        expect(existsSync(wt), `#${n}'s worktree was kept`).toBe(true);
      }
      expect(readFileSync(join(wt7, "docs/tn/TN-7.md"), "utf8")).toContain("ticket 7");
      expect(readGuardLog(main).some((e) => e.guard === "host")).toBe(false);
      expect(seats[0]!.state!.agent).not.toBe(seats[1]!.state!.agent);
      expect(Date.parse(seats[1]!.state!.startedAt)).toBeLessThan(Date.parse(seats[0]!.state!.endedAt!));
    } finally {
      cleanup([...worktrees.values()]);
    }
  }, 480_000);

  test("with background tasks on, a worker continued with SendMessage resumes in the background", () => {
    const { main, cleanup } = scratchProject();
    try {
      const plain = (role: string, tools: string, body: string) => ["---", `name: ${role}`, `description: ${role} (live test).`, `tools: ${tools}`, "---", "", body, ""].join("\n");
      write(join(main, ".claude/agents/architect.md"), plain("architect", "Agent, SendMessage", "Do exactly what you are asked."));
      write(join(main, ".claude/agents/reviewer.md"), plain("reviewer", "Read", "Answer exactly what you are asked, in one word."));
      write(join(main, "log-send.mjs"), [
        'import { appendFileSync, readFileSync } from "node:fs";',
        `appendFileSync(${JSON.stringify(join(main, "send.jsonl"))}, readFileSync(0, "utf8").replace(/\\n/g, " ") + "\\n");`,
      ].join("\n"));
      write(join(main, ".claude/settings.json"), JSON.stringify({
        env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "0" },
        hooks: { PostToolUse: [{ matcher: "SendMessage", hooks: [{ type: "command", command: `node ${join(main, "log-send.mjs")}` }] }] },
      }));
      spawnSync("claude", [
        "-p", "--model", "haiku", "--max-budget-usd", "2", "--setting-sources", "project", "--allowedTools", "Agent", "SendMessage", "--output-format", "text", "--",
        "Call the Agent tool once with subagent_type architect, run_in_background true and this prompt: " +
        "'1) Call the Agent tool with subagent_type reviewer, run_in_background false, prompt: Reply with exactly READY. " +
        "2) Then call SendMessage with to set to that reviewer's agent id and message: say PONG. 3) Report the SendMessage result verbatim.' " +
        "Wait until it finishes and report its result verbatim.",
      ], { cwd: main, env: claudeEnv(), encoding: "utf8", timeout: 300_000, stdio: ["ignore", "pipe", "pipe"] });
      const sends = existsSync(join(main, "send.jsonl")) ? readFileSync(join(main, "send.jsonl"), "utf8").trim().split("\n") : [];
      expect(sends.length, "the architect continued its reviewer").toBeGreaterThan(0);
      const responses = sends.map((line) => (JSON.parse(line) as { tool_response?: Record<string, unknown> }).tool_response ?? {});
      // Not inline: the result names the resumed worker, and carries no reply.
      expect(responses.some((r) => r["success"] === true && typeof r["resumedAgentId"] === "string")).toBe(true);
      expect(responses.some((r) => /PONG/i.test(JSON.stringify(r)))).toBe(false);
    } finally {
      cleanup([]);
    }
  }, 360_000);

  test("the project hook records the background resume, and the resumed worker's SubagentStop (its agent_id, the worktree as cwd) frees the gates", () => {
    const { main, cleanup, branch } = scratchProject();
    const wt = join(main, ".bounded/worktrees/7");
    try {
      installHarness(main);
      execFileSync("git", ["-C", main, "worktree", "add", "-q", "-b", branch(7), wt, "HEAD"]);
      installHarness(wt);
      write(join(wt, ".bounded/ticket-worktree.json"), JSON.stringify({ issue: 7, branch: "ticket/7", main, owns: [] }));
      write(join(wt, ".bounded/active-ticket"), "7\n");
      // Definitions the project hook proves (their own PreToolUse hook is a no-op here).
      const proven = (role: string, tools: string, body: string) => ["---", `name: ${role}`, `description: ${role} (live test).`, `tools: ${tools}`,
        "hooks:", "  PreToolUse:", '    - matcher: ""', "      hooks:", "        - type: command", `          command: "true --role ${role}"`, "---", "", body, ""].join("\n");
      for (const dir of [main, wt]) {
        write(join(dir, ".claude/agents/architect.md"), proven("architect", "Agent, SendMessage", "Do exactly what you are asked."));
        write(join(dir, ".claude/agents/reviewer.md"), proven("reviewer", "Read", "Answer exactly what you are asked, in one word."));
      }
      const raw = join(main, "events.jsonl");
      write(join(main, "log-event.mjs"), [
        'import { appendFileSync, readFileSync } from "node:fs";',
        `appendFileSync(${JSON.stringify(raw)}, readFileSync(0, "utf8").replace(/\\n/g, " ") + "\\n");`,
      ].join("\n"));
      write(join(main, "wt-create.mjs"), `process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(${JSON.stringify(`${wt}\n`)}));`);
      const run = (command: string) => ({ type: "command", command });
      write(join(main, ".claude/settings.json"), JSON.stringify({
        env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "0" },
        hooks: {
          WorktreeCreate: [{ hooks: [run(`node ${join(main, "wt-create.mjs")}`)] }],
          WorktreeRemove: [{ hooks: [run("true")] }],
          PostToolUse: [{ matcher: "SendMessage", hooks: [run(`node ${join(main, "log-event.mjs")}`), run(ENTRY)] }],
          SubagentStop: [{ hooks: [run(`node ${join(main, "log-event.mjs")}`), run(ENTRY)] }],
        },
      }));
      spawnSync("claude", [
        "-p", "--model", "haiku", "--max-budget-usd", "2", "--setting-sources", "project", "--allowedTools", "Agent", "SendMessage", "Read",
        "--output-format", "text", "--",
        "Call the Agent tool once with subagent_type architect, isolation worktree, run_in_background false and this prompt: " +
        "'1) Call the Agent tool with subagent_type reviewer, run_in_background false, prompt: Reply with exactly READY. " +
        "2) Then call SendMessage with to set to that reviewer's agent id and message: say PONG. " +
        "3) Wait until the reviewer has answered PONG, then report its answer verbatim.' " +
        "Wait until it finishes, and until every agent it started has finished, then report its result verbatim.",
      ], { cwd: main, env: claudeEnv(), encoding: "utf8", timeout: 420_000, stdio: ["ignore", "pipe", "pipe"] });
      const events = existsSync(raw) ? readFileSync(raw, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>) : [];
      const send = events.find((e) => e["hook_event_name"] === "PostToolUse" && typeof (e["tool_response"] as Record<string, unknown> | undefined)?.["resumedAgentId"] === "string");
      expect(send, "the architect's continuation resumed its reviewer in the background").toBeDefined();
      const worker = (send!["tool_response"] as Record<string, unknown>)["resumedAgentId"] as string;
      const stops = events.filter((e) => e["hook_event_name"] === "SubagentStop" && e["agent_id"] === worker);
      // The commissioned run's stop, and the background-resumed run's stop after the send.
      expect(stops.length, "SubagentStop fired for the resumed worker").toBeGreaterThanOrEqual(1);
      expect(events.indexOf(stops.at(-1)!)).toBeGreaterThan(events.indexOf(send!));
      expect(realpathSync(String(stops.at(-1)!["cwd"]))).toBe(realpathSync(wt));
      const log = readGuardLog(wt);
      const kinds = log.map((e) => (e.detail as Record<string, unknown> | undefined)?.["kind"]);
      expect(kinds).toContain(WORKER_RESUMED);
      expect(log.filter((e) => (e.detail as Record<string, unknown> | undefined)?.["kind"] === SUBAGENT_STOPPED)
        .map((e) => (e.detail as Record<string, unknown>)["agent"])).toContain(worker);
      expect(kinds.lastIndexOf(SUBAGENT_STOPPED)).toBeGreaterThan(kinds.indexOf(WORKER_RESUMED));
      expect(backgroundWorkers(log), "the gates are free again").toEqual([]);
    } finally {
      cleanup([wt]);
    }
  }, 480_000);

  test("a new session cannot continue an agent that a finished session started", () => {
    const { main, cleanup } = scratchProject();
    try {
      write(join(main, ".claude/agents/probe.md"), ["---", "name: probe", "description: probe (live test).", "tools: Read", "---", "", "Answer in one word.", ""].join("\n"));
      const raw = join(main, "events.jsonl");
      write(join(main, "log-event.mjs"), [
        'import { appendFileSync, readFileSync } from "node:fs";',
        `appendFileSync(${JSON.stringify(raw)}, readFileSync(0, "utf8").replace(/\\n/g, " ") + "\\n");`,
      ].join("\n"));
      const log = { type: "command", command: `node ${join(main, "log-event.mjs")}` };
      write(join(main, ".claude/settings.json"), JSON.stringify({
        env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "0" },
        hooks: { SubagentStop: [{ hooks: [log] }], PostToolUse: [{ matcher: "SendMessage", hooks: [log] }], PostToolUseFailure: [{ matcher: "SendMessage", hooks: [log] }] },
      }));
      const claude = (tools: string[], prompt: string) => spawnSync("claude", [
        "-p", "--model", "haiku", "--max-budget-usd", "1", "--setting-sources", "project", "--allowedTools", ...tools, "--output-format", "text", "--", prompt,
      ], { cwd: main, env: claudeEnv(), encoding: "utf8", timeout: 240_000, stdio: ["ignore", "pipe", "pipe"] });
      const events = () => existsSync(raw) ? readFileSync(raw, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>) : [];
      claude(["Agent"], "Call the Agent tool once with subagent_type probe, run_in_background true, prompt: Reply READY. Wait for it to finish, then stop.");
      const agent = events().find((e) => e["hook_event_name"] === "SubagentStop" && e["agent_type"] === "probe")?.["agent_id"];
      expect(typeof agent, "the first session's agent ran and stopped").toBe("string");
      claude(["SendMessage", "ToolSearch"], `Use the SendMessage tool (load it with ToolSearch if needed) with to set to ${String(agent)} and message: say PONG. Report the tool result verbatim. Do not retry.`);
      const sends = events().filter((e) => e["tool_name"] === "SendMessage");
      expect(sends.length, "the second session tried the continuation").toBeGreaterThan(0);
      expect(sends.some((e) => e["hook_event_name"] === "PostToolUse" && (e["tool_response"] as Record<string, unknown> | undefined)?.["success"] === true)).toBe(false);
      // Claude Code 2.1.288: "Agent … could not be resumed: No transcript found for agent ID".
      expect(JSON.stringify(sends)).toMatch(/could not be resumed|No transcript/);
      expect(events().filter((e) => e["hook_event_name"] === "SubagentStop" && e["agent_id"] === agent)).toHaveLength(1);
    } finally {
      cleanup([]);
    }
  }, 600_000);
});
