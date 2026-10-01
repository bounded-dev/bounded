// The ts-hexagonal pack's lint rules, as contributions to the ts pack's
// `lintSrcRules` socket. Each message names the fix. All but one bind the
// builder: they police the files the builder writes under the source roots.
// `test-imports` binds the test-writer: the same import boundaries, on the
// test files the architecture test also reads (issue #36).

import type { LintSrcRuleContribution } from "../../ts/pack.ts";
import { clientTypeOnlyServerImports, inAdapterUsesInPort, layerDependency, noCrossContextImport } from "./rules/boundary-rules.ts";
import { compositionRootOnlyConstructs, entryHostsOnly } from "./rules/composition-rules.ts";
import { fileRoleSuffix } from "./rules/file-role-suffix.ts";
import { handlerShape } from "./rules/handler-shape.ts";
import { naming } from "./rules/naming.ts";
import { noIoInCore } from "./rules/no-io-in-core.ts";
import { testImports } from "./rules/test-imports.ts";

/** Flat-config namespace of this pack's rules. */
export const TS_HEXAGONAL_PLUGIN = "bounded-ts-hexagonal";

export const TS_HEXAGONAL_LINT_RULES: readonly LintSrcRuleContribution[] = Object.freeze([
  { plugin: TS_HEXAGONAL_PLUGIN, name: "layer-dependency", rule: layerDependency, namedIn: "builder" },
  { plugin: TS_HEXAGONAL_PLUGIN, name: "no-cross-context-import", rule: noCrossContextImport, namedIn: "builder" },
  { plugin: TS_HEXAGONAL_PLUGIN, name: "no-io-in-core", rule: noIoInCore, namedIn: "builder" },
  { plugin: TS_HEXAGONAL_PLUGIN, name: "file-role-suffix", rule: fileRoleSuffix, namedIn: "builder" },
  { plugin: TS_HEXAGONAL_PLUGIN, name: "naming", rule: naming, namedIn: "builder" },
  { plugin: TS_HEXAGONAL_PLUGIN, name: "handler-shape", rule: handlerShape, namedIn: "builder" },
  { plugin: TS_HEXAGONAL_PLUGIN, name: "composition-root-only-constructs", rule: compositionRootOnlyConstructs, namedIn: "builder" },
  { plugin: TS_HEXAGONAL_PLUGIN, name: "entry-hosts-only", rule: entryHostsOnly, namedIn: "builder" },
  { plugin: TS_HEXAGONAL_PLUGIN, name: "client-type-only-server-imports", rule: clientTypeOnlyServerImports, namedIn: "builder" },
  { plugin: TS_HEXAGONAL_PLUGIN, name: "in-adapter-uses-in-port", rule: inAdapterUsesInPort, namedIn: "builder" },
  { plugin: TS_HEXAGONAL_PLUGIN, name: "test-imports", rule: testImports, namedIn: "test-writer" },
] as LintSrcRuleContribution[]);
