// The ts-trpc pack (ADR 2026-063): tRPC as an in adapter. It was ts-service.
//
// Everything tRPC-shaped rides this pack's contributions, so a project that did
// not compose it meets none of it (ADR 2026-046):
//
//   * the `trpc-in-adapter` emitter: every context's adapters/in/trpc/**,
//     generated from the features tagged `@exposedVia trpc`, with its laws;
//   * the builder's lint: one door to the server framework, no erased router
//     types, and clients typed by the router type the adapter re-exports;
//   * the architect's lint: no erased router type in a contract;
//   * the delivery obligation: at least one context exposes a feature.
//
// Its data half (the `trpc` adapter technology, its pins and the generated
// globs) is contrib.json beside this file.
import { contribute, definePack } from "../../src/socket-registry.ts";
import {
  contractPurityOverrides,
  deliverChecks,
  lintSrcRules,
  skeletonEmitters,
  TS_PACK,
} from "../ts/pack.ts";
import { TS_HEXAGONAL_PACK } from "../ts-hexagonal/pack.ts";
import { runTrpcObligation } from "./trpc-obligation.ts";
import { trpcAdapterEmitter } from "./scripts/trpc-emitter.ts";
import { rawFrameworkEntry } from "./eslint/rules/raw-framework-entry.ts";
import { noErasedRouter } from "./eslint/rules/no-erased-router.ts";
import { routerTypeReexported } from "./eslint/rules/router-type-reexported.ts";

export const TS_TRPC_PACK = "ts-trpc";
/** Flat-config namespace for this pack's rules. */
export const TS_TRPC_PLUGIN = "bounded-ts-trpc";

export const tsTrpcPack = definePack({
  name: TS_TRPC_PACK,
  dependsOnPacks: [TS_PACK, TS_HEXAGONAL_PACK],
  contributes: [
    contribute(skeletonEmitters, [trpcAdapterEmitter]),
    contribute(deliverChecks, [{
      name: "trpc-obligation",
      description: "ts-trpc requires at least one context to expose a feature through its generated tRPC adapter",
      run: runTrpcObligation,
    }]),
    contribute(lintSrcRules, [
      { plugin: TS_TRPC_PLUGIN, name: "raw-framework-entry", rule: rawFrameworkEntry, namedIn: "builder" },
      { plugin: TS_TRPC_PLUGIN, name: "no-erased-router", rule: noErasedRouter, namedIn: "builder" },
      { plugin: TS_TRPC_PLUGIN, name: "router-type-reexported", rule: routerTypeReexported, namedIn: "builder" },
    ]),
    contribute(contractPurityOverrides, [{
      files: ["**/*.contract.ts"],
      plugin: { namespace: TS_TRPC_PLUGIN, rules: { "no-erased-router": noErasedRouter } },
      rules: { [`${TS_TRPC_PLUGIN}/no-erased-router`]: "error" },
      why:
        "A contract must never name a type-erased tRPC type: the router's real type is generated with the in " +
        "adapter, and an erased one silently loses the typed client (ADR 2026-030, TN-26-012 §6).",
    }]),
  ],
});
