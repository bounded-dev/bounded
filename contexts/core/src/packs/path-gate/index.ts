// The path gate (slice 3): an ordinary pack shipped in the `bounded` package.
// It depends only on the core's public exports; the core never imports it.
export { pathGate } from "./path-gate.ts";
export type { PathAccess, ProtectedPathFactory, ProtectedPathJSON } from "./protected-path.contract.ts";
export { ProtectedPath } from "./protected-path.ts";

// Everything exported here is frozen, so code loaded later cannot patch it.
import * as exported from "./index.ts";
for (const value of Object.values(exported) as unknown[]) {
  Object.freeze(value);
  if (typeof value === "function" && value.prototype !== undefined) Object.freeze(value.prototype);
}
