// bounded/path-gate/adapters/in-memory: the path gate's adapters in memory, for tests and single-process hosts.
export { InMemoryPathKinds } from "./path-kinds.ts";
export { pathGateInMemory } from "./provisions.ts";
export { InMemoryShellSnapshots } from "./snapshots.ts";
export { InMemoryWatchedFiles } from "./watched-files.ts";

// Everything exported here is frozen, a function's or class's prototype too,
// so code loaded later (a project's configuration, a pack) cannot patch it.
import * as exported from "./index.ts";
for (const value of Object.values(exported)) {
  Object.freeze(value);
  if (typeof value === "function" && value.prototype !== undefined) Object.freeze(value.prototype);
}
