// The ts-desktop pack (ADR LEG-2026-063): the Electron desktop app, hosting one
// context's tRPC router in-process and rendering with React. It depends on
// ts-trpc for the router it hosts (and the router-hosting helpers it shares
// with the web app). It does not depend on ts-web: a desktop app is not a web
// app and must not inherit the web app's delivery obligations.
//
// Its data half is contrib.json beside this file: the `desktop` workspace
// template and its exact pins.
import { contribute, definePack } from "../../src/socket-registry.ts";
import { skeletonEmitters, TS_PACK } from "../ts/pack.ts";
import { TS_HEXAGONAL_PACK } from "../ts-hexagonal/pack.ts";
import { TS_TRPC_PACK } from "../ts-trpc/pack.ts";
import { desktopAppEmitter } from "./scripts/desktop-app-emitter.ts";

export const TS_DESKTOP_PACK = "ts-desktop";

export const tsDesktopPack = definePack({
  name: TS_DESKTOP_PACK,
  dependsOnPacks: [TS_PACK, TS_HEXAGONAL_PACK, TS_TRPC_PACK],
  contributes: [contribute(skeletonEmitters, [desktopAppEmitter])],
});
