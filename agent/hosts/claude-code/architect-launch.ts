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
// loaded, so exactly one hook judges each of the architect's own calls.
//
// Fail closed (ADR 2026-066):
//   · Only the project's settings load (`--setting-sources project`), so a
//     user or local setting cannot switch the hook off; a managed policy that
//     disables hooks is detected and refused, since nothing can override it.
//   · The session runs in `dontAsk` mode with nothing pre-approved, so every
//     call that needs permission is refused unless the hook explicitly allows
//     it. A session whose hook never ran therefore cannot write, edit, or run
//     anything Claude Code does not itself count as a read.
//   · The preflight refuses a launch whose worktree does not register the hook.
//   · The message follows `--`, so it is never read as an option.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ArchitectHost, ArchitectTurnSpec, HostCommand } from "../../src/architect-launch.ts";
import { claudeTaskModel } from "./tool-map.ts";

/** The environment variable that carries a launched session's seat to the hook. */
export const LAUNCHED_SEAT_ENV = "BOUNDED_LAUNCHED_SEAT";

/** Where Claude Code reads managed (policy) settings, which no launch flag overrides. */
export const MANAGED_SETTINGS_PATHS: readonly string[] = [
  "/Library/Application Support/ClaudeCode/managed-settings.json",
  "/etc/claude-code/managed-settings.json",
];

/** The only MCP configuration a launched session loads: none. */
export const EMPTY_MCP_CONFIG = '{"mcpServers":{}}';

/** The project hook entry, as the installer writes it (project-install.ts). */
const PROJECT_HOOK = "hosts/claude-code/bootstrap-hook.ts";

/** The generated architect definition's tool list and brief. */
export function architectDefinition(worktree: string): { readonly tools: readonly string[]; readonly brief: string } {
  const text = readFileSync(join(worktree, ".claude", "agents", "architect.md"), "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (match === null) throw new Error("the generated architect definition has no front matter");
  const tools = /^tools:\s*(.+)$/m.exec(match[1]!)?.[1]?.split(",").map((t) => t.trim()).filter((t) => t !== "");
  if (tools === undefined || tools.length === 0) throw new Error("the generated architect definition names no tools");
  return { tools, brief: match[2]!.trim() };
}

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Why the worktree's gate would not hold for a launched session, if it would not. */
export function claudeGateProblem(worktree: string, managed: readonly string[] = MANAGED_SETTINGS_PATHS): string | undefined {
  for (const path of managed) {
    if (!existsSync(path)) continue;
    let policy: unknown;
    try { policy = JSON.parse(readFileSync(path, "utf8")); } catch { return `managed settings at ${path} cannot be read`; }
    if (isRecord(policy) && (policy["disableAllHooks"] === true || policy["allowManagedHooksOnly"] === true)) {
      return `managed settings at ${path} switch project hooks off`;
    }
  }
  let settings: unknown;
  try {
    settings = JSON.parse(readFileSync(join(worktree, ".claude", "settings.json"), "utf8"));
  } catch {
    return "the worktree's .claude/settings.json is missing or not JSON";
  }
  if (!isRecord(settings)) return "the worktree's .claude/settings.json is not an object";
  if (settings["disableAllHooks"] === true) return "the worktree's settings switch hooks off";
  const hooks = settings["hooks"];
  const pre = isRecord(hooks) ? hooks["PreToolUse"] : undefined;
  const registered = Array.isArray(pre) && pre.some((entry) => isRecord(entry) && (entry["matcher"] ?? "") === "" &&
    Array.isArray(entry["hooks"]) && entry["hooks"].some((h) => isRecord(h) && typeof h["command"] === "string" &&
      h["command"].includes(PROJECT_HOOK) && h["command"].includes("--project-local")));
  if (!registered) return "the worktree's settings register no project-wide PreToolUse hook for every tool";
  if (!existsSync(join(worktree, ".bounded", "harness", PROJECT_HOOK))) return `the hook ${PROJECT_HOOK} is missing from the worktree's harness`;
  try {
    architectDefinition(worktree);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}

export const CLAUDE_ARCHITECT_HOST: ArchitectHost = {
  name: "claude-code",
  model: claudeTaskModel,
  preflight: (worktree) => claudeGateProblem(worktree),
  command(spec: ArchitectTurnSpec): HostCommand {
    const { tools, brief } = architectDefinition(spec.worktree);
    return {
      command: "claude",
      args: [
        "-p",
        ...(spec.resume ? ["--resume", spec.sessionId] : ["--session-id", spec.sessionId]),
        "--setting-sources", "project",
        "--permission-mode", "dontAsk",
        "--append-system-prompt", brief,
        "--tools", tools.join(","),
        ...(spec.model !== undefined ? ["--model", spec.model] : []),
        // No MCP server or connector loads: only this empty configuration
        // counts. (A variadic flag; the next flag ends its list.)
        "--strict-mcp-config", "--mcp-config", EMPTY_MCP_CONFIG,
        "--output-format", "text",
        "--", spec.message,
      ],
      env: { [LAUNCHED_SEAT_ENV]: "architect" },
      // The lead's own session variables would point the new session's hooks
      // back at the main worktree.
      unset: ["CLAUDE_PROJECT_DIR", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"],
    };
  },
};
