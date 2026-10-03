// The MCP in adapter, generated whole from the feature contracts (ADR
// 2026-060, TN-26-012 §6). For every context with a feature tagged
// `@exposedVia mcp` it emits, all in mode `generated`:
//
//   adapters/in/mcp/<area>/<feature>.tool.ts             one tool per feature
//   adapters/in/mcp/server.ts                            the context's server
//   adapters/in/mcp/index.ts                             the barrel
//   adapters/in/mcp/<area>/<feature>.tool.laws.test.ts   the adapter laws
//
// The tool name is `toolName(feature)` and its description is the in port's
// JSDoc summary, which an MCP feature must therefore have. Pure: the same facts
// always give the same bytes, and nothing touches disk.

import type { EmittedFile, Emitter, ProjectFacts } from "../../ts/pack.ts";
import type { FeatureContractModel } from "../../ts/scripts/feature-model.ts";
import { pascalCase, toolName } from "../../ts/scripts/naming.ts";
import {
  applicationImport,
  byCodePoint,
  byContext,
  conceptVariable,
  featuresExposedVia,
  fits,
  groupedPath,
  groupedType,
  groupsOf,
  importLine,
  indent,
  inAdapterDir,
  lawHeader,
  lawPrelude,
  pluralVariable,
  portVariable,
} from "./in-adapter-kit.ts";

export const MCP = "mcp";
const SDK_SERVER = "@modelcontextprotocol/sdk/server/mcp.js";

/** `createProjectManagementMcpServer`. */
export const contextServerFactory = (context: string): string => `create${pascalCase(context)}McpServer`;
/** `registerCreateProjectTool`. */
export const registerFunction = (feature: FeatureContractModel): string => `register${feature.inPort.name}Tool`;

const file = (path: string, lines: readonly string[]): EmittedFile => ({ path, content: `${lines.join("\n")}\n`, mode: "generated" });

const errorText = (expression: string): string => `return { isError: true, content: [{ type: "text", text: ${expression} }] };`;
const jsonText = (expression: string): string => `return { content: [{ type: "text", text: JSON.stringify(${expression}) }] };`;

/** Statements from the parsed command (or none) to the tool result. */
function toolBody(feature: FeatureContractModel): string[] {
  const port = portVariable(feature);
  const input = feature.input;
  const call = `${port}.execute(${input === undefined ? "" : "command.value"})`;
  const returns = feature.inPort.returns;
  const lines = input === undefined ? [] : [
    `const command = ${input.commandName}.parse(input);`,
    `if (!command.ok) ${errorText("command.error")}`,
  ];
  if (returns.result) {
    lines.push(`const result = await ${call};`, `if (!result.ok) ${errorText("result.error")}`);
    lines.push(returns.shape === "void" ? "return { content: [] };" : jsonText("result.value"));
    return lines;
  }
  if (returns.shape === "void") return [...lines, `await ${call};`, "return { content: [] };"];
  const local = returns.shape === "array" ? pluralVariable(returns.concept!) : conceptVariable(returns.concept!);
  return [...lines, `const ${local} = await ${call};`, jsonText(local)];
}

function toolFile(feature: FeatureContractModel): string[] {
  const input = feature.input;
  const doc = feature.doc;
  if (doc === undefined || doc.trim() === "") {
    throw new Error(`${feature.contractPath}: a feature exposed via mcp needs a JSDoc summary on its in port ` +
      `${feature.inPort.name} — it is the tool description (TN-26-012 §4)`);
  }
  const port = portVariable(feature);
  const name = registerFunction(feature);
  const params = [`server: McpServer`, `${port}: ${feature.inPort.name}`];
  const oneLineHead = `export function ${name}(${params.join(", ")}): void {`;
  const head = fits(oneLineHead) ? [oneLineHead] : [`export function ${name}(`, ...params.map((p) => `  ${p},`), "): void {"];
  const members = [`description: ${JSON.stringify(doc)}`, ...(input === undefined ? [] : [`inputSchema: ${input.schemaName}.shape`])];
  const config = `{ ${members.join(", ")} }`;
  const handler = `async (${input === undefined ? "" : "input"}) => {`;
  const nameLiteral = JSON.stringify(toolName(feature.feature));
  const body = toolBody(feature);
  const hugged = `  server.registerTool(${nameLiteral}, ${config}, ${handler}`;
  const call = fits(hugged)
    ? [hugged, ...indent(body, 4), "  });"]
    : [
      "  server.registerTool(",
      `    ${nameLiteral},`,
      ...(fits(`    ${config},`) ? [`    ${config},`] : ["    {", ...members.map((m) => `      ${m},`), "    },"]),
      `    ${handler}`,
      ...indent(body, 6),
      "    },",
      "  );",
    ];
  return [
    `import type { McpServer } from "${SDK_SERVER}";`,
    importLine(input === undefined ? [] : [input.commandName, input.schemaName], [feature.inPort.name], applicationImport(feature)),
    "",
    ...head,
    ...call,
    "}",
  ];
}

