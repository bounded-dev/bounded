// The refused-tools pack: the pack of bounded-example, a published pack's
// package (ADR 2026-030). It depends only on bounded/domain; nothing in
// bounded imports it.
export type { RefusedToolsId, RefusedToolsPack, RefusedToolsPackPoints } from "./refused-tools.contract.ts";
export { refusedToolsPack } from "./refused-tools.pack.ts";
export type { RefusedToolFactory, RefusedToolJSON } from "./domain/refused-tool.contract.ts";
export { RefusedTool } from "./domain/refused-tool.ts";

// Everything exported here is frozen, so code loaded later cannot patch it.
import * as exported from "./index.ts";
for (const value of Object.values(exported) as unknown[]) {
  Object.freeze(value);
  if (typeof value === "function" && value.prototype !== undefined) Object.freeze(value.prototype);
}
