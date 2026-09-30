import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { emittedFileProblem, workspaceTemplates } from "../../ts/pack.ts";
import {
  EXAMPLE_CONTEXT,
  exampleContracts,
  exampleFacts,
  manifestDifferences,
  readExample,
} from "../../example-suite/example-facts.ts";
import { emitWebApps, webAppEmitter } from "./web-app-emitter.ts";

// The app-template golden (WI-7): the web app seeded from the worked
// example's design is the example's apps/web, minus what is the builder's
// (the dev seed data and the page's content), with the composeApp() name the
// smoke test and the server entry rely on.

const APP = "apps/web/src";
const emitted = emitWebApps(exampleFacts());
const content = (path: string): string => emitted.find((f) => f.path === `${APP}/${path}`)!.content;

describe("the web app of the worked example", () => {
  test("seeds four skeleton files", () => {
    expect(emitted.map((f) => [f.path, f.mode])).toEqual([
      [`${APP}/client/index.html`, "skeleton"],
      [`${APP}/client/main.tsx`, "skeleton"],
      [`${APP}/server/composition-root.ts`, "skeleton"],
      [`${APP}/server/main.ts`, "skeleton"],
    ]);
    for (const file of emitted) expect(emittedFileProblem(file, webAppEmitter.name)).toBeUndefined();
  });

  test("the page is the example's, byte for byte", () => {
    expect(content("client/index.html")).toBe(readExample(`${APP}/client/index.html`));
  });

  test("the server entry is the example's without its dev seed data", () => {
    const example = readExample(`${APP}/server/main.ts`)
      .replace('import { seed } from "./seed.ts";\n', "")
      .replace("await seed(router);\n", "");
    expect(content("server/main.ts")).toBe(example);
  });

  test("the client keeps the example's typed door: a type-only router import and one typed client", () => {
    const example = readExample(`${APP}/client/main.tsx`).split("\n");
    const client = content("client/main.tsx").split("\n");
    for (const line of [
      'import { createTRPCClient, httpBatchLink } from "@trpc/client";',
      'import { createRoot } from "react-dom/client";',
      'import type { ProjectManagementRouter } from "@example/project-management/adapters/trpc";',
      "// Type-only import: the client gets the router's types, none of its server code.",
      'const api = createTRPCClient<ProjectManagementRouter>({ links: [httpBatchLink({ url: "/trpc" })] });',
      'import { useEffect, useState } from "react";',
      "  useEffect(() => {",
      "  }, []);",
      'createRoot(document.getElementById("root")!).render(<App />);',
    ]) {
      expect(example, line).toContain(line);
      expect(client, line).toContain(line);
    }
    // Like the example, the page calls an input-less query on mount: the
    // context's first one, in area then feature order.
    expect(client).toContain("    api.notes.list.query().then(setData);");
  });

  test("with no input-less query, the client is exported rather than left unused", () => {
    const contracts = exampleContracts().map((c) => ({ ...c, source: c.source.replace(/@exposedVia trpc( mcp)?\n/, (m) =>
      c.path.includes("create-") ? m : "@exposedVia lambda\n") }));
    const main = emitWebApps(exampleFacts({ contracts })).find((f) => f.path.endsWith("client/main.tsx"))!.content;
    expect(main).toContain("export const api = createTRPCClient<ProjectManagementRouter>");
    expect(main).not.toContain("useEffect");
  });

  test("the composition root is composeApp(), typed by the hosted router", () => {
    expect(readExample(`${APP}/server/composition-root.ts`)).toContain("export function composeApp() {");
    expect(content("server/composition-root.ts")).toBe([
      'import type { ProjectManagementRouter } from "@example/project-management/adapters/trpc";',
      "",
      "// The one place that decides which adapter backs which port.",
      "export function composeApp(): ProjectManagementRouter {",
      '  throw new Error("Not implemented: composeApp");',
      "}",
      "",
    ].join("\n"));
  });

  test("the manifest template is the example's, pinned exactly", () => {
    const template = workspaceTemplates(["ts", "ts-hexagonal", "ts-trpc", "ts-web"]).find((t) => t.kind === "web")!;
    expect(template.root).toBe("apps");
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", template.manifest), "utf8"));
    expect(manifestDifferences(manifest, JSON.parse(readExample("apps/web/package.json")))).toEqual([]);
  });
});

describe("refusals", () => {
  test("a web app with no feature exposed via tRPC", () => {
    const contracts = exampleContracts().map((c) => ({ ...c, source: c.source.replace(/@exposedVia [a-z ]+/, "@exposedVia lambda") }));
    expect(() => emitWebApps(exampleFacts({ contracts }))).toThrow(/apps\/web \(web\) hosts one context's tRPC router, but no feature/);
  });

  test("a web app over two contexts that expose tRPC", () => {
    const contracts = [
      ...exampleContracts(),
      ...exampleContracts().filter((c) => c.path.includes("list-notes")).map((c) => ({
        path: c.path.replace(EXAMPLE_CONTEXT, "contexts/billing"),
        source: c.source.replace("@example/project-management/domain", "@example/billing/domain"),
      })),
    ];
    const facts = exampleFacts({ contracts: contracts.filter((c) => c.path.startsWith(EXAMPLE_CONTEXT)) });
    const billing = { ...facts.workspaces.find((w) => w.dir === EXAMPLE_CONTEXT)!, dir: "contexts/billing", name: "billing",
      packageName: "@example/billing", sourceRoot: "contexts/billing/src", contracts: contracts.filter((c) => c.path.startsWith("contexts/billing")) };
    expect(() => emitWebApps({ ...facts, workspaces: [billing, ...facts.workspaces] }))
      .toThrow(/2 contexts expose features via trpc \(billing, project-management\)/);
  });
});
