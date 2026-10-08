export { SystemClock } from "./guard-log/clock.ts";
export { RandomDecisionIds } from "./guard-log/ids.ts";
export { CheckedProjectConfigSource } from "./project-config/checked-config-source.ts";
export { NodeModulesHostInstallerSource } from "./project-setup/host-installer-source.ts";

// Everything exported here is frozen, a function's or class's prototype too,
// so code loaded later (a project's configuration, a pack) cannot patch it.
import * as exported from "./index.ts";
for (const value of Object.values(exported)) {
  Object.freeze(value);
  if (typeof value === "function" && value.prototype !== undefined) Object.freeze(value.prototype);
}
