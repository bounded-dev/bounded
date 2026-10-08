export { FileSystemGuardLog } from "./guard-log/guard-log.ts";
export { FileSystemProjectConfigSource } from "./project-config/config-source.ts";
export { FileSystemProjectGuardLogs } from "./guard-log/project-guard-logs.ts";
export { FileSystemProjectSetupFiles } from "./project-setup/project-setup-files.ts";

// Everything exported here is frozen, a function's or class's prototype too,
// so code loaded later (a project's configuration, a pack) cannot patch it.
import * as exported from "./index.ts";
for (const value of Object.values(exported)) {
  Object.freeze(value);
  if (typeof value === "function" && value.prototype !== undefined) Object.freeze(value.prototype);
}
