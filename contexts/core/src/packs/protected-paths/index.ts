// The protected-paths pack (slice 3): an ordinary pack shipped in the `bounded` package.
// It depends only on the core's public exports; the core never imports it.
export type { ProtectedPathsPack, ProtectedPathsId, ProtectedPathsPackPoints, ProtectedPathsPackPorts } from "./protected-paths.contract.ts";
export { protectedPathsPack } from "./protected-paths.pack.ts";
export type { PathAccess, ProtectedPathFactory, ProtectedPathJSON } from "./domain/protected-path.contract.ts";
export { ProtectedPath } from "./domain/protected-path.ts";
export type { DriftReport, FileChange, Kept, RestoreFrom, ShellSnapshots, Snapshot, SnapshotFile, SnapshotJSON, WatchedFile, WatchedFiles, WatchedHashes, WatchShell } from "./application/watch-shell/watch-shell.contract.ts";
export { shellSnapshotsPort, watchedFilesPort } from "./application/watch-shell/watch-shell.contract.ts";
export type { WatchedChange, WatchedPathFactory, WatchedPathJSON } from "./domain/watched-path.contract.ts";
export { WatchedPath } from "./domain/watched-path.ts";
export type { SnapshotFactory } from "./domain/snapshot.contract.ts";

// Everything exported here is frozen, so code loaded later cannot patch it.
import * as exported from "./index.ts";
for (const value of Object.values(exported) as unknown[]) {
  Object.freeze(value);
  if (typeof value === "function" && value.prototype !== undefined) Object.freeze(value.prototype);
}
