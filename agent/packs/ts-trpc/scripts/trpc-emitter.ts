// The tRPC in adapter, generated whole from the feature contracts (ADR
// 2026-060, TN-26-012 §6). For every context with a feature tagged
// `@exposedVia trpc` it emits, all in mode `generated`:
//
//   adapters/in/trpc/trpc.ts                          the one initTRPC instance
//   adapters/in/trpc/<area>/<feature>.procedure.ts    one procedure per feature
//   adapters/in/trpc/<area>/<area>.router.ts          one router per area
//   adapters/in/trpc/router.ts                        the context router + its type
//   adapters/in/trpc/index.ts                         the barrel
//   adapters/in/trpc/<area>/<feature>.procedure.laws.test.ts   the adapter laws
//
// Pure: the same facts always give the same bytes, and nothing touches disk.

import type { EmittedFile, Emitter, ProjectFacts } from "../../ts/pack.ts";
import type { FeatureContractModel } from "../../ts/scripts/feature-model.ts";
import { camelCase, pascalCase, routeKey } from "../../ts/scripts/naming.ts";
import {
  applicationImport,
  byCodePoint,
  byContext,
  depsFunctionHead,
  featuresExposedVia,
  fits,
  importLine,
  indent,
  inAdapterDir,
  lawHeader,
  lawPrelude,
  listing,
  plainOfCall,
  portVariable,
  resultOfCommand,
} from "./in-adapter-kit.ts";

export const TRPC = "trpc";

/** `createProjectManagementRouter` — the context router factory. */
export const contextRouterFactory = (context: string): string => `create${pascalCase(context)}Router`;
/** `ProjectManagementRouter` — the context router type, re-exported by the barrel. */
export const contextRouterType = (context: string): string => `${pascalCase(context)}Router`;
/** `createNotesRouter`. */
export const areaRouterFactory = (area: string): string => `create${pascalCase(area)}Router`;
/** `createNoteProcedure`. */
export const procedureName = (feature: string): string => `${camelCase(feature)}Procedure`;

const file = (path: string, lines: readonly string[]): EmittedFile => ({ path, content: `${lines.join("\n")}\n`, mode: "generated" });

function procedureFile(feature: FeatureContractModel): string[] {
  const port = portVariable(feature);
  const portType = feature.inPort.name;
  const name = procedureName(feature.feature);
  const input = feature.input;
  const imports = [
    importLine(input === undefined ? [] : [input.commandName, input.schemaName], [portType], applicationImport(feature)),
    'import { t } from "../trpc.ts";',
    "",
  ];
  const head = `export const ${name} = (${port}: ${portType}) =>`;
  if (input !== undefined) {
    return [
      ...imports,
      head,
      `  t.procedure.input(${input.schemaName}).${feature.kind === "query" ? "query" : "mutation"}(async ({ input }) => {`,
      ...indent([
        `const command = ${input.commandName}.parse(input);`,
        "if (!command.ok) return command;",
        ...resultOfCommand(`${port}.execute(command.value)`, feature.inPort.returns),
      ], 4),
      "  });",
    ];
  }
  const kind = feature.kind === "query" ? "query" : "mutation";
  const body = plainOfCall(`${port}.execute()`, feature.inPort.returns);
  if ("expression" in body) {
    const call = `t.procedure.${kind}(async () => ${body.expression});`;
    return [...imports, ...(fits(`${head} ${call}`) ? [`${head} ${call}`] : [head, `  ${call}`])];
  }
  return [...imports, head, `  t.procedure.${kind}(async () => {`, ...indent(body.statements, 4), "  });"];
}

function areaRouterFile(area: string, features: readonly FeatureContractModel[]): string[] {
  const keys = new Map<string, string>();
  for (const feature of features) {
    const key = routeKey(area, feature.feature);
    const other = keys.get(key);
    if (other !== undefined) {
      throw new Error(`${feature.contractPath}: route key '${area}.${key}' is also ${other}'s — rename one feature (TN-26-012 §6)`);
    }
    keys.set(key, feature.feature);
  }
  return [
    importLine([], features.map((f) => f.inPort.name), applicationImport(features[0]!)),
    'import { t } from "../trpc.ts";',
    ...features.map((f) => `import { ${procedureName(f.feature)} } from "./${f.feature}.procedure.ts";`),
    "",
    depsFunctionHead(areaRouterFactory(area), features.map((f) => [portVariable(f), f.inPort.name] as const)),
    "  return t.router({",
    ...features.map((f) => `    ${routeKey(area, f.feature)}: ${procedureName(f.feature)}(deps.${portVariable(f)}),`),
    "  });",
    "}",
  ];
}

function contextRouterFile(context: string, areas: readonly string[]): string[] {
  const factories = areas.map(areaRouterFactory);
  const parts = factories.map((f) => `Parameters<typeof ${f}>[0]`);
  const deps = `type Deps = ${parts.join(" & ")};`;
  return [
    ...areas.map((area) => `import { ${areaRouterFactory(area)} } from "./${area}/${area}.router.ts";`),
    'import { t } from "./trpc.ts";',
    "",
    ...(fits(deps) ? [deps] : [`type Deps = ${parts[0]!} &`, ...parts.slice(1).map((p, i) => `  ${p}${i === parts.length - 2 ? ";" : " &"}`)]),
    "",
    `// The whole context's API: ${listing(areas.map((a) => `${camelCase(a)}.*`))}`,
    `export function ${contextRouterFactory(context)}(deps: Deps) {`,
    "  return t.router({",
    ...areas.map((area) => `    ${camelCase(area)}: ${areaRouterFactory(area)}(deps),`),
    "  });",
    "}",
    "",
    `export type ${contextRouterType(context)} = ReturnType<typeof ${contextRouterFactory(context)}>;`,
  ];
}

