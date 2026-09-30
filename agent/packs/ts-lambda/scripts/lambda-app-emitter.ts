// The Lambda app's seed files (ADR 2026-061, TN-26-012 §1), emitted for every
// workspace a TN declares with kind `lambdas`. All are skeletons: written
// once, then the builder's.
//
//   src/composition-root.ts   one compose<Feature>() per Lambda, wired by the builder
//   src/<feature>.ts          one entry per Lambda: `export const handler = compose<Feature>();`
//
// A Lambda app hosts every feature tagged `@exposedVia lambda`, from every
// context. Each entry is bundled for Node by the template's build script
// (`bun build ./src/*.ts --target node`), which is why `no-bun-api` holds here.

import type { EmittedFile, Emitter, ProjectFacts } from "../../ts/pack.ts";
import { pascalCase } from "../../ts/scripts/naming.ts";
import { byCodePoint, featuresExposedVia } from "./in-adapter-kit.ts";
import { LAMBDA, lambdaFactory } from "./lambda-emitter.ts";

export const LAMBDAS_KIND = "lambdas";

/** `composeExportProjects`. */
export const composeFunction = (feature: string): string => `compose${pascalCase(feature)}`;

const skeleton = (path: string, lines: readonly string[]): EmittedFile => ({ path, content: `${lines.join("\n")}\n`, mode: "skeleton" });

export function emitLambdaApps(facts: ProjectFacts): EmittedFile[] {
  const out: EmittedFile[] = [];
  for (const app of facts.workspaces.filter((w) => w.kind === LAMBDAS_KIND)) {
    const features = featuresExposedVia(facts, LAMBDA);
    if (features.length === 0) throw new Error(`${app.dir} (lambdas) hosts Lambdas, but no feature is tagged @exposedVia lambda`);
    const entries = new Map<string, string>();
    for (const feature of features) {
      if (feature.feature === "composition-root" || entries.has(feature.feature)) {
        throw new Error(`${feature.contractPath}: ${app.dir}/src/${feature.feature}.ts would collide — rename the feature`);
      }
      entries.set(feature.feature, feature.contractPath);
    }
    const byImport = new Map<string, string[]>();
    for (const feature of features) {
      const from = `${facts.scope}/${feature.context}/adapters/lambda`;
      byImport.set(from, [...(byImport.get(from) ?? []), lambdaFactory(feature)]);
    }
    const imports = [...byImport].sort(([a], [b]) => byCodePoint(a, b))
      .map(([from, names]) => `import type { ${[...names].sort(byCodePoint).join(", ")} } from "${from}";`);
    out.push(skeleton(`${app.sourceRoot}/composition-root.ts`, [
      ...imports,
      "",
      "// The one place that decides which adapter backs which port. One function per Lambda.",
      ...features.flatMap((feature, i) => [
        ...(i === 0 ? [] : [""]),
        `export function ${composeFunction(feature.feature)}(): ReturnType<typeof ${lambdaFactory(feature)}> {`,
        `  throw new Error("Not implemented: ${composeFunction(feature.feature)}");`,
        "}",
      ]),
    ]));
    for (const feature of features) {
      out.push(skeleton(`${app.sourceRoot}/${feature.feature}.ts`, [
        `import { ${composeFunction(feature.feature)} } from "./composition-root.ts";`,
        "",
        "// Built once per cold start, reused across invocations.",
        `export const handler = ${composeFunction(feature.feature)}();`,
      ]));
    }
  }
  return out.sort((a, b) => byCodePoint(a.path, b.path));
}

export const lambdaAppEmitter: Emitter = {
  name: "lambda-app",
  description:
    "The seed files of every Lambda app a TN declares: one entry per feature tagged @exposedVia lambda, exporting the " +
    "handler its compose<Feature>() builds, and the composition-root skeleton the builder wires.",
  emit: emitLambdaApps,
};
