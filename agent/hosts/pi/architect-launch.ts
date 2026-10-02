// pi's half of a ticket architect's launch (src/architect-launch.ts, ADR
// 2026-066): the command line for one turn, run in the ticket worktree.
//
// The architect runs as the worktree's own top-level pi session. The project's
// extensions load from the worktree (`--approve` trusts them for this run: the
// start command made the worktree from the lead's own trusted checkout), and
// the architect's per-role loader is passed explicitly, exactly as
// pi-subagents passes it to a commissioned child, so the role is bound from
// outside the session and the ambient copy stands down (path-gate.ts). The
// generated architect definition supplies the tool allowlist and the brief.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ARCHITECT_DIR_RELATIVE, type ArchitectHost, type ArchitectTurnSpec, type HostCommand } from "../../src/architect-launch.ts";

/** The architect's per-role loader inside a project's harness copy. */
export const ARCHITECT_LOADER_RELATIVE = ".bounded/harness/hosts/pi/extensions/path-gate/architect.ts";

export function piArchitectDefinition(worktree: string): { readonly tools: readonly string[]; readonly brief: string } {
  const text = readFileSync(join(worktree, ".pi", "agents", "architect.md"), "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (match === null) throw new Error("the architect definition has no front matter");
  const tools = /^tools:\s*(.+)$/m.exec(match[1]!)?.[1]?.split(",").map((t) => t.trim()).filter((t) => t !== "");
  if (tools === undefined || tools.length === 0) throw new Error("the architect definition names no tools");
  return { tools, brief: match[2]!.trim() };
}

/** Why the worktree's gate would not load for a launched pi session, if it would not. */
export function piGateProblem(worktree: string): string | undefined {
  if (!existsSync(join(worktree, ARCHITECT_LOADER_RELATIVE))) return `the architect's loader ${ARCHITECT_LOADER_RELATIVE} is missing`;
  if (!existsSync(join(worktree, ".pi", "extensions", "bounded", "index.ts"))) return "the worktree's project extension .pi/extensions/bounded/index.ts is missing";
  try {
    piArchitectDefinition(worktree);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}

export const PI_ARCHITECT_HOST: ArchitectHost = {
  name: "pi",
  model: (pattern) => pattern,
  preflight: piGateProblem,
  command(spec: ArchitectTurnSpec): HostCommand {
    const { tools, brief } = piArchitectDefinition(spec.worktree);
    const briefFile = join(spec.worktree, ARCHITECT_DIR_RELATIVE, "brief.md");
    mkdirSync(join(spec.worktree, ARCHITECT_DIR_RELATIVE), { recursive: true });
    writeFileSync(briefFile, brief + "\n");
    return {
      command: "pi",
      args: [
        "-p", "--approve",
        "--session-id", spec.sessionId,
        "--extension", join(spec.worktree, ARCHITECT_LOADER_RELATIVE),
        "--tools", tools.join(","),
        "--append-system-prompt", briefFile,
        ...(spec.model !== undefined ? ["--model", spec.model] : []),
        "--", spec.message,
      ],
      env: {},
      // A launched architect is a top-level session, never a commissioned child.
      unset: ["PI_SUBAGENT_CHILD", "PI_SUBAGENT_CHILD_AGENT", "PI_SUBAGENT_RUN_ID"],
    };
  },
};
