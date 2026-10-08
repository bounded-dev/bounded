// Dependency-free project hook entry (ADR LEG-2026-048, ADR LEG-2026-051). A fresh
// clone has no harness packages, so importing path-gate-hook.ts before setup
// would fail. This entry and everything it imports use Node builtins only.
//
// Decision order, identical to the pi bootstrap:
//   1. the exact setup command from the lead at the project root, when setup
//      is permitted, goes to Claude Code's normal permission prompt;
//   2. with dependencies ready, the full policy hook decides;
//   3. before setup, or when the full hook cannot run, the session stays
//      read-only: project-local reads by the lead, and nothing else.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { logGuardEvent } from "../../src/guard-log.ts";
import {
  dependenciesReady, insideProject, projectReadAllowed, replanPermitted, SETUP_COMMAND, setupPermitted,
} from "../../src/setup-state.ts";
import { parseReplanCommand } from "../../src/init-command.ts";
import { claudeProjectRead } from "./project-read.ts";

const here = dirname(fileURLToPath(import.meta.url));
const harnessRoot = resolve(here, "../..");
const projectRoot = resolve(harnessRoot, "../..");

type Fields = Readonly<Record<string, unknown>>;

function deny(reason: string, kind: string): void {
  logGuardEvent(projectRoot, {
    guard: "team-lead", verdict: "block", summary: reason, detail: { host: "claude-code", kind },
  });
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason,
  } }) + "\n");
}

const sameDir = (a: string, b: string): boolean => {
  try { return realpathSync(a) === realpathSync(b); } catch { return false; }
};

/** The working directory this call acts in, when the session belongs to this project. */
function projectContext(cwd: unknown, exactRoot: boolean): string | undefined {
  const declared = process.env.CLAUDE_PROJECT_DIR;
  if (declared === undefined || !sameDir(declared, projectRoot)) return undefined;
  const current = typeof cwd === "string" ? cwd : cwd === undefined ? process.cwd() : undefined;
  if (current === undefined || !insideProject(projectRoot, current)) return undefined;
  if (exactRoot && !sameDir(current, projectRoot)) return undefined;
  return current;
}

let raw: string | undefined;
try { raw = readFileSync(0, "utf8"); } catch { raw = undefined; }

let payload: Fields | undefined;
try {
  const parsed: unknown = raw === undefined ? undefined : JSON.parse(raw);
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Fields;
} catch { payload = undefined; }

const tool = typeof payload?.["tool_name"] === "string" ? payload["tool_name"] as string : undefined;
const toolInput = payload?.["tool_input"];
const input: Fields = toolInput !== null && typeof toolInput === "object" && !Array.isArray(toolInput) ? toolInput as Fields : {};
const bound = process.argv.some((arg) => arg === "--role" || arg.startsWith("--role="));
const lead = payload !== undefined && !bound && payload["agent_id"] === undefined && payload["agent_type"] === undefined;

function bootstrapDecision(): void {
  if (raw === undefined || payload === undefined || tool === undefined) {
    deny("team-lead: the bootstrap hook could not read the tool call", "bootstrap-unreadable");
    return;
  }
  const read = claudeProjectRead(tool, input);
  const cwd = projectContext(payload["cwd"], false);
  if (read !== undefined && lead && cwd !== undefined) {
    if (projectReadAllowed(projectRoot, cwd, read)) return;
    deny("team-lead: before setup, reads must stay inside this project and outside .git", "bootstrap-read");
    return;
  }
  deny(`team-lead: dependencies are not ready; the lead may only read project files or run exactly \`${SETUP_COMMAND}\``,
    "bootstrap-setup-required");
}

/** The ticket worktree under this project that `cwd` lies in, if any: the
 *  nearest directory upward with a ticket marker, inside
 *  `.bounded/worktrees/` of this project (ADR LEG-2026-066). */
function ticketWorktreeOf(cwd: unknown): string | undefined {
  if (typeof cwd !== "string") return undefined;
  let dir: string;
  let base: string;
  try {
    dir = realpathSync(cwd);
    base = realpathSync(join(projectRoot, ".bounded", "worktrees"));
  } catch {
    return undefined;
  }
  while (dir.startsWith(`${base}/`)) {
    if (existsSync(join(dir, ".bounded", "ticket-worktree.json"))) return dir;
    dir = dirname(dir);
  }
  return undefined;
}

