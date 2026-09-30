// The in-adapter kit: what the ts-trpc, ts-mcp and ts-lambda emitters share.
//
// It is copied byte for byte into each of the three packs, because a pack may
// import only across its declared edges and all three depend on ts-hexagonal,
// not on each other. `in-adapter-kit.test.ts` in ts-trpc holds the three
// copies identical.
//
// PART 1 reads every feature contract with ts-hexagonal's feature-contract
// parser (TN-26-012 §3), which all three packs may import: each depends on
// ts-hexagonal. The emitters code against `FeatureContractModel`
// (packs/ts/scripts/feature-model.ts) and reach the parser only through
// `featureContracts(facts)`.
//
// PART 2 is the one fixed layout the emitters print with (TN-26-012 §6):
// two-space indent, double quotes, semicolons, trailing commas in multi-line
// lists, and a line that reaches the width breaks. The break rules are the few
// the formatter of the worked example applies to these shapes, so emitting the
// example's design reproduces its files byte for byte.

import type { ProjectFacts } from "../../ts/pack.ts";
import type { FeatureContractModel, ReturnModel } from "../../ts/scripts/feature-model.ts";
import { camelCase } from "../../ts/scripts/naming.ts";
import { parseFeatureContract } from "../../ts-hexagonal/pack.ts";

// --- part 1: the feature contracts ------------------------------------------

/** A feature contract's path: the parser refuses a misnamed one there. */
const FEATURE_PATH = /^contexts\/[^/]+\/src\/application\/[^/]+\/[^/]+\/[^/]+\.contract\.ts$/;

/** Every feature contract of every context workspace, parsed by the
 *  hexagonal pack's feature-contract parser, sorted by context, area, then
 *  feature. A contract the parser refuses stops the emitter. */
export function featureContracts(facts: ProjectFacts): FeatureContractModel[] {
  return facts.workspaces
    .filter((workspace) => workspace.dir.startsWith("contexts/"))
    .flatMap((workspace) => workspace.contracts.filter((contract) => FEATURE_PATH.test(contract.path)))
    .map((contract) => parseFeatureContract(contract.path, contract.source, { scope: facts.scope }))
    .sort((a, b) => byCodePoint(a.context, b.context) || byCodePoint(a.area, b.area) || byCodePoint(a.feature, b.feature));
}

// --- part 2: printing ---------------------------------------------------------

/** A line fits when it is shorter than this. */
export const WIDTH = 120;

export const fits = (line: string): boolean => line.length < WIDTH;

/** Code-point order: `CreateNoteCommand` before `createNoteSchema`. */
export const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * `import { A, b, type C } from "x";` — values sorted, then types sorted — or
 * `import type { … }` when there are no values. Breaks to one name per line
 * when it does not fit.
 */
export function importLine(values: readonly string[], types: readonly string[], from: string): string {
  const typeOnly = values.length === 0;
  const names = [...[...values].sort(byCodePoint), ...[...types].sort(byCodePoint).map((t) => (typeOnly ? t : `type ${t}`))];
  const head = typeOnly ? "import type" : "import";
  const line = `${head} { ${names.join(", ")} } from "${from}";`;
  return fits(line) ? line : `${head} {\n${names.map((n) => `  ${n},`).join("\n")}\n} from "${from}";`;
}

/** `export function name(deps: { a: A; b: B }) {` — the sole object parameter
 *  hugs, and breaks one member per line when the head does not fit. */
export function depsFunctionHead(name: string, members: readonly (readonly [string, string])[]): string {
  const line = `export function ${name}(deps: { ${members.map(([k, v]) => `${k}: ${v}`).join("; ")} }) {`;
  return fits(line) ? line : `export function ${name}(deps: {\n${members.map(([k, v]) => `  ${k}: ${v};`).join("\n")}\n}) {`;
}

/** The context package's application export, e.g. `@example/project-management/application`. */
export const applicationImport = (feature: FeatureContractModel): string =>
  feature.domainImport.replace(/\/domain$/, "/application");

/** The in-port parameter name: `camel(feature)`, e.g. `createNote`. */
export const portVariable = (feature: FeatureContractModel): string => camelCase(feature.feature);

const RESERVED = new Set(["command", "input", "result", "event", "deps", "server", "t"]);

/** The local name of one concept value: `Note` → `note`. */
export function conceptVariable(concept: string): string {
  const name = concept.charAt(0).toLowerCase() + concept.slice(1);
  return RESERVED.has(name) ? `${name}Value` : name;
}

/** The local name of a list of concept values: `Project` → `projects`. */
export function pluralVariable(concept: string): string {
  const name = concept.charAt(0).toLowerCase() + concept.slice(1);
  const plural = /(s|x|z|ch|sh)$/.test(name) ? `${name}es` : /[^aeiou]y$/.test(name) ? `${name.slice(0, -1)}ies` : `${name}s`;
  return RESERVED.has(plural) ? `${plural}Value` : plural;
}

