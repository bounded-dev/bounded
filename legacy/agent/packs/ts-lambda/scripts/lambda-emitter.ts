// The Lambda in adapter, generated whole from the feature contracts (ADR
// 2026-060, TN-26-012 §6). For every context with a feature tagged
// `@exposedVia lambda` it emits, all in mode `generated`:
//
//   adapters/in/lambda/<area>/<feature>.lambda.ts             one handler factory per feature
//   adapters/in/lambda/index.ts                               the barrel
//   adapters/in/lambda/<area>/<feature>.lambda.laws.test.ts   the adapter laws
//
// A factory takes the in port and returns the handler the Lambda runtime
// calls. An input-less feature ignores the event; a feature with input parses
// the event through its command and answers a Result of plain data, exactly
// as a tRPC procedure does. Pure: the same facts always give the same bytes.

import type { EmittedFile, Emitter, ProjectFacts } from "../../ts/pack.ts";
import type { FeatureContractModel } from "../../ts/scripts/feature-model.ts";
import {
  applicationImport,
  byCodePoint,
  byContext,
  featuresExposedVia,
  fits,
  groupedPath,
  importLine,
  indent,
  inAdapterDir,
  lawHeader,
  lawPrelude,
  plainOfCall,
  resultOfCommand,
} from "./in-adapter-kit.ts";
import { camelCase, routeKey } from "../../ts/scripts/naming.ts";

export const LAMBDA = "lambda";

/** `createExportProjectsLambda`. */
export const lambdaFactory = (feature: FeatureContractModel): string => `create${feature.inPort.name}Lambda`;

const file = (path: string, lines: readonly string[]): EmittedFile => ({ path, content: `${lines.join("\n")}\n`, mode: "generated" });

/** The grouped dependency object holding one in port (ADR 2026-067):
 *  `{ projects: { export: port } }`. */
export function groupedArgument(feature: FeatureContractModel, value: string): string {
  return `{ ${camelCase(feature.area)}: { ${routeKey(feature.area, feature.feature)}: ${value} } }`;
}

function lambdaFile(feature: FeatureContractModel): string[] {
  // The factory takes the grouped shape every in adapter takes (ADR 2026-067),
  // holding its one in port, so a composition root builds one shape everywhere.
  const port = groupedPath(feature);
  const input = feature.input;
  const returns = feature.inPort.returns;
  const plainVoid = input === undefined && !returns.result && returns.shape === "void";
  const outer = `(deps: ${groupedArgument(feature, feature.inPort.name)}) =>`;
  const inner = `async (${input === undefined ? "" : "event: unknown"})${plainVoid ? ": Promise<void>" : ""} => {`;
  let body: string[];
  if (input !== undefined) {
    body = [
      `const command = ${input.commandName}.parse(event);`,
      "if (!command.ok) return command;",
      ...resultOfCommand(`${port}.execute(command.value)`, returns),
    ];
  } else {
    const plain = plainOfCall(`${port}.execute()`, returns);
    body = "expression" in plain ? [`return ${plain.expression};`] : plain.statements;
  }
  const name = lambdaFactory(feature);
  const oneLine = `export const ${name} = ${outer} ${inner}`;
  const code = fits(oneLine)
    ? [oneLine, ...indent(body, 2), "};"]
    : [`export const ${name} =`, `  ${outer}`, `  ${inner}`, ...indent(body, 4), "  };"];
  return [
    importLine(input === undefined ? [] : [input.commandName], [feature.inPort.name], applicationImport(feature)),
    "",
    "// Driving adapter: each invocation calls the in port once.",
    ...code,
  ];
}

