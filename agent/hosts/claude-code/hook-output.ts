// The PreToolUse wire format this host's hooks answer in, and the payload
// fields they read. Shared by the role gate (path-gate-hook.ts) and the
// read-only seats (lead-hook.ts).

/** The payload fields the hooks read, narrowed from untrusted JSON. */
export interface HookPayload {
  readonly event?: string;
  readonly toolName: string;
  readonly toolInput: Readonly<Record<string, unknown>>;
  readonly cwd?: string;
  /** The calling subagent's identity, when the payload carries one. */
  readonly agentType?: string;
  readonly agentId?: string;
  /** The seat instance making the call (agent id, else session), as recorded on a spawn. */
  readonly caller?: string;
}

/** Refuse the call and tell the model why. */
export function deny(reason: string): string {
  return (
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }) + "\n"
  );
}

/** Allow, with the tool input rewritten. Other fields of the original input
 *  (`description`, `timeout`) are kept: `updatedInput` REPLACES the input. */
export function allowWith(updatedInput: Readonly<Record<string, unknown>>): string {
  return (
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput,
      },
    }) + "\n"
  );
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