function serverFile(context: string, features: readonly FeatureContractModel[]): string[] {
  // Grouped by area, as the tRPC router nests (ADR 2026-066).
  const groups = groupsOf(features);
  return [
    `import { McpServer } from "${SDK_SERVER}";`,
    importLine([], features.map((f) => f.inPort.name), applicationImport(features[0]!)),
    ...features.map((f) => `import { ${registerFunction(f)} } from "./${f.area}/${f.feature}.tool.ts";`),
    "",
    "// The whole context's MCP surface. The transport (stdio, HTTP) is the app's choice.",
    ...groupedType(`export function ${contextServerFactory(context)}(deps: `, groups, ") {"),
    `  const server = new McpServer({ name: ${JSON.stringify(context)}, version: "0.1.0" });`,
    ...features.map((f) => `  ${registerFunction(f)}(server, ${groupedPath(f)});`),
    "  return server;",
    "}",
  ];
}

function lawsFile(feature: FeatureContractModel, facts: ProjectFacts): string[] {
  const prelude = lawPrelude(feature, facts);
  const input = feature.input;
  const register = registerFunction(feature);
  const returns = feature.inPort.returns;
  const valid = input === undefined ? "" : "validInput()";
  const tests: string[] = [
    "test(\"registers the tool under its generated name, described by the in port's summary\", () => {",
    `  const { registered } = tool(${prelude.returned});`,
    `  expect(registered.name).toBe(${JSON.stringify(toolName(feature.feature))});`,
    `  expect(registered.config.description).toBe(${JSON.stringify(feature.doc ?? "")});`,
    input === undefined
      ? "  expect(registered.config.inputSchema).toBeUndefined();"
      : `  expect(registered.config.inputSchema).toBe(${input.schemaName}.shape);`,
    "});",
    "",
  ];
  if (input !== undefined) {
    tests.push(
      "test(\"refuses a wire-invalid input without calling execute\", async () => {",
      `  const { calls, call } = tool(${prelude.returned});`,
      "  expect((await call(WIRE_INVALID)).isError).toBe(true);",
      "  expect(calls).toHaveLength(0);",
      "});",
      "",
      "test.skipIf(DOMAIN_REFUSES_NOTHING)(\"returns the command's failure for a domain-invalid input without calling execute\", async () => {",
      "  const inputs = domainInvalidInputs();",
      "  expect(inputs.length).toBeGreaterThan(0);",
      "  for (const input of inputs) {",
      `    const { calls, call } = tool(${prelude.returned});`,
      "    const output = await call(input);",
      "    expect(output.isError).toBe(true);",
      `    expect(output.content).toEqual([{ type: "text", text: (${input.commandName}.parse(input) as unknown as { error: string }).error }]);`,
      "    expect(calls).toHaveLength(0);",
      "  }",
      "});",
      "",
      "test(\"calls execute exactly once, with the parsed command\", async () => {",
      "  const input = validInput();",
      `  const { calls, call } = tool(${prelude.returned});`,
      "  await call(input);",
      "  expect(calls).toHaveLength(1);",
      "  expectParsedCommand(calls[0]![0], input);",
      "});",
      "",
    );
  } else {
    tests.push(
      "test(\"calls execute exactly once, with no arguments\", async () => {",
      `  const { calls, call } = tool(${prelude.returned});`,
      "  await call();",
      "  expect(calls).toEqual([[]]);",
      "});",
      "",
    );
  }
  tests.push(
    "test(\"returns plain toJSON data\", async () => {",
    `  const output = await tool(${prelude.returned}).call(${valid});`,
    "  expect(output.isError).toBeUndefined();",
    returns.shape === "void"
      ? "  expect(output.content).toEqual([]);"
      : `  expect(JSON.parse(output.content[0]!.text)).toEqual(${prelude.mapped});`,
    "});",
  );
  if (returns.result) {
    tests.push(
      "",
      "test(\"reports the in port's failure as a tool error\", async () => {",
      `  const output = await tool({ ok: false, error: "adapter law failure" }).call(${valid});`,
      "  expect(output).toEqual({ isError: true, content: [{ type: \"text\", text: \"adapter law failure\" }] });",
      "});",
    );
  }
  return [
    ...lawHeader(`The ${toolName(feature.feature)} tool`),
    'import { describe, expect, test } from "bun:test";',
    `import type { McpServer } from "${SDK_SERVER}";`,
    importLine([...prelude.applicationValues, ...(input === undefined ? [] : [input.schemaName])], [feature.inPort.name], applicationImport(feature)),
    ...prelude.imports,
    `import { ${register} } from "./${feature.feature}.tool.ts";`,
    "",
    ...prelude.declarations,
    "",
    "interface ToolResult {",
    "  isError?: boolean;",
    "  content: { type: string; text: string }[];",
    "}",
    "",
    "interface Registration {",
    "  name: string;",
    "  config: { description?: string; inputSchema?: unknown };",
    "  handler: (input?: unknown) => Promise<ToolResult>;",
    "}",
    "",
    "function tool(returns: unknown) {",
    "  const { port, calls } = fakePort(returns);",
    "  const registrations: Registration[] = [];",
    "  const server = {",
    "    registerTool: (name: string, config: Registration[\"config\"], handler: Registration[\"handler\"]) => {",
    "      registrations.push({ name, config, handler });",
    "    },",
    "  } as unknown as McpServer;",
    `  ${register}(server, port);`,
    "  const registered = registrations[0];",
    "  if (registered === undefined || registrations.length !== 1) throw new Error(\"adapter law: expected exactly one tool\");",
    "  return { calls, registered, call: (input?: unknown) => registered.handler(input) };",
    "}",
    "",
    `describe("${register} — adapter laws", () => {`,
    ...indent(tests, 2),
    "});",
  ];
}

