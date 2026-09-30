// The ts-hexagonal pack (ADR 2026-063): the hexagonal monorepo layout of
// TN-26-012. A stub; WI-5 fills it. It contributes nothing yet.
// Its data half is contrib.json beside this file.
import { definePack } from "../../src/socket-registry.ts";
import { TS_PACK } from "../ts/pack.ts";

export const TS_HEXAGONAL_PACK = "ts-hexagonal";

export const tsHexagonalPack = definePack({
  name: TS_HEXAGONAL_PACK,
  dependsOnPacks: [TS_PACK],
  contributes: [],
});
