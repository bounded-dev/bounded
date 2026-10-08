// bounded/adapters: the core's out adapters, one folder per port (ADR 2026-017), for hosts' composition roots.
export { SystemClock } from "./clock/clock.ts";
export { InMemoryComposePacksCatalog } from "./compose-packs-catalog/compose-packs-catalog.ts";
export { RandomDecisionIds } from "./decision-ids/decision-ids.ts";
export { FileSystemGuardLog } from "./guard-log/guard-log.ts";
export { NodeModulesHostInstallerSource } from "./host-installer-source/host-installer-source.ts";
export { CheckedProjectConfigSource } from "./project-config-source/checked-project-config-source.ts";
export { FileSystemProjectConfigSource } from "./project-config-source/file-system-project-config-source.ts";
export { FileSystemProjectGuardLogs } from "./project-guard-logs/project-guard-logs.ts";
export { FileSystemProjectSetupFiles } from "./project-setup-files/project-setup-files.ts";

// Everything exported here is frozen, a function's or class's prototype too,
// so code loaded later (a project's configuration, a pack) cannot patch it.
import * as exported from "./index.ts";
for (const value of Object.values(exported)) {
  Object.freeze(value);
  if (typeof value === "function" && value.prototype !== undefined) Object.freeze(value.prototype);
}
