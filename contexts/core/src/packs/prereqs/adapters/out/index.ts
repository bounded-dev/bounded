// bounded/prereqs/adapters: the prerequisites pack's out adapters, one folder per port (ADR 2026-017), for hosts' composition roots.
export { FileSystemFileSetFingerprints } from "./file-set-fingerprints/file-set-fingerprints.ts";
export { prereqsPortProvisions } from "./port-provisions.ts";
export { FileSystemPrerequisiteRecords } from "./prerequisite-records/prerequisite-records.ts";

// Everything exported here is frozen, a function's or class's prototype too,
// so code loaded later (a project's configuration, a pack) cannot patch it.
import * as exported from "./index.ts";
for (const value of Object.values(exported)) {
  Object.freeze(value);
  if (typeof value === "function" && value.prototype !== undefined) Object.freeze(value.prototype);
}
