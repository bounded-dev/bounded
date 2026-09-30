// The ts-mcp pack (ADR 2026-063): MCP tools as in adapters. A stub; WI-7
// fills it. It contributes nothing yet.
// Its data half is contrib.json beside this file.
import { definePack } from "../../src/socket-registry.ts";
import { TS_PACK } from "../ts/pack.ts";
import { TS_HEXAGONAL_PACK } from "../ts-hexagonal/pack.ts";

export const TS_MCP_PACK = "ts-mcp";

export const tsMcpPack = definePack({
  name: TS_MCP_PACK,
  dependsOnPacks: [TS_PACK, TS_HEXAGONAL_PACK],
  contributes: [],
});
