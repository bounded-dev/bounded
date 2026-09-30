import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { emittedFileProblem, workspaceTemplates } from "../../ts/pack.ts";
import {
  EXAMPLE_CONTEXT,
  exampleContracts,
  exampleFacts,
  manifestDifferences,
  readExample,
} from "../../ts-trpc/testing/example-facts.ts";
import { emitWebApps, webAppEmitter } from "./web-app-emitter.ts";
import { runWebObligation } from "./web-obligation.ts";

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
      'createRoot(document.getElementById("root")!).render(<App />);',
    ]) {
      expect(example, line).toContain(line);
      expect(client, line).toContain(line);
    }
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

describe("the delivery obligation", () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const project = (files: readonly string[]): string => {
    const dir = mkdtempSync(join(tmpdir(), "web-obligation-"));
    dirs.push(dir);
    for (const file of files) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), "\n");
    }
    return dir;
  };

  test("blocks with no web app, or one missing part of its door", () => {
    expect(runWebObligation(project([])).verdict).toBe("block");
    const partial = runWebObligation(project(["apps/web/src/client/index.html"]));
    expect(partial.verdict).toBe("block");
    expect(partial.detail).toEqual([
      "apps/web/src/client/main.tsx", "apps/web/src/server/main.ts", "apps/web/src/server/composition-root.ts",
    ]);
  });

  test("passes once every web app has its door", () => {
    expect(runWebObligation(project(emitted.map((f) => f.path)))).toEqual({
      verdict: "pass", summary: "ts-web: apps/web serve a client page and the router",
    });
  });
});
