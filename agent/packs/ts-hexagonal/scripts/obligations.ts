// ts-hexagonal's test levels (ADR 2026-063, TN-26-012 §8), contributed to the
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
// to every composition-root.ts, the app's smoke test. It runs against code
// only the builder writes, so red cannot ask for it.

import type { ObligationGap, ObligationInput, TestObligation } from "../../ts/pack.ts";
import type { FeatureContractModel } from "../../ts/scripts/feature-model.ts";
import { adapterClassPrefix } from "../../ts/scripts/naming.ts";
import { callSites, sourcesAt } from "../../ts/scripts/call-sites.ts";
import { contextModels } from "./context-model.ts";

const COMPOSITION_ROOT = "composition-root.ts";
const SMOKE_TEST = "composition-root.test.ts";

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
        if (![...sites.imports].some((s) => s.endsWith(`/${feature.feature}.store.test-support.ts`))) {
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

function appGaps(input: ObligationInput): ObligationGap[] {
  const gaps: ObligationGap[] = [];
  const tests = new Set(input.tests.map((t) => t.path));
  for (const app of input.facts.workspaces.filter((w) => w.kind !== "context")) {
    const roots = input.files.filter((f) => f.startsWith(`${app.sourceRoot}/`) && f.endsWith(`/${COMPOSITION_ROOT}`));
    if (roots.length === 0) {
      gaps.push({ level: "app", message: `${app.dir} has no ${COMPOSITION_ROOT}; run the design gate, which seeds it` });
    }
    for (const root of roots) {
      const smoke = `${root.slice(0, -COMPOSITION_ROOT.length)}${SMOKE_TEST}`;
      if (!tests.has(smoke)) gaps.push({ level: "app", path: smoke, message: `${app.dir} has no smoke test; write ${smoke} against its compose function` });
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
    description: "Per app, at green: a composition-root.test.ts smoke test next to every composition root.",
    phases: ["green"],
    check: appGaps,
  },
];
