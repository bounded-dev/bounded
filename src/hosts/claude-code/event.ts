// The step that resolves a translated call's paths, reads its shell commands
// and builds the core's host-neutral tool-use event from it, through the
// core's own parse. The adapter is trusted code: it builds each execute
// effect's reading from the model's tool input with bounded's reader, and the
// core checks the reading's shape (ADR 2026-020).
import { type EffectJSON, ProjectPath, type Refuse, type Result, Role, ToolUse, Verdict } from "bounded/domain";
import type { ReadShellCommand } from "bounded-shell-command-reader/shell-command-reading";
import type { HostCall } from "./translate.ts";

export type { ToolUse } from "bounded/domain";

/** The port to the file system: a host path, relative to `cwd` unless absolute, as a project-relative one. */
export interface PathResolver {
  resolve(raw: string, cwd: string): Result<{ readonly path: string; readonly exists: boolean }, Refuse>;
}

export interface Resolving {
  /** The role label from the hook's command line, or null for none. */
  readonly role: string | null;
  /** The directory relative host paths are resolved against. */
  readonly cwd: string;
  readonly paths: PathResolver;
  /** The project's root, an absolute path: each shell command is read in it. */
  readonly projectRoot: string;
  /** Reads each shell command into the reading its execute effect carries; it never rejects. */
  readonly readShellCommand: ReadShellCommand;
  /** The host's id for the call, when it gives one. */
  readonly callId?: string;
}

type Resolved = Result<{ path: string; exists: boolean }, Refuse>;

/**
 * The translated call as the core's event, every path resolved and checked
 * and every shell command read; any refused path refuses the call. A command
 * that cannot be read still reaches the core, with an unread reading saying
 * why, which a pack that needs it refuses.
 */
export async function toToolUse(call: HostCall, { role, cwd, paths, projectRoot, readShellCommand, callId }: Resolving): Promise<Result<ToolUse, Refuse>> {
  let checkedRole: Role | null = null;
  if (role !== null) {
    const parsed = Role.parse(role);
    if (!parsed.ok) return { ok: false, error: Verdict.refuse(parsed.error, "Start the hook with --role naming a role label") };
    checkedRole = parsed.value;
  }
  if (call.effects.length === 0) return { ok: false, error: Verdict.refuse("A tool use must have at least one effect", "Report this to the maintainers of bounded") };

  const resolve = (raw: string): Resolved => {
    const found = paths.resolve(raw, cwd);
    if (!found.ok) return found;
    const path = ProjectPath.parse(found.value.path);
    if (!path.ok) return { ok: false, error: Verdict.refuse(path.error, "Use a path inside the project; a link must land inside it too") };
    return { ok: true, value: { path: path.value.value, exists: found.value.exists } };
  };

  const effects: EffectJSON[] = [];
  for (const effect of call.effects) {
    if (effect.kind === "read" || effect.kind === "write" || effect.kind === "list") {
      const found = resolve(effect.kind === "list" ? effect.root : effect.path);
      if (!found.ok) return found;
      const { path, exists } = found.value;
      if (effect.kind === "read") effects.push({ kind: "read", path });
      else if (effect.kind === "list") effects.push({ kind: "list", root: path, filter: effect.filter ?? null });
      else effects.push({ kind: "write", path, change: effect.change === "create-or-modify" ? (exists ? "modify" : "create") : effect.change });
    } else if (effect.kind === "execute") {
      const found = effect.cwd === undefined ? null : resolve(effect.cwd);
      if (found !== null && !found.ok) return found;
      const directory = found === null ? null : found.value.path;
      const reading = await readShellCommand.read({ projectRoot, command: effect.command, cwd: directory });
      effects.push({ kind: "execute", command: effect.command, cwd: directory, reading });
    } else effects.push({ ...effect });
  }
  // The core checks and freezes the event; a refusal here is the adapter's mistake.
  const event = ToolUse.parse({ kind: "tool-use", role: checkedRole, tool: call.tool, effects, ...(callId === undefined ? {} : { callId }) });
  return event.ok ? event : { ok: false, error: Verdict.refuse(event.error, "Report this to the maintainers of bounded") };
}
