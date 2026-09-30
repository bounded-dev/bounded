// The MCP app's seed files (ADR 2026-061, TN-26-012 §1), emitted for every
// workspace a TN declares with kind `mcp`. Both are skeletons: written once,
// then the builder's.
//
//   src/main.ts               connects the composed server to a stdio transport
//   src/composition-root.ts   composeApp(): the context's MCP server, wired by the builder
//
// An MCP app hosts exactly one context's server: the context whose features
// are tagged `@exposedVia mcp`.

import type { EmittedFile, Emitter, ProjectFacts } from "../../ts/pack.ts";
import { byContext, featuresExposedVia } from "./in-adapter-kit.ts";
import { contextServerFactory, MCP } from "./mcp-emitter.ts";

export const MCP_KIND = "mcp";

const skeleton = (path: string, lines: readonly string[]): EmittedFile => ({ path, content: `${lines.join("\n")}\n`, mode: "skeleton" });

export function emitMcpApps(facts: ProjectFacts): EmittedFile[] {
  const out: EmittedFile[] = [];
  for (const app of facts.workspaces.filter((w) => w.kind === MCP_KIND)) {
    const contexts = [...byContext(featuresExposedVia(facts, MCP)).keys()];
    if (contexts.length !== 1) {
      throw new Error(`${app.dir} (mcp) hosts one context's MCP server, but ${contexts.length === 0
        ? "no feature is tagged @exposedVia mcp"
        : `${contexts.length} contexts expose features via mcp (${contexts.join(", ")}); split them into one app each`}`);
    }
    const context = contexts[0]!;
    const factory = contextServerFactory(context);
    out.push(
      skeleton(`${app.sourceRoot}/composition-root.ts`, [
        `import type { ${factory} } from "${facts.scope}/${context}/adapters/mcp";`,
        "",
        "// The one place that decides which adapter backs which port.",
        `export function composeApp(): ReturnType<typeof ${factory}> {`,
        '  throw new Error("Not implemented: composeApp");',
        "}",
      ]),
      skeleton(`${app.sourceRoot}/main.ts`, [
        'import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";',
        'import { composeApp } from "./composition-root.ts";',
        "",
        "await composeApp().connect(new StdioServerTransport());",
      ]),
    );
  }
  return out;
}

export const mcpAppEmitter: Emitter = {
  name: "mcp-app",
  description:
    "The seed files of every MCP app a TN declares: a stdio entry that connects the composed server, and the " +
    "composeApp() skeleton the builder wires.",
  emit: emitMcpApps,
};