/** Every file of the MCP in adapter, for every context that exposes a feature through it. */
export function emitMcpAdapters(facts: ProjectFacts): EmittedFile[] {
  const out: EmittedFile[] = [];
  for (const [context, features] of byContext(featuresExposedVia(facts, MCP))) {
    const dir = inAdapterDir(context, MCP);
    const names = new Map<string, string>();
    for (const feature of features) {
      const name = toolName(feature.feature);
      if (names.has(name)) throw new Error(`${feature.contractPath}: tool name '${name}' is also ${names.get(name)}'s — rename one feature`);
      names.set(name, feature.contractPath);
      out.push(file(`${dir}/${feature.area}/${feature.feature}.tool.ts`, toolFile(feature)));
      out.push(file(`${dir}/${feature.area}/${feature.feature}.tool.laws.test.ts`, lawsFile(feature, facts)));
    }
    out.push(file(`${dir}/server.ts`, serverFile(context, features)));
    out.push(file(`${dir}/index.ts`, [`export { ${contextServerFactory(context)} } from "./server.ts";`]));
  }
  return out.sort((a, b) => byCodePoint(a.path, b.path));
}

export const mcpAdapterEmitter: Emitter = {
  name: "mcp-in-adapter",
  description:
    "The MCP in adapter of every context with a feature tagged @exposedVia mcp: one tool per feature, described by its " +
    "in port's summary, the context's server factory, and the generated adapter laws (TN-26-012 §6).",
  emit: emitMcpAdapters,
};