/** `x.toJSON()` for a value, `x.map((c) => c.toJSON())` for an array. */
export function toJson(expression: string, returns: ReturnModel): string {
  if (returns.shape === "array") {
    const item = conceptVariable(returns.concept!);
    return `${expression}.map((${item}) => ${item}.toJSON())`;
  }
  return `${expression}.toJSON()`;
}

/**
 * The statements that call the in port with a parsed command and return a
 * Result of plain data (TN-26-012 §6). `call` is the whole `execute(...)`
 * expression. Every line is returned unindented.
 */
export function resultOfCommand(call: string, returns: ReturnModel): string[] {
  if (returns.result) {
    if (returns.shape === "void") return [`return ${call};`];
    return [
      `const result = await ${call};`,
      `return result.ok ? { ok: true as const, value: ${toJson("result.value", returns)} } : result;`,
    ];
  }
  if (returns.shape === "void") return [`await ${call};`, "return { ok: true as const, value: undefined };"];
  const local = returns.shape === "array" ? pluralVariable(returns.concept!) : conceptVariable(returns.concept!);
  return [`const ${local} = await ${call};`, `return { ok: true as const, value: ${toJson(local, returns)} };`];
}

/**
 * For an input-less feature: a single expression when one exists (the plain
 * data), else statements. `void` without Result yields statements that
 * return nothing.
 */
export function plainOfCall(call: string, returns: ReturnModel): { expression: string } | { statements: string[] } {
  if (returns.result) {
    if (returns.shape === "void") return { expression: call };
    return {
      statements: [
        `const result = await ${call};`,
        `return result.ok ? { ok: true as const, value: ${toJson("result.value", returns)} } : result;`,
      ],
    };
  }
  if (returns.shape === "void") return { statements: [`await ${call};`] };
  return { expression: toJson(`(await ${call})`, returns) };
}

export const indent = (lines: readonly string[], by: number): string[] => lines.map((l) => (l === "" ? l : " ".repeat(by) + l));

