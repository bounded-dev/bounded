// Symlink-safe "am I the entry point" (ADR 2026-029 gave the harness three
// more CLI entry points and each copied the same eight lines).
//
// The harness is invoked through the `~/.pi/agent` symlink, so `process.argv[1]`
// and `import.meta.url` can name the same file by different paths; comparing
// realpaths is the only comparison that holds. Anything unreadable is "not
// the entry point": a module imported by a test must never run its main.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** True when the module at `moduleUrl` (pass `import.meta.url`) is the process entry point. */
export function isMainModule(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
