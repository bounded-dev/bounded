// The ts-web pack (ADR LEG-2026-063): the web app of the hexagonal monorepo.
//
// A web app is one workspace (`apps/<name>`, declared in a TN's workspaces
// map as kind `web`) that Bun both serves and bundles: `src/server/main.ts`
// hosts one context's generated tRPC router at `/trpc/*` and the client's
// HTML import at `/`, and `src/client/main.tsx` talks to that router through a
// client typed by the router type the adapter re-exports. No Vite, no FSD
// layers, no theme machinery: the worked example's `apps/web` is the whole
// shape (ADR LEG-2026-062).
//
// It depends on ts-trpc because the app hosts a tRPC router: the names it
// seeds (`<Context>Router`, `./adapters/trpc`) are ts-trpc's derivations,
// imported across that declared edge. The typed-client rules themselves are
// ts-trpc's (`router-type-reexported`, `no-erased-router`) and ts-hexagonal's
// (type-only client imports of server code).
//
// Its data half is contrib.json beside this file: the `web` workspace
// template, the component return types, the Intake nouns and the build check.

import { contribute, definePack } from "../../src/socket-registry.ts";
import { deliverChecks, skeletonEmitters, TS_PACK } from "../ts/pack.ts";
import { TS_HEXAGONAL_PACK } from "../ts-hexagonal/pack.ts";
import { TS_TRPC_PACK } from "../ts-trpc/pack.ts";
import { webAppEmitter } from "./scripts/web-app-emitter.ts";
import { runWebObligation } from "./scripts/web-obligation.ts";

/** This pack's name, as a literal — see the note on `TS_PACK`. */
export const TS_WEB_PACK = "ts-web";

export const tsWebPack = definePack({
  name: TS_WEB_PACK,
  dependsOnPacks: [TS_PACK, TS_HEXAGONAL_PACK, TS_TRPC_PACK],
  contributes: [
    contribute(skeletonEmitters, [webAppEmitter]),
    contribute(deliverChecks, [{
      name: "web-obligation",
      description: "every web app the design declares has its whole door, a client that bundles, and a typed tRPC client it uses",
      run: runWebObligation,
    }]),
  ],
});
