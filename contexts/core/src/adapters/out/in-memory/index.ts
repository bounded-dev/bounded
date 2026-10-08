export { InMemoryComposePacksCatalog } from "./composition/compose-packs.catalog.ts";
export { InMemoryGuardLog } from "./guard-log/guard-log.ts";

// Everything exported here is frozen, a function's or class's prototype too,
// so code loaded later (a project's configuration, a pack) cannot patch it.
import * as exported from "./index.ts";
for (const value of Object.values(exported)) {
  Object.freeze(value);
  if (typeof value === "function" && value.prototype !== undefined) Object.freeze(value.prototype);
}
