// The ts-lambda pack (ADR LEG-2026-063): AWS Lambda handlers as an in adapter,
// and the Lambda app.
//
//   * the `lambda-in-adapter` emitter: every context's adapters/in/lambda/**,
//     generated from the features tagged `@exposedVia lambda`, with its laws;
//   * the `lambda-app` emitter: the seed files of each app a TN declares as
//     kind `lambdas`;
//   * the builder's lint `no-bun-api`: an app bundled with `--target node`
//     runs on Node, where Bun's runtime APIs do not exist.
//
// Its data half is contrib.json beside this file: the `lambda` adapter
// technology, the generated globs and the `lambdas` workspace template.
import { contribute, definePack } from "../../src/socket-registry.ts";
import { lintSrcRules, skeletonEmitters, TS_PACK } from "../ts/pack.ts";
import { TS_HEXAGONAL_PACK } from "../ts-hexagonal/pack.ts";
import { noBunApi } from "./eslint/rules/no-bun-api.ts";
import { lambdaAppEmitter } from "./scripts/lambda-app-emitter.ts";
import { lambdaAdapterEmitter } from "./scripts/lambda-emitter.ts";

export const TS_LAMBDA_PACK = "ts-lambda";
/** Flat-config namespace for this pack's rules. */
export const TS_LAMBDA_PLUGIN = "bounded-ts-lambda";

export const tsLambdaPack = definePack({
  name: TS_LAMBDA_PACK,
  dependsOnPacks: [TS_PACK, TS_HEXAGONAL_PACK],
  contributes: [
    contribute(skeletonEmitters, [lambdaAdapterEmitter, lambdaAppEmitter]),
    contribute(lintSrcRules, [{ plugin: TS_LAMBDA_PLUGIN, name: "no-bun-api", rule: noBunApi, namedIn: "builder" }]),
  ],
});
