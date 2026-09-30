// What an app that HOSTS a context's tRPC router needs to know about it
// (TN-26-012 §1, §6). The web app (ts-web) and the desktop app (ts-desktop)
// both host one, and both depend on ts-trpc — not on each other — so the
// derivations they share live here, beside the emitter that names the router.

import type { EmittedFile, ProjectFacts, WorkspaceFacts } from "../../ts/pack.ts";
import { camelCase, routeKey } from "../../ts/scripts/naming.ts";
import { byContext, featuresExposedVia } from "./in-adapter-kit.ts";
import { contextRouterType, TRPC } from "./trpc-emitter.ts";

/** The one context a router-hosting app serves, or a refusal naming the fix. */
export function hostedTrpcContext(facts: ProjectFacts, app: WorkspaceFacts): string {
  const contexts = [...byContext(featuresExposedVia(facts, TRPC)).keys()];
  if (contexts.length !== 1) {
    throw new Error(`${app.dir} (${app.kind}) hosts one context's tRPC router, but ${contexts.length === 0
      ? "no feature is tagged @exposedVia trpc"
      : `${contexts.length} contexts expose features via trpc (${contexts.join(", ")}); split them into one app each`}`);
  }
  return contexts[0]!;
}

/** "project-management" → "Project management". */
export function contextTitle(context: string): string {
  const words = context.split("-").join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The call path of the context's first input-less query, in area then
 * feature order (`notes.list`), which a seed uses so its client is exercised
 * from the first run. Undefined when the context exposes none.
 */
export function firstInputlessQuery(facts: ProjectFacts, context: string): string | undefined {
  const feature = featuresExposedVia(facts, TRPC)
    .find((f) => f.context === context && f.kind === "query" && f.input === undefined);
  return feature === undefined ? undefined : `${camelCase(feature.area)}.${routeKey(feature.area, feature.feature)}`;
}

/** `composeApp(): <Router>` — the router-hosting composition root skeleton. */
/** A React page's mount: find the root element, refusing a page without one.
 *  No non-null assertion, so an app skeleton passes the builder's own lint. */
export const MOUNT: readonly string[] = [
  'const root = document.getElementById("root");',
  'if (root === null) throw new Error("index.html has no #root element");',
];

export function routerCompositionRoot(path: string, scope: string, context: string): EmittedFile {
  const router = contextRouterType(context);
  return {
    path,
    mode: "skeleton",
    content: [
      `import type { ${router} } from "${scope}/${context}/adapters/trpc";`,
      "",
      "// The one place that decides which adapter backs which port.",
      `export function composeApp(): ${router} {`,
      '  throw new Error("Not implemented: composeApp");',
      "}",
      "",
    ].join("\n"),
  };
}
