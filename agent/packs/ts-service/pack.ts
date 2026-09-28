// An explicit service capability. A web application does not imply a service.
//
// Everything service-shaped rides this pack's contributions, so a project that
// did not compose it meets none of it (ADR 2026-046): the shipped runtime, the
// one-door lint on src/**, the router-type rules on contracts, and the
// delivery pin for the runtime's framework package.
import { contribute, definePack } from "../../src/socket-registry.ts";
import {
  contractPurityOverrides,
  contractSupportFiles,
  deliverChecks,
  lintSrcRules,
  TS_PACK,
} from "../ts/pack.ts";
import { runServiceCheck } from "./service-check.ts";
import { serviceRuntimeSupport } from "./service-runtime-support.ts";
import { rawFrameworkEntry } from "./eslint/rules/raw-framework-entry.ts";
import { noErasedRouter } from "./eslint/rules/no-erased-router.ts";
import { routerTypeReexported } from "./eslint/rules/router-type-reexported.ts";

export const TS_SERVICE_PACK = "ts-service";
/** Flat-config namespace for this pack's rules. */
export const TS_SERVICE_PLUGIN = "bounded-ts-service";

export const tsServicePack = definePack({
  name: TS_SERVICE_PACK,
  dependsOnPacks: [TS_PACK],
  contributes: [
    contribute(deliverChecks, [{
      name: "service-obligation",
      description: "ts-service requires an implemented ServiceRouter; with ts-web, its reachable network door must use that router's type",
      run: runServiceCheck,
    }]),
    contribute(contractSupportFiles, [serviceRuntimeSupport]),
    // One door to the framework (TN-26-004): runtime imports of the server
    // framework belong to the shipped runtime alone. src/** only — tests may
    // assert a framework error without re-mapping the taxonomy.
    contribute(lintSrcRules, [{
      plugin: TS_SERVICE_PLUGIN,
      name: "raw-framework-entry",
      rule: rawFrameworkEntry,
      namedIn: "builder",
    }]),
    contribute(contractPurityOverrides, [{
      files: ["**/*.contract.ts"],
      plugin: {
        namespace: TS_SERVICE_PLUGIN,
        rules: { "no-erased-router": noErasedRouter, "router-type-reexported": routerTypeReexported },
      },
      rules: {
        [`${TS_SERVICE_PLUGIN}/no-erased-router`]: "error",
        [`${TS_SERVICE_PLUGIN}/router-type-reexported`]: "error",
      },
      why:
        "A service contract must carry its implementation's inferred router type — never an erased framework " +
        "type, never absent — or the typed client is silently lost (ADR 2026-030, TN-26-006 A2).",
    }]),
  ],
});
