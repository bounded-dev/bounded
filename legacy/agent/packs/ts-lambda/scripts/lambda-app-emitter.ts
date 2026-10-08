// The Lambda app's seed files (ADR LEG-2026-061, TN-26-012 §1), emitted for every
// workspace a TN declares with kind `lambdas`.
//
//   src/composition-root.ts   generated (ADR LEG-2026-067): one compose<Feature>() per Lambda, its handler and adapters
//   src/<feature>.ts          skeleton, one entry per Lambda: `export const handler = compose<Feature>();`
//
// A Lambda app hosts every feature tagged `@exposedVia lambda`, from every
// context. Each entry is marked `entry`, so the template's build script
// (`bun build {{entries}} --outdir dist --target node`) bundles exactly the
// entries for Node — never the composition root or a test file — and
// `no-bun-api` holds here.

import type { EmittedFile, Emitter, ProjectFacts } from "../../ts/pack.ts";
import { pascalCase } from "../../ts/scripts/naming.ts";
import { compositionRoot } from "../../ts-hexagonal/scripts/composition-root.ts";
import { byCodePoint, featuresExposedVia } from "./in-adapter-kit.ts";
import { LAMBDA, lambdaFactory } from "./lambda-emitter.ts";

export const LAMBDAS_KIND = "lambdas";

/** `composeExportProjects`. */
export const composeFunction = (feature: string): string => `compose${pascalCase(feature)}`;

const skeleton = (path: string, lines: readonly string[]): EmittedFile => ({ path, content: `${lines.join("\n")}\n`, mode: "skeleton" });
/** A Lambda entry: the manifest's build lists exactly these (`{{entries}}`, TN-26-012 §10). */
const entry = (path: string, lines: readonly string[]): EmittedFile => ({ ...skeleton(path, lines), entry: true });

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
    // One function per Lambda, each building only its own feature's handler.
    out.push(compositionRoot(facts, {
      app,
      path: `${app.sourceRoot}/composition-root.ts`,
      imports: features.map((feature) => ({ from: `${facts.scope}/${feature.context}/adapters/lambda`, values: [lambdaFactory(feature)] })),
      functions: features.map((feature) => ({
        name: composeFunction(feature.feature),
        returns: `ReturnType<typeof ${lambdaFactory(feature)}>`,
        factory: lambdaFactory(feature),
        features: [feature],
      })),
    }));
    for (const feature of features) {
      out.push(entry(`${app.sourceRoot}/${feature.feature}.ts`, [
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
    "handler its compose<Feature>() builds, and the generated composition root that builds them.",
  emit: emitLambdaApps,
};
