import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { workspaceTemplates } from "../../ts/pack.ts";
import { exampleContracts, exampleFacts, manifestDifferences, readExample } from "../../example-suite/example-facts.ts";
import { emitMcpApps } from "./mcp-app-emitter.ts";

// The app-template golden (WI-7): the MCP app seeded from the worked
// example's design is the example's apps/mcp, with the composition root
// generated: the example's, its dependencies grouped by area (ADR LEG-2026-067).

describe("the MCP app of the worked example", () => {
  const emitted = emitMcpApps(exampleFacts());

  test("seeds the entry, byte for byte, and generates composeApp()", () => {
    expect(emitted.map((f) => [f.path, f.mode])).toEqual([
      ["apps/mcp/src/composition-root.ts", "generated"],
      ["apps/mcp/src/main.ts", "skeleton"],
    ]);
    expect(emitted[1]!.content).toBe(readExample("apps/mcp/src/main.ts"));
    expect(emitted[0]!.content).toBe(readExample("apps/mcp/src/composition-root.ts"));
    expect(emitted[0]!.content).toContain([
      "export function composeApp(): ReturnType<typeof createProjectManagementMcpServer> {",
      "  const db = new InMemoryDatabase();",
      "",
      "  return createProjectManagementMcpServer({",
      "    projects: {",
      "      create: new CreateProjectHandler(new InMemoryCreateProjectStore(db)),",
      "      list: new ListProjectsHandler(new InMemoryListProjectsStore(db)),",
      "    },",
      "  });",
      "}",
    ].join("\n"));
  });

  test("the manifest template is the example's, pinned exactly", () => {
    const template = workspaceTemplates(["ts", "ts-hexagonal", "ts-mcp"]).find((t) => t.kind === "mcp")!;
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", template.manifest), "utf8"));
    expect(manifestDifferences(manifest, JSON.parse(readExample("apps/mcp/package.json")))).toEqual([]);
  });

  test("refuses an MCP app when no feature is exposed via mcp", () => {
    const contracts = exampleContracts().map((c) => ({ ...c, source: c.source.replace("@exposedVia trpc mcp", "@exposedVia trpc") }));
    expect(() => emitMcpApps(exampleFacts({ contracts }))).toThrow(/apps\/mcp \(mcp\) hosts one context's MCP server/);
  });
});
