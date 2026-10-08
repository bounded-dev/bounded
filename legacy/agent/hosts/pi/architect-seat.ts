// pi's half of a ticket's architect seat (src/architect-seat.ts, ADR
// LEG-2026-066). The architect is the lead's own pi-subagents child, started
// asynchronously with the ticket worktree as its `cwd`:
//
//   · pi-subagents discovers the agent definition from that `cwd`, so the
//     worktree's `.pi/agents/architect.md` and its per-role loader bind the
//     seat, and the child is a pi process whose project extensions are the
//     worktree's own;
//   · the lead's gate claims the one pending launch and makes the call carry
//     exactly the brief, the worktree and `async: true` (path-gate.ts);
//   · the architect's loader records the seat's start and end in the worktree
//     (session_start, session_shutdown) and releases the pending launch;
//   · the lead continues it with `subagent` action "resume", carrying exactly
//     the pending reply. The user can also open and steer it in pi-subagents'
//     fleet view.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ArchitectHost, PendingLaunch, PendingReply } from "../../src/architect-seat.ts";

/** The architect's per-role loader inside a project's harness copy. */
export const ARCHITECT_LOADER_RELATIVE = ".bounded/harness/hosts/pi/extensions/path-gate/architect.ts";

/** Why the worktree's gate would not load for its architect child, if it would not. */
export function piGateProblem(worktree: string): string | undefined {
  if (!existsSync(join(worktree, ARCHITECT_LOADER_RELATIVE))) return `the architect's loader ${ARCHITECT_LOADER_RELATIVE} is missing`;
  if (!existsSync(join(worktree, ".pi", "extensions", "bounded", "index.ts"))) return "the worktree's project extension .pi/extensions/bounded/index.ts is missing";
  const definition = join(worktree, ".pi", "agents", "architect.md");
  let text: string;
  try {
    text = readFileSync(definition, "utf8");
  } catch {
    return "the worktree's architect definition .pi/agents/architect.md is missing";
  }
  // pi-subagents resolves a relative loader path from the definition's own directory.
  const loader = /^subagentOnlyExtensions:\s*(\S+)\s*$/m.exec(text)?.[1];
  if (loader === undefined) return "the architect definition loads no per-role loader";
  const resolved = loader.startsWith(".") ? resolve(dirname(definition), loader) : loader;
  if (resolved !== join(worktree, ARCHITECT_LOADER_RELATIVE)) return `the architect definition's loader ${loader} is not the worktree's own architect loader`;
  return undefined;
}

export const PI_ARCHITECT_HOST: ArchitectHost = {
  name: "pi",
  model: (pattern) => pattern,
  preflight: piGateProblem,
  launchInstruction: (launch: PendingLaunch) =>
    `Now launch its architect: call the subagent tool with agent "architect", async true and cwd "${launch.worktree}". ` +
    `The task can be short: the gate gives the architect ticket #${launch.issue}'s brief. It runs in the background; check it with subagent_wait or the fleet view.`,
  replyInstruction: (reply: PendingReply) =>
    `Now send it: call the subagent tool with action "resume", id "${reply.agent}" and the reply as the message; the gate carries exactly the reply you gave.`,
};
