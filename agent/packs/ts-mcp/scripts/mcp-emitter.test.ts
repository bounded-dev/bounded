import { describe, expect, test } from "vitest";
import { emittedFileProblem } from "../../ts/pack.ts";
import { generatedFileGlobsFor, pathGlobMatcher } from "../../../src/pack-contrib.ts";
import {
  EXAMPLE_CONTEXT,
  exampleContracts,
  exampleFacts,
  exampleFiles,
  readExample,
} from "../../example-suite/example-facts.ts";
import { emitMcpAdapters, mcpAdapterEmitter } from "./mcp-emitter.ts";

// The golden (TN-26-012 §6, WI-7): the worked example's feature contracts,
// tagged as TN-26-012 §4 records, reproduce its adapters/in/mcp/** byte for
// byte — the description comes from each in port's JSDoc summary.

const DIR = `${EXAMPLE_CONTEXT}/src/adapters/in/mcp`;

describe("the MCP in adapter of the worked example", () => {
  const emitted = emitMcpAdapters(exampleFacts());
  const adapters = emitted.filter((f) => !f.path.endsWith(".laws.test.ts"));

  test("is exactly the example's files, byte for byte", () => {
    expect(adapters.map((f) => f.path)).toEqual(exampleFiles(DIR));
    for (const file of adapters) expect(file.content, file.path).toBe(readExample(file.path));
  });

  test("adds one law file per tool, and every file is generated and write-protected", () => {
    expect(emitted.filter((f) => f.path.endsWith(".laws.test.ts")).map((f) => f.path)).toEqual([
      `${DIR}/projects/create-project.tool.laws.test.ts`,
      `${DIR}/projects/list-projects.tool.laws.test.ts`,
    ]);
    const generated = pathGlobMatcher(generatedFileGlobsFor(["ts", "ts-hexagonal", "ts-mcp"]));
    for (const file of emitted) {
      expect(emittedFileProblem(file, mcpAdapterEmitter.name), file.path).toBeUndefined();
      expect(file.mode).toBe("generated");
      expect(generated(file.path), file.path).toBe(true);
    }
  });

  test("is pure", () => {
    expect(emitMcpAdapters(exampleFacts())).toEqual(emitted);
  });
});

const LIST_PROJECTS = `${EXAMPLE_CONTEXT}/src/application/projects/list-projects/list-projects.contract.ts`;
const CREATE_PROJECT = `${EXAMPLE_CONTEXT}/src/application/projects/create-project/create-project.contract.ts`;
const withContract = (path: string, edit: (source: string) => string) =>
  exampleContracts().map((c) => (c.path === path ? { ...c, source: edit(c.source) } : c));
const tool = (contracts: ReturnType<typeof exampleContracts>, feature: string): string =>
  emitMcpAdapters(exampleFacts({ contracts })).find((f) => f.path.endsWith(`/${feature}.tool.ts`))!.content;

describe("the shapes the example does not show", () => {
  test("a Result reports its failure as a tool error", () => {
    const contracts = withContract(CREATE_PROJECT, (s) => s.replace("Promise<Project>", "Promise<Result<Project>>"));
    expect(tool(contracts, "create-project")).toContain([
      "      const result = await createProject.execute(command.value);",
      '      if (!result.ok) return { isError: true, content: [{ type: "text", text: result.error }] };',
      '      return { content: [{ type: "text", text: JSON.stringify(result.value) }] };',
    ].join("\n"));
  });

  test("void answers with no content", () => {
    const contracts = withContract(LIST_PROJECTS, (s) => s.replace("execute(): Promise<Project[]>;", "execute(): Promise<void>;"));
    expect(tool(contracts, "list-projects")).toContain("    await listProjects.execute();\n    return { content: [] };\n");
  });

  test("a description is JSON-escaped", () => {
    const contracts = withContract(LIST_PROJECTS, (s) => s.replace(" * List all projects", ' * List "every" project'));
    expect(tool(contracts, "list-projects")).toContain('{ description: "List \\"every\\" project" }');
  });
});

describe("refusals", () => {
  test("an MCP feature without an in-port summary", () => {
    const contracts = withContract(LIST_PROJECTS, (s) => s.replace(" * List all projects\n", ""));
    expect(() => emitMcpAdapters(exampleFacts({ contracts }))).toThrow(/list-projects\.contract\.ts: ListProjects is exposed via mcp, so its \/\*\* \*\/ block needs a summary line/);
  });
});
