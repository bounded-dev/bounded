// Claude Code's half of a ticket's architect seat (src/architect-seat.ts,
// ADR 2026-066). The architect is the lead session's own background subagent,
// placed in the ticket worktree by Claude Code's worktree isolation:
//
//   · the lead calls the Agent tool with subagent_type "architect"; the lead
//     hook claims the one pending launch and rewrites the call so it carries
//     exactly the brief, the configured model, `isolation: "worktree"` and
//     `run_in_background: true` (lead-hook.ts);
//   · Claude Code then fires WorktreeCreate; the hook answers with the
//     pending ticket's existing worktree and binds the new agent id to it;
//   · every later hook call carries the subagent's `cwd` (the worktree) and
//     agent id; the project's hook routes it to that worktree's own harness,
//     guard log and policy (bootstrap-hook.ts, path-gate-hook.ts);
//   · SubagentStop records the architect's end; the lead continues it with
//     SendMessage, carrying exactly the pending reply.
//
// Fail closed: the generated definitions run in `dontAsk` permission mode, so
// a call that needs permission runs only when the gate explicitly allows it;
// a tool the gate does not judge is denied; and the preflight refuses a seat
// whose hooks are not registered or are switched off by a managed policy.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ArchitectHost, PendingLaunch, PendingReply } from "../../src/architect-seat.ts";
import { readTicketMarker } from "../../src/ticket-worktree.ts";
import { claudeTaskModel } from "./tool-map.ts";

/** Where Claude Code reads managed (policy) settings, which no project setting overrides. */
export const MANAGED_SETTINGS_PATHS: readonly string[] = [
  "/Library/Application Support/ClaudeCode/managed-settings.json",
  "/etc/claude-code/managed-settings.json",
];

/** The project hook entry, as the installer writes it (project-install.ts). */
const PROJECT_HOOK = "hosts/claude-code/bootstrap-hook.ts";
/** The hook events the seat depends on, each of which must run the project hook. */
export const SEAT_HOOK_EVENTS: readonly string[] = ["PreToolUse", "WorktreeCreate", "SubagentStop"];

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => typeof v === "object" && v !== null && !Array.isArray(v);

function readSettings(dir: string): Readonly<Record<string, unknown>> | string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
    return isRecord(parsed) ? parsed : `${dir}/.claude/settings.json is not an object`;
  } catch {
    return `${dir}/.claude/settings.json is missing or not JSON`;
  }
}

/** Whether `event` runs the project hook for every tool. */
function registered(settings: Readonly<Record<string, unknown>>, event: string): boolean {
  const hooks = settings["hooks"];
  const list = isRecord(hooks) ? hooks[event] : undefined;
  return Array.isArray(list) && list.some((entry) => isRecord(entry) && (entry["matcher"] ?? "") === "" &&
    Array.isArray(entry["hooks"]) && entry["hooks"].some((h) => isRecord(h) && typeof h["command"] === "string" &&
      h["command"].includes(PROJECT_HOOK) && h["command"].includes("--project-local")));
}

/** A generated role definition that binds its own hook and grants nothing itself. */
function definitionProblem(dir: string, role: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(join(dir, ".claude", "agents", `${role}.md`), "utf8");
  } catch {
    return `the ${role} definition is missing from ${dir}/.claude/agents`;
  }
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
  if (!/^permissionMode: dontAsk\s*$/m.test(front)) return `the ${role} definition does not run in dontAsk permission mode`;
  if (!new RegExp(`--role ${role}(?![\\w-])`).test(front)) return `the ${role} definition binds no hook to its role`;
  return undefined;
}

/** Why the seat's gate would not hold, if it would not. */
export function claudeGateProblem(worktree: string, managed: readonly string[] = MANAGED_SETTINGS_PATHS): string | undefined {
  for (const path of managed) {
    if (!existsSync(path)) continue;
    let policy: unknown;
    try { policy = JSON.parse(readFileSync(path, "utf8")); } catch { return `managed settings at ${path} cannot be read`; }
    if (isRecord(policy) && (policy["disableAllHooks"] === true || policy["allowManagedHooksOnly"] === true)) {
      return `managed settings at ${path} switch project hooks off`;
    }
  }
  const marker = readTicketMarker(worktree);
  if (marker === undefined) return "the worktree is not a marked ticket worktree";
  // The lead's project settings and definitions are the ones Claude Code loads
  // for its subagents; the worktree's harness is where their calls are routed.
  const settings = readSettings(marker.main);
  if (typeof settings === "string") return settings;
  if (settings["disableAllHooks"] === true) return "the project's settings switch hooks off";
  const missing = SEAT_HOOK_EVENTS.find((event) => !registered(settings, event));
  if (missing !== undefined) return `the project's settings do not run the project hook on ${missing}`;
  for (const role of ["architect", "reviewer", "test-writer", "builder"]) {
    const problem = definitionProblem(marker.main, role);
    if (problem !== undefined) return problem;
  }
  if (!existsSync(join(worktree, ".bounded", "harness", PROJECT_HOOK))) return `the hook ${PROJECT_HOOK} is missing from the worktree's harness`;
  return undefined;
}

export const CLAUDE_ARCHITECT_HOST: ArchitectHost = {
  name: "claude-code",
  model: claudeTaskModel,
  preflight: (worktree) => claudeGateProblem(worktree),
  launchInstruction: (launch: PendingLaunch) =>
    `Now launch its architect: call the Agent tool once with subagent_type "architect", isolation "worktree" and run_in_background true. ` +
    `The prompt can be short: the hook gives the architect ticket #${launch.issue}'s brief and binds it to the ticket's worktree. ` +
    "It runs in the background; you are told when it stops.",
  replyInstruction: (reply: PendingReply) =>
    `Now send it: call SendMessage with to "${reply.agent}" and the reply as the message; the hook carries exactly the reply you gave.`,
};
