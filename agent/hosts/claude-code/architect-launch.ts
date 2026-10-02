// Claude Code's half of a ticket architect's launch (src/architect-launch.ts,
// ADR 2026-066): the command line for one turn, run in the ticket worktree.
//
// The architect runs as that worktree's own top-level Claude Code session, so
// the worktree's settings hook judges every call it makes and its
// CLAUDE_PROJECT_DIR, guard log and `.bounded/` state are the worktree's. The
// seat reaches that hook through the session's environment
// (LAUNCHED_SEAT_ENV): the model cannot change the environment of the process
// that runs it, and the hook accepts the seat only inside a worktree the start
// command marked (path-gate-hook.ts). No agent definition with its own hook is
// loaded, so exactly one hook judges each call.
//
// The tool strip is the generated architect definition's `tools:` list, passed
// as `--tools`; its body is the brief. Permission prompts cannot be answered in
// a headless turn, so file edits are accepted and the strip's own tools are
// allowed: the hook, which runs before any permission rule, is the gate.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ArchitectHost, ArchitectTurnSpec, HostCommand } from "../../src/architect-launch.ts";
import { claudeTaskModel } from "./tool-map.ts";

/** The environment variable that carries a launched session's seat to the hook. */
export const LAUNCHED_SEAT_ENV = "BOUNDED_LAUNCHED_SEAT";

/** The generated architect definition's tool list and brief. */
export function architectDefinition(worktree: string): { readonly tools: readonly string[]; readonly brief: string } {
  const text = readFileSync(join(worktree, ".claude", "agents", "architect.md"), "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (match === null) throw new Error("the generated architect definition has no front matter");
  const tools = /^tools:\s*(.+)$/m.exec(match[1]!)?.[1]?.split(",").map((t) => t.trim()).filter((t) => t !== "");
  if (tools === undefined || tools.length === 0) throw new Error("the generated architect definition names no tools");
  return { tools, brief: match[2]!.trim() };
}

export const CLAUDE_ARCHITECT_HOST: ArchitectHost = {
  name: "claude-code",
  model: claudeTaskModel,
  command(spec: ArchitectTurnSpec): HostCommand {
    const { tools, brief } = architectDefinition(spec.worktree);
    return {
      command: "claude",
      args: [
        "-p",
        ...(spec.resume ? ["--resume", spec.sessionId] : ["--session-id", spec.sessionId]),
        "--append-system-prompt", brief,
        "--tools", tools.join(","),
        "--permission-mode", "acceptEdits",
        ...(spec.model !== undefined ? ["--model", spec.model] : []),
        // A variadic flag: the next flag ends its list, so the prompt stays the prompt.
        "--allowedTools", ...tools,
        "--output-format", "text",
        spec.message,
      ],
      env: { [LAUNCHED_SEAT_ENV]: "architect" },
      // The lead's own session variables would point the new session's hooks
      // back at the main worktree.
      unset: ["CLAUDE_PROJECT_DIR", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"],
    };
  },
};
