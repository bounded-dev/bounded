// The ts-desktop pack (ADR 2026-063): the desktop app template. A stub;
// WI-7 fills it and adds its remaining pack edges. It contributes nothing yet.
// Its data half is contrib.json beside this file.
import { definePack } from "../../src/socket-registry.ts";
import { TS_PACK } from "../ts/pack.ts";
import { TS_HEXAGONAL_PACK } from "../ts-hexagonal/pack.ts";

export const TS_DESKTOP_PACK = "ts-desktop";

export const tsDesktopPack = definePack({
  name: TS_DESKTOP_PACK,
  dependsOnPacks: [TS_PACK, TS_HEXAGONAL_PACK],
  contributes: [],
});