function lawsFile(feature: FeatureContractModel): string[] {
  const prelude = lawPrelude(feature);
  const input = feature.input;
  const name = procedureName(feature.feature);
  const expected = input !== undefined || feature.inPort.returns.result ? `{ ok: true, value: ${prelude.mapped} }` : prelude.mapped;
  const call = input === undefined ? "caller.law()" : "caller.law(input as never)";
  const tests: string[] = [];
  const valid = input === undefined ? "" : "validInput()";
  if (input !== undefined) {
    tests.push(
      "test(\"refuses a wire-invalid input without calling execute\", async () => {",
      `  const { calls, call } = procedure(${prelude.returned});`,
      "  await expect(call(WIRE_INVALID)).rejects.toThrow();",
      "  expect(calls).toHaveLength(0);",
      "});",
      "",
      "test(\"returns the command's failure for a domain-invalid input without calling execute\", async () => {",
      "  for (const input of domainInvalidInputs()) {",
      `    const { calls, call } = procedure(${prelude.returned});`,
      "    const output = await call(input);",
      `    expect(output).toEqual(${input.commandName}.parse(input));`,
      "    expect((output as { ok: boolean }).ok).toBe(false);",
      "    expect(calls).toHaveLength(0);",
      "  }",
      "});",
      "",
      "test(\"calls execute exactly once, with the parsed command\", async () => {",
      "  const input = validInput();",
      `  const { calls, call } = procedure(${prelude.returned});`,
      "  await call(input);",
      "  expect(calls).toHaveLength(1);",
      "  expectParsedCommand(calls[0]![0], input);",
      "});",
      "",
    );
  } else {
    tests.push(
      "test(\"calls execute exactly once, with no arguments\", async () => {",
      `  const { calls, call } = procedure(${prelude.returned});`,
      "  await call();",
      "  expect(calls).toEqual([[]]);",
      "});",
      "",
    );
  }
  tests.push(
    "test(\"returns plain toJSON data\", async () => {",
    `  const output = await procedure(${prelude.returned}).call(${valid});`,
    `  expect(output).toEqual(${expected});`,
    "  expect(JSON.parse(JSON.stringify(output ?? null))).toEqual(output ?? null);",
    "});",
  );
  if (feature.inPort.returns.result) {
    tests.push(
      "",
      "test(\"passes the in port's failure through unchanged\", async () => {",
      `  const output = await procedure({ ok: false, error: "adapter law failure" }).call(${valid});`,
      "  expect(output).toEqual({ ok: false, error: \"adapter law failure\" });",
      "});",
    );
  }
  return [
    ...lawHeader(`The ${name}`),
    'import { describe, expect, test } from "bun:test";',
    importLine(prelude.applicationValues, [feature.inPort.name], applicationImport(feature)),
    ...prelude.imports,
    'import { t } from "../trpc.ts";',
    `import { ${name} } from "./${feature.feature}.procedure.ts";`,
    "",
    ...prelude.declarations,
    "",
    "function procedure(returns: unknown) {",
    "  const { port, calls } = fakePort(returns);",
    `  const caller = t.router({ law: ${name}(port) }).createCaller({});`,
    `  return { calls, call: (${input === undefined ? "" : "input?: unknown"}): Promise<unknown> => ${call} };`,
    "}",
    "",
    `describe("${name} — adapter laws", () => {`,
    ...indent(tests, 2),
    "});",
  ];
}

/** Every file of the tRPC in adapter, for every context that exposes a feature through it. */
export function emitTrpcAdapters(facts: ProjectFacts): EmittedFile[] {
  const out: EmittedFile[] = [];
  for (const [context, features] of byContext(featuresExposedVia(facts, TRPC))) {
    const dir = inAdapterDir(context, TRPC);
    const areas = [...new Set(features.map((f) => f.area))].sort(byCodePoint);
    out.push(file(`${dir}/trpc.ts`, [
      'import { initTRPC } from "@trpc/server";',
      "",
      "// Shared by every router in this context so they can be combined.",
      "export const t = initTRPC.create();",
    ]));
    for (const area of areas) {
      const inArea = features.filter((f) => f.area === area);
      out.push(file(`${dir}/${area}/${area}.router.ts`, areaRouterFile(area, inArea)));
      for (const feature of inArea) {
        out.push(file(`${dir}/${area}/${feature.feature}.procedure.ts`, procedureFile(feature)));
        out.push(file(`${dir}/${area}/${feature.feature}.procedure.laws.test.ts`, lawsFile(feature)));
      }
    }
    out.push(file(`${dir}/router.ts`, contextRouterFile(context, areas)));
    out.push(file(`${dir}/index.ts`, [
      `export { ${contextRouterFactory(context)}, type ${contextRouterType(context)} } from "./router.ts";`,
    ]));
  }
  return out.sort((a, b) => byCodePoint(a.path, b.path));
}

export const trpcAdapterEmitter: Emitter = {
  name: "trpc-in-adapter",
  description:
    "The tRPC in adapter of every context with a feature tagged @exposedVia trpc: one procedure per feature, one router " +
    "per area, the context router and its type, and the generated adapter laws (TN-26-012 §6).",
  emit: emitTrpcAdapters,
};
