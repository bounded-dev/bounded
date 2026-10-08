// The ts-mcp pack (ADR LEG-2026-063): MCP tools as an in adapter, and the MCP app.
//
//   * the `mcp-in-adapter` emitter: every context's adapters/in/mcp/**,
//     generated from the features tagged `@exposedVia mcp`, with its laws;
//   * the `mcp-app` emitter: the seed files of each app a TN declares as
//     kind `mcp`.
//
// Its data half is contrib.json beside this file: the `mcp` adapter
// technology and its pin, the generated globs and the `mcp` workspace template.
import { contribute, definePack } from "../../src/socket-registry.ts";
import { skeletonEmitters, TS_PACK } from "../ts/pack.ts";
import { TS_HEXAGONAL_PACK } from "../ts-hexagonal/pack.ts";
import { mcpAppEmitter } from "./scripts/mcp-app-emitter.ts";
import { mcpAdapterEmitter } from "./scripts/mcp-emitter.ts";

export const TS_MCP_PACK = "ts-mcp";

export const tsMcpPack = definePack({
  name: TS_MCP_PACK,
  dependsOnPacks: [TS_PACK, TS_HEXAGONAL_PACK],
  contributes: [contribute(skeletonEmitters, [mcpAdapterEmitter, mcpAppEmitter])],
});
