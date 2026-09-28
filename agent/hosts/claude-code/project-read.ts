// Claude Code's local read tools in the host-neutral shape the pre-setup read
// check judges (src/setup-state.ts). Dependency-free: the bootstrap entry loads
// it before setup, and the full hook falls back on it when it errors.

import type { ProjectRead } from "../../src/setup-state.ts";

type Fields = Readonly<Record<string, unknown>>;

/** Grep and Glob search the session directory when no path is given, as the
 *  full policy's tool map reads them. Any other tool is undefined. */
export function claudeProjectRead(tool: string | undefined, input: Fields): ProjectRead | undefined {
  switch (tool) {
    case "Read": return { path: input["file_path"], pathRequired: true, search: false, globs: [] };
    case "LS": return { path: input["path"], pathRequired: true, search: true, globs: [] };
    case "Grep": return { path: input["path"], pathRequired: false, search: true, globs: [input["glob"]] };
    case "Glob": return { path: input["path"], pathRequired: false, search: true, globs: [input["pattern"] ?? null] };
    default: return undefined;
  }
}
