// ts-hexagonal's test levels (ADR LEG-2026-063, TN-26-012 §8), contributed to the
// ts pack's `testObligations` socket. Per feature of every context:
//
//   feature     <feature>.test.ts beside the contract, constructing
//               <InPort>Handler and calling execute
//   command     the generated <feature>.command.laws.test.ts, iff the feature
//               takes input
//   store       for the <InPort>Store out port: the shared conformance suite
//               <feature>.store.test-support.ts, calling every port method,
//               and one <feature>.store.test.ts per composed storage
//               technology that imports it
//   out port    for every other out port, one
//               <feature>.<role>.test.ts per @implementedBy technology,
//               calling every port method
//   in adapter  the generated <feature>.<role>.laws.test.ts per @exposedVia
//               technology with a feature role
//
// And per app workspace, at green only (Q2): a composition-root.test.ts next
// to every composition-root.ts, the app's smoke test, which imports a
// compose… function from ./composition-root.ts and calls it. The composition
// root is generated (ADR LEG-2026-067), but what it constructs is the builder's, so
// red cannot ask for it.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { ObligationGap, ObligationInput, TestObligation } from "../../ts/pack.ts";
import type { FeatureContractModel } from "../../ts/scripts/feature-model.ts";
import { adapterClassPrefix } from "../../ts/scripts/naming.ts";
import { callSites, sourcesAt } from "../../ts/scripts/call-sites.ts";
import ts from "typescript";
import { contextModels } from "./context-model.ts";

const COMPOSITION_ROOT = "composition-root.ts";
/** An app's smoke test, next to its composition root. Exported for the packs
 *  whose services the apps need at run time (ts-drizzle-postgres: a database). */
export const SMOKE_TEST = "composition-root.test.ts";
/** Where the app workspaces live (`apps/<name>`). */
const APPS_DIR = "apps";

/** Every app smoke test under `root`, project-relative and sorted: each
 *  `composition-root.test.ts` under `apps/` (dependency directories
 *  skipped). Pure apart from reading the directory tree. */
export function appSmokeTests(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const path = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(join(dir, entry.name), path);
      else if (entry.isFile() && entry.name === SMOKE_TEST) out.push(path);
    }
  };
  walk(join(root, APPS_DIR), APPS_DIR);
  return out.sort();
}

function featureGaps(input: ObligationInput, root: string, feature: FeatureContractModel): ObligationGap[] {
  const gaps: ObligationGap[] = [];
  const files = new Set(input.files);
  const tests = new Set(input.tests.map((t) => t.path));
  const dir = `${root}/application/${feature.area}/${feature.feature}`;
  const handler = `${feature.inPort.name}Handler`;

  const featureTest = `${dir}/${feature.feature}.test.ts`;
  if (!tests.has(featureTest)) {
    gaps.push({ level: "feature", path: featureTest, message: `${feature.feature} has no handler test; write ${featureTest} with fakes of its out ports` });
  } else {
    const sites = callSites(sourcesAt(input.tests, [featureTest]));
    if (!sites.constructed.has(handler)) gaps.push({ level: "feature", path: featureTest, message: `${featureTest} never constructs ${handler}` });
    if (!sites.methods.has("execute") && !input.reached.has(`${handler}.execute`)) {
      gaps.push({ level: "feature", path: featureTest, message: `${featureTest} never calls ${handler}.execute(…)` });
    }
  }

  if (feature.input !== undefined) {
    const laws = `${dir}/${feature.feature}.command.laws.test.ts`;
    if (!files.has(laws)) gaps.push({ level: "command", path: laws, message: `${feature.feature} has no generated command laws; run the design gate` });
  }

  for (const port of feature.outPorts) {
    if (port.isStore) {
      const suite = `${dir}/${feature.feature}.store.test-support.ts`;
      if (!tests.has(suite)) {
        gaps.push({ level: "store", path: suite, message: `${port.name} has no conformance suite; write ${suite}, exporting a suite every storage technology runs` });
      } else {
        const sites = callSites(sourcesAt(input.tests, [suite]));
        for (const method of port.methods) {
          if (!sites.methods.has(method.name)) gaps.push({ level: "store", path: suite, message: `the ${port.name} conformance suite never calls ${method.name}(…)` });
        }
      }
      for (const tech of input.facts.adapterTechnologies.filter((t) => t.direction === "out" && t.storage === true)) {
        const storeTest = `${root}/adapters/out/${tech.id}/${feature.area}/${feature.feature}.store.test.ts`;
        if (!tests.has(storeTest)) {
          gaps.push({ level: "store", path: storeTest, message: `${adapterClassPrefix(tech.id)}${port.name} has no store test; write ${storeTest} running the ${port.name} conformance suite` });
          continue;
        }
        const sites = callSites(sourcesAt(input.tests, [storeTest]));
        const suiteImport = (s: string): boolean => s.replace(/\.(?:tsx?|jsx?)$/, "").endsWith(`/${feature.feature}.store.test-support`);
        if (![...sites.imports].some(suiteImport)) {
          gaps.push({ level: "store", path: storeTest, message: `${storeTest} does not run the shared conformance suite (${feature.feature}.store.test-support.ts)` });
        }
      }
    } else {
      for (const id of port.implementedBy) {
        const adapterTest = `${root}/adapters/out/${id}/${feature.area}/${feature.feature}.${port.role}.test.ts`;
        if (!tests.has(adapterTest)) {
          gaps.push({ level: "out-adapter", path: adapterTest, message: `${adapterClassPrefix(id)}${port.name} has no test; write ${adapterTest}` });
          continue;
        }
        const sites = callSites(sourcesAt(input.tests, [adapterTest]));
        for (const method of port.methods) {
          if (!sites.methods.has(method.name)) gaps.push({ level: "out-adapter", path: adapterTest, message: `${adapterTest} never calls ${method.name}(…)` });
        }
      }
    }
  }

  for (const id of feature.exposedVia) {
    const tech = input.facts.adapterTechnologies.find((t) => t.id === id);
    if (tech?.featureRole === undefined) continue;
    const laws = `${root}/adapters/in/${id}/${feature.area}/${feature.feature}.${tech.featureRole}.laws.test.ts`;
    if (!files.has(laws)) gaps.push({ level: "in-adapter", path: laws, message: `${feature.feature} has no generated ${id} laws; run the design gate` });
  }
  return gaps;
}

