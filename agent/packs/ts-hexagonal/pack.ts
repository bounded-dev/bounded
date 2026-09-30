// The ts-hexagonal pack (ADR 2026-063): the hexagonal monorepo layout of
// TN-26-012 — bounded contexts under contexts/, apps under apps/, each context
// split into domain, application and adapters.
//
// Its DATA half is contrib.json beside this file: source roots, test suffixes,
// generated-file globs, the in-memory and console adapter technologies, the
// context workspace template, and the shipped architecture rulebook and test.
// This file is its CODE half:
//
//   skeletonEmitters   barrels, Result, the red-phase errors module, commands
//                      and their laws, handler, in-memory and @implementedBy
//                      out-adapter skeletons, out barrels, workspace seeds
//                      (scripts/emitters.ts)
//   lint rules         nine builder rules (eslint/index.ts). They are defined
//                      and tested here but not yet contributed to the ts
//                      pack's lintSrcRules socket: a contributed rule must be
//                      named in the builder's brief (guard-doc-drift, ADR
//                      2026-018), and that brief is rewritten with the roles.
//                      Contributing them is one line: add
//                      `contribute(lintSrcRules, TS_HEXAGONAL_LINT_RULES)`.
import { contribute, definePack } from "../../src/socket-registry.ts";
import { skeletonEmitters, TS_PACK } from "../ts/pack.ts";
import { TS_HEXAGONAL_EMITTERS } from "./scripts/emitters.ts";

export const TS_HEXAGONAL_PACK = "ts-hexagonal";

export { TS_HEXAGONAL_LINT_RULES, TS_HEXAGONAL_PLUGIN } from "./eslint/index.ts";
export { parseFeatureContract, ContractShapeError } from "./scripts/feature-contract.ts";

export const tsHexagonalPack = definePack({
  name: TS_HEXAGONAL_PACK,
  dependsOnPacks: [TS_PACK],
  contributes: [contribute(skeletonEmitters, TS_HEXAGONAL_EMITTERS)],
});
