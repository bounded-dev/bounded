// bounded/path-gate/adapters: the path gate's out adapters, one folder per port (ADR 2026-017), for hosts' composition roots.
export { pathGatePortProvisions } from "./port-provisions.ts";
export { FileSystemShellSnapshots } from "./shell-snapshots/shell-snapshots.ts";
export { stateDirFor, stateHomeFor } from "./state-directory.ts";
export { FileSystemWatchedFiles } from "./watched-files/watched-files.ts";

// Everything exported here is frozen, a function's or class's prototype too,
// so code loaded later (a project's configuration, a pack) cannot patch it.
import * as exported from "./index.ts";
for (const value of Object.values(exported)) {
  Object.freeze(value);
  if (typeof value === "function" && value.prototype !== undefined) Object.freeze(value.prototype);
}