/** "notes.* and projects.*", "a.*, b.* and c.*". */
export function listing(items: readonly string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)!}`;
}

/** The features exposed through one in technology, after checking every
 *  `@exposedVia` id names a composed in technology (TN-26-012 §4). */
export function featuresExposedVia(facts: ProjectFacts, technology: string): FeatureContractModel[] {
  const inTechnologies = new Set(facts.adapterTechnologies.filter((t) => t.direction === "in").map((t) => t.id));
  const features = featureContracts(facts);
  for (const feature of features) {
    const unknown = feature.exposedVia.find((id) => !inTechnologies.has(id));
    if (unknown !== undefined) {
      throw new Error(`${feature.contractPath}: @exposedVia names '${unknown}', which is not a composed in-adapter technology ` +
        `(composed: ${[...inTechnologies].sort().join(", ") || "none"})`);
    }
  }
  return features.filter((feature) => feature.exposedVia.includes(technology));
}

/** Group by context, keeping the sorted order. */
export function byContext(features: readonly FeatureContractModel[]): Map<string, FeatureContractModel[]> {
  const out = new Map<string, FeatureContractModel[]>();
  for (const feature of features) out.set(feature.context, [...(out.get(feature.context) ?? []), feature]);
  return out;
}

/** The in-adapter folder of a context: `contexts/<context>/src/adapters/in/<tech>`. */
export const inAdapterDir = (context: string, technology: string): string => `contexts/${context}/src/adapters/in/${technology}`;

// --- part 3: the shared half of the generated adapter laws --------------------
//
// Every in adapter obeys the same three laws (TN-26-012 §6, lead decision Q2):
// input the command refuses never reaches the in port; valid input calls
// `execute` exactly once, with the parsed command; and what comes back is plain
// `toJSON` data. A law file exercises the adapter factory with a fake in port,
// so it needs no store, no database and no transport. Valid input is found,
// not invented: an identifier is generated, any other value object takes the
// first candidate its own `parse` accepts.

/** The code both halves of a law file share, for one feature. */
export interface LawPrelude {
  /** Import lines from the domain barrel (empty without input). */
  readonly imports: readonly string[];
  /** Application-barrel values the law needs (the command factory, iff input). */
  readonly applicationValues: readonly string[];
  /** Top-level declarations, unindented. */
  readonly declarations: readonly string[];
  /** What the fake port's `execute` resolves to, as an expression. */
  readonly returned: string;
  /** The plain data the adapter must produce from `returned`, without a Result wrapper. */
  readonly mapped: string;
}

const CANDIDATES = { string: "STRINGS", number: "NUMBERS", boolean: "BOOLEANS" } as const;
const REFUSED = { string: "BAD_STRINGS", number: "BAD_NUMBERS", boolean: "BAD_BOOLEANS" } as const;
const WRONG_WIRE = { string: "0", number: '"0"', boolean: '"0"' } as const;

export function lawPrelude(feature: FeatureContractModel): LawPrelude {
  const returns = feature.inPort.returns;
  const one = "fakeConcept()";
  const value = returns.shape === "void" ? "undefined" : returns.shape === "array" ? `[${one}, ${one}]` : one;
  const returned = returns.result ? `{ ok: true, value: ${value} }` : value;
  const mapped = returns.shape === "void" ? "undefined" : returns.shape === "array" ? "[JSON_OF, JSON_OF]" : "JSON_OF";
  const declarations: string[] = [
    `const JSON_OF: unknown = { adapterLaw: ${JSON.stringify(returns.concept ?? "void")} };`,
    "const fakeConcept = () => ({ toJSON: () => JSON_OF });",
    "",
    `function fakePort(returns: unknown): { port: ${feature.inPort.name}; calls: unknown[][] } {`,
    "  const calls: unknown[][] = [];",
    "  const execute = async (...args: unknown[]) => {",
    "    calls.push(args);",
    "    return returns;",
    "  };",
    `  return { port: { execute } as unknown as ${feature.inPort.name}, calls };`,
    "}",
  ];
  const input = feature.input;
  if (input === undefined) return { imports: [], applicationValues: [], declarations, returned, mapped };
  const concepts = [...new Set(input.fields.map((f) => f.concept))].sort(byCodePoint);
  declarations.push(
    "",
    'const STRINGS: readonly unknown[] = ["Example", "example", "a", "0", "1", "user@example.com", "2024-01-01", "https://example.com"];',
    "const NUMBERS: readonly unknown[] = [1, 0, 42, 0.5, -1];",
    "const BOOLEANS: readonly unknown[] = [true, false];",
    'const BAD_STRINGS: readonly unknown[] = ["", " ", "\\u0000", "x".repeat(100_000)];',
    "const BAD_NUMBERS: readonly unknown[] = [-1, 0, 0.5, -0.5, 1e308, -1e308];",
    "const BAD_BOOLEANS: readonly unknown[] = [];",
    "",
    "interface Factory {",
    "  parse(raw: unknown): { ok: boolean };",
    "  generate?: () => { toJSON(): unknown };",
    "}",
    "",
    "function validRaw(name: string, factory: Factory, candidates: readonly unknown[]): unknown {",
    '  if (typeof factory.generate === "function") return factory.generate().toJSON();',
    "  const found = candidates.find((raw) => factory.parse(raw).ok);",
    "  if (found === undefined) throw new Error(`adapter law: no candidate value parses as ${name}`);",
    "  return found;",
    "}",
    "",
    "function parsedJson(factory: Factory, raw: unknown): unknown {",
    "  return (factory.parse(raw) as unknown as { value: { toJSON(): unknown } }).value.toJSON();",
    "}",
    "",
    "const validInput = (): Record<string, unknown> => ({",
    ...input.fields.map((f) => `  ${f.name}: validRaw(${JSON.stringify(f.concept)}, ${f.concept}, ${CANDIDATES[f.wireType]}),`),
    "});",
    "",
    `const WIRE_INVALID = { ${input.fields.map((f) => `${f.name}: ${WRONG_WIRE[f.wireType]}`).join(", ")} };`,
    "",
    "function domainInvalidInputs(): Record<string, unknown>[] {",
    "  const valid = validInput();",
    "  const variants = [",
    ...input.fields.map((f) => `    ...${REFUSED[f.wireType]}.map((raw) => ({ ...valid, ${f.name}: raw })),`),
    "  ];",
    `  return variants.filter((raw) => !${input.commandName}.parse(raw).ok);`,
    "}",
    "",
    "function probe<T>(read: () => T): T | undefined {",
    "  try {",
    "    return read();",
    "  } catch {",
    "    return undefined;",
    "  }",
    "}",
    "",
    "// A domain whose parse refuses none of the candidates leaves the domain-invalid law nothing to check: it is",
    "// skipped, and says so. Undefined means the domain cannot be probed yet (red), so the law runs and fails.",
    "const DOMAIN_REFUSES_NOTHING = probe(domainInvalidInputs)?.length === 0;",
    "if (DOMAIN_REFUSES_NOTHING) {",
    `  console.warn("adapter law skipped: ${input.commandName}.parse refuses no candidate wire value, so no domain-invalid input exists to check");`,
    "}",
    "",
    "function expectParsedCommand(command: unknown, input: Record<string, unknown>): void {",
    "  const fields = command as Record<string, { toJSON(): unknown }>;",
    ...input.fields.map((f) => `  expect(fields.${f.name}!.toJSON()).toEqual(parsedJson(${f.concept}, input.${f.name}));`),
    "}",
  );
  return {
    imports: [importLine(concepts, [], feature.domainImport)],
    applicationValues: [input.commandName],
    declarations,
    returned,
    mapped,
  };
}

/** The header every generated law file starts with. */
export function lawHeader(subject: string): string[] {
  return [
    "// Generated adapter laws (TN-26-012 §6). Do not edit: the design gate regenerates this file.",
    `// ${subject} refuses what the command refuses, calls execute once with the parsed command, and returns plain data.`,
  ];
}