/**
 * A call made in a ticket worktree — by the architect subagent or one of its
 * workers — is judged by that worktree's own harness, with the worktree as the
 * project: its definitions, its policy, its guard log and `.bounded` state.
 * Its hook entry decides, and its answer (or exit) is passed back as is; a
 * worktree whose hook cannot run gets this entry's read-only refusal.
 */
function routeToTicketWorktree(): boolean {
  const worktree = ticketWorktreeOf(payload?.["cwd"]);
  if (worktree === undefined || raw === undefined) return false;
  const entry = join(worktree, ".bounded", "harness", "hosts", "claude-code", "bootstrap-hook.ts");
  const routed = existsSync(entry)
    ? spawnSync(process.execPath, [entry, ...process.argv.slice(2)], {
      input: raw, encoding: "utf8", cwd: worktree, env: { ...process.env, CLAUDE_PROJECT_DIR: worktree },
    })
    : undefined;
  const isPre = payload?.["hook_event_name"] === "PreToolUse";
  // An answer, or an explicit block (exit 2), passes back as is. A crash of
  // the worktree's hook never passes a call: it becomes a refusal.
  if (routed !== undefined && routed.error === undefined && (routed.status === 0 || routed.status === 2 || !isPre)) {
    if (routed.stdout) process.stdout.write(routed.stdout);
    if (routed.stderr) process.stderr.write(routed.stderr);
    process.exitCode = isPre ? (routed.status ?? 0) : 0;
    return true;
  }
  if (isPre && routed !== undefined) {
    const why = routed.error?.message ?? (routed.stderr?.trim() || `exit ${String(routed.status)}`);
    deny(`team-lead: the ticket worktree's hook failed (${why.slice(-300)}), so this call is refused`, "ticket-route-crashed");
    return true;
  }
  if (payload?.["hook_event_name"] === "PreToolUse") {
    deny(`team-lead: the ticket worktree ${worktree} has no hook that could judge this call`, "ticket-route-failed");
  }
  return true;
}

function main(): void {
  if (routeToTicketWorktree()) return;
  if (lead && tool === "Bash" && input["command"] === SETUP_COMMAND &&
      projectContext(payload?.["cwd"], true) !== undefined && setupPermitted(projectRoot)) {
    return; // Claude Code's own permission decision applies to this exact command.
  }
  // Re-planning the installation before the first ticket (ADR LEG-2026-065) runs
  // the user's own `bounded init`, which needs no project dependency.
  if (lead && tool === "Bash" && parseReplanCommand(input["command"], "claude-code")?.ok === true &&
      projectContext(payload?.["cwd"], true) !== undefined && replanPermitted(projectRoot)) {
    return;
  }
  if (raw !== undefined && dependenciesReady(projectRoot)) {
    const full = spawnSync(process.execPath, [join(here, "path-gate-hook.ts"), ...process.argv.slice(2)], {
      input: raw, encoding: "utf8", cwd: process.cwd(), env: process.env,
    });
    if (full.status === 0 && full.error === undefined) {
      if (full.stdout) process.stdout.write(full.stdout);
      if (full.stderr) process.stderr.write(full.stderr);
      return;
    }
    // An event that answers by its exit code (WorktreeCreate) refused.
    if (full.error === undefined && full.status !== null && payload?.["hook_event_name"] === "WorktreeCreate") {
      if (full.stderr) process.stderr.write(full.stderr);
      process.exitCode = full.status;
      return;
    }
    const why = full.error?.message ?? (full.stderr?.trim() || `exit ${String(full.status)}`);
    logGuardEvent(projectRoot, {
      guard: "team-lead", verdict: "error",
      summary: `team-lead: full policy hook failed (${why.slice(-600)}); read-only setup mode applies`,
      detail: { host: "claude-code", kind: "full-hook-failed" },
    });
  }
  // A commissioning role's hook also runs after its calls, only to record
  // what happened; there is nothing to refuse after a call.
  const event = payload?.["hook_event_name"];
  if (typeof event === "string" && event !== "PreToolUse") return;
  bootstrapDecision();
}

main();
