import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";

/** The user's state directory: $XDG_STATE_HOME when it is absolute, else ~/.local/state. */
export function stateHomeFor(env: Readonly<Record<string, string | undefined>>, home: string): string {
  const given = env.XDG_STATE_HOME;
  return given !== undefined && isAbsolute(given) ? given : join(home, ".local", "state");
}

/** Where bounded keeps a project's state for this user: `<stateHome>/bounded/<sha256 of the root>`. */
export const stateDirFor = (stateHome: string, root: string): string => join(stateHome, "bounded", createHash("sha256").update(root).digest("hex"));
