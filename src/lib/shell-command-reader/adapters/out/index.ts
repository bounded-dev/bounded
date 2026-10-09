// bounded-shell-command-reader/adapters: bounded's shell command reader, for
// hosts' composition roots (ADR 2026-020). bounded publishes it, built into
// its dist, as bounded/shell-command-reader.
export type { PathKind } from "../../domain/shell-command.contract.ts";
export { TreeSitterShellCommandReader } from "./shell-command-reader/shell-command-reader.ts";
export type { TreeSitterShellCommandReaderOptions } from "./shell-command-reader/shell-command-reader.ts";

// Everything exported here is frozen, a function's or class's prototype too,
// so code loaded later (a project's configuration, a pack) cannot patch it.
import * as exported from "./index.ts";
for (const value of Object.values(exported)) {
  Object.freeze(value);
  if (typeof value === "function" && value.prototype !== undefined) Object.freeze(value.prototype);
}