function lawsFile(feature: FeatureContractModel, facts: ProjectFacts): string[] {
  const prelude = lawPrelude(feature, facts);
  const input = feature.input;
  const name = lambdaFactory(feature);
  const expected = input !== undefined || feature.inPort.returns.result ? `{ ok: true, value: ${prelude.mapped} }` : prelude.mapped;
  const valid = input === undefined ? "" : "validInput()";
  const tests: string[] = [];
  if (input !== undefined) {
    tests.push(
      "test(\"refuses a wire-invalid event without calling execute\", async () => {",
      `  const { calls, call } = lambda(${prelude.returned});`,
      "  expect(await call(WIRE_INVALID)).toMatchObject({ ok: false });",
      "  expect(calls).toHaveLength(0);",
      "});",
      "",
      "test.skipIf(DOMAIN_REFUSES_NOTHING)(\"returns the command's failure for a domain-invalid event without calling execute\", async () => {",
      "  const inputs = domainInvalidInputs();",
      "  expect(inputs.length).toBeGreaterThan(0);",
      "  for (const input of inputs) {",
      `    const { calls, call } = lambda(${prelude.returned});`,
      "    const output = await call(input);",
      `    expect(output).toEqual(${input.commandName}.parse(input));`,
      "    expect((output as { ok: boolean }).ok).toBe(false);",
      "    expect(calls).toHaveLength(0);",
      "  }",
      "});",
      "",
      "test(\"calls execute exactly once, with the parsed command\", async () => {",
      "  const input = validInput();",
      `  const { calls, call } = lambda(${prelude.returned});`,
      "  await call(input);",
      "  expect(calls).toHaveLength(1);",
      "  expectParsedCommand(calls[0]![0], input);",
      "});",
      "",
    );
  } else {
    tests.push(
      "test(\"calls execute exactly once, with no arguments\", async () => {",
      `  const { calls, call } = lambda(${prelude.returned});`,
      "  await call();",
      "  expect(calls).toEqual([[]]);",
      "});",
      "",
    );
  }
  tests.push(
    "test(\"returns plain toJSON data\", async () => {",
    `  const output = await lambda(${prelude.returned}).call(${valid});`,
    `  expect(output).toEqual(${expected});`,
    "  expect(JSON.parse(JSON.stringify(output ?? null))).toEqual(output ?? null);",
    "});",
  );
  if (feature.inPort.returns.result) {
    tests.push(
      "",
      "test(\"passes the in port's failure through unchanged\", async () => {",
      `  const output = await lambda({ ok: false, error: "adapter law failure" }).call(${valid});`,
      "  expect(output).toEqual({ ok: false, error: \"adapter law failure\" });",
      "});",
    );
  }
  return [
    ...lawHeader(`The ${name} handler`),
    'import { describe, expect, test } from "bun:test";',
    importLine(prelude.applicationValues, [feature.inPort.name], applicationImport(feature)),
    ...prelude.imports,
    `import { ${name} } from "./${feature.feature}.lambda.ts";`,
    "",
    ...prelude.declarations,
    "",
    "function lambda(returns: unknown) {",
    "  const { port, calls } = fakePort(returns);",
    `  const handler = ${name}(${groupedArgument(feature, "port")});`,
    input === undefined
      ? "  return { calls, call: (): Promise<unknown> => handler() };"
      : "  return { calls, call: (event?: unknown): Promise<unknown> => handler(event) };",
    "}",
    "",
    `describe("${name} — adapter laws", () => {`,
    ...indent(tests, 2),
    "});",
  ];
}

/** Every file of the Lambda in adapter, for every context that exposes a feature through it. */
export function emitLambdaAdapters(facts: ProjectFacts): EmittedFile[] {
  const out: EmittedFile[] = [];
  for (const [context, features] of byContext(featuresExposedVia(facts, LAMBDA))) {
    const dir = inAdapterDir(context, LAMBDA);
    const factories = new Map<string, string>();
    for (const feature of features) {
      const name = lambdaFactory(feature);
      if (factories.has(name)) throw new Error(`${feature.contractPath}: ${name} is also ${factories.get(name)}'s — rename one feature`);
      factories.set(name, feature.contractPath);
      out.push(file(`${dir}/${feature.area}/${feature.feature}.lambda.ts`, lambdaFile(feature)));
      out.push(file(`${dir}/${feature.area}/${feature.feature}.lambda.laws.test.ts`, lawsFile(feature, facts)));
    }
    out.push(file(`${dir}/index.ts`, features.map((f) => `export { ${lambdaFactory(f)} } from "./${f.area}/${f.feature}.lambda.ts";`)));
  }
  return out.sort((a, b) => byCodePoint(a.path, b.path));
}

export const lambdaAdapterEmitter: Emitter = {
  name: "lambda-in-adapter",
  description:
    "The Lambda in adapter of every context with a feature tagged @exposedVia lambda: one handler factory per feature, " +
    "the barrel, and the generated adapter laws (TN-26-012 §6).",
  emit: emitLambdaAdapters,
};
