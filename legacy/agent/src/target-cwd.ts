// Target cwd — where a gate runs (ADR 2026-029).
//
// Every gate takes an optional project directory, absolute or relative to
// wherever the caller is: a pi tool resolves it against the session cwd, the
// CLI against the shell's. The rule is three lines and was copied into both
// extensions; a third host would have made a third copy, and a copy is where
// "relative to what?" silently changes. One function, imported by every host.
//
// Pure: no fs access, no existence check — a missing directory is the gate's
// own ERROR to report, with its own wording.

import { isAbsolute, resolve } from "node:path";

/** Resolve the caller's optional target directory against its own cwd. */
export function targetCwd(sessionCwd: string, param?: string): string {
  if (!param) return sessionCwd;
  return isAbsolute(param) ? param : resolve(sessionCwd, param);
}
