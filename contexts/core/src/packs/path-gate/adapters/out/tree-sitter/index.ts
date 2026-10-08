// bounded/path-gate/adapters/tree-sitter: the path gate's shell parser, for hosts' composition roots.
export { pathGateTreeSitter } from "./provisions.ts";
export { TreeSitterShellParser } from "./shell-parser.ts";

// Everything exported here is frozen, a function's or class's prototype too,
// so code loaded later (a project's configuration, a pack) cannot patch it.
import * as exported from "./index.ts";
for (const value of Object.values(exported)) {
  Object.freeze(value);
  if (typeof value === "function" && value.prototype !== undefined) Object.freeze(value.prototype);
}