/** Does a smoke test import a `compose…` function from its composition root
 *  and call it? Undefined when it does; the gap's wording when not. Pure: an
 *  AST walk of the test's own source, like the feature obligations' call
 *  sites. Imports are named (`import { composeApp } from "./composition-root.ts"`)
 *  or a namespace (`import * as root from …` then `root.composeApp()`). */
export function smokeTestProblem(path: string, source: string): string | undefined {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const fromRoot = (spec: string): boolean => /^\.\/composition-root(?:\.[cm]?[jt]s)?$/.test(spec);
  const named = new Set<string>();
  const namespaces = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!fromRoot(statement.moduleSpecifier.text) || statement.importClause === undefined || statement.importClause.isTypeOnly) continue;
    const bindings = statement.importClause.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    else {
      for (const element of bindings.elements) {
        const imported = (element.propertyName ?? element.name).text;
        if (!element.isTypeOnly && /^compose[A-Z0-9]/.test(imported)) named.add(element.name.text);
      }
    }
  }
  if (named.size === 0 && namespaces.size === 0) {
    return `${path} does not import its app's compose function from ./composition-root.ts`;
  }
  let called = false;
  const visit = (node: ts.Node): void => {
    if (called) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && named.has(callee.text)) called = true;
      else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) &&
        namespaces.has(callee.expression.text) && /^compose[A-Z0-9]/.test(callee.name.text)) called = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return called ? undefined : `${path} never calls the compose function it imports from ./composition-root.ts`;
}

function appGaps(input: ObligationInput): ObligationGap[] {
  const gaps: ObligationGap[] = [];
  const tests = new Set(input.tests.map((t) => t.path));
  for (const app of input.facts.workspaces.filter((w) => w.kind !== "context")) {
    const roots = input.files.filter((f) => f.startsWith(`${app.sourceRoot}/`) && f.endsWith(`/${COMPOSITION_ROOT}`));
    if (roots.length === 0) {
      gaps.push({ level: "app", message: `${app.dir} has no ${COMPOSITION_ROOT}; run the design gate, which generates it` });
    }
    for (const root of roots) {
      const smoke = `${root.slice(0, -COMPOSITION_ROOT.length)}${SMOKE_TEST}`;
      if (!tests.has(smoke)) {
        gaps.push({ level: "app", path: smoke, message: `${app.dir} has no smoke test; write ${smoke} against its compose function` });
        continue;
      }
      const source = input.tests.find((t) => t.path === smoke)?.source ?? "";
      const problem = smokeTestProblem(smoke, source);
      if (problem !== undefined) gaps.push({ level: "app", path: smoke, message: problem });
    }
  }
  return gaps;
}

export const hexagonalObligations: readonly TestObligation[] = [
  {
    name: "hexagonal-features",
    description: "Per feature: a handler test, command laws, a store conformance suite with a store test per storage technology, out-adapter tests and in-adapter laws.",
    check: (input) => contextModels(input.facts).flatMap((m) => m.features.flatMap((f) => featureGaps(input, m.root, f))),
  },
  {
    name: "hexagonal-app-smoke",
    description: "Per app, at green: a composition-root.test.ts smoke test next to every composition root, importing its compose function and calling it.",
    phases: ["green"],
    check: appGaps,
  },
];
