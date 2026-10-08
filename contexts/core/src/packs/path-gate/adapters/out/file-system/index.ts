// bounded/path-gate/adapters/file-system: the path gate's adapters on disk, for hosts' composition roots.
export { FileSystemPathKinds } from "./path-kinds.ts";
export { pathGateFileSystem } from "./provisions.ts";
export { FileSystemShellSnapshots } from "./snapshots.ts";
export { stateDirFor, stateHomeFor } from "./state-home.ts";
export { FileSystemWatchedFiles } from "./watched-files.ts";

// Everything exported here is frozen, a function's or class's prototype too,
// so code loaded later (a project's configuration, a pack) cannot patch it.
import * as exported from "./index.ts";
for (const value of Object.values(exported)) {
  Object.freeze(value);
  if (typeof value === "function" && value.prototype !== undefined) Object.freeze(value.prototype);
}
