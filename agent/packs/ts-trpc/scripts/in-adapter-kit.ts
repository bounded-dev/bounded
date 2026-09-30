// The in-adapter kit: what the ts-trpc, ts-mcp and ts-lambda emitters share.
//
// It is copied byte for byte into each of the three packs, because a pack may
// import only across its declared edges and all three depend on ts-hexagonal,
// not on each other. `in-adapter-kit.test.ts` in ts-trpc holds the three
// copies identical.
//
// PART 1 is a STAND-IN for ts-hexagonal's feature-contract parser (WI-5,
// TN-26-012 §3). The emitters code against `FeatureContractModel`
// (packs/ts/scripts/feature-model.ts) and reach the parser only through
// `featureContracts(facts)`. SWAP: when ts-hexagonal exports its parser,
// make `featureContracts` call it and delete the rest of part 1.
//
// PART 2 is the one fixed layout the emitters print with (TN-26-012 §6):
// two-space indent, double quotes, semicolons, trailing commas in multi-line
// lists, and a line that reaches the width breaks. The break rules are the few
// the formatter of the worked example applies to these shapes, so emitting the
// example's design reproduces its files byte for byte.

import ts from "typescript";
import type { ContractSource, ProjectFacts, WorkspaceFacts } from "../../ts/pack.ts";
import type {
  FeatureContractModel,
  FeatureInputModel,
  InputFieldModel,
  MethodModel,
  OutPortModel,
  ReturnModel,
} from "../../ts/scripts/feature-model.ts";
import { camelCase, featureKind, pascalCase, portRole } from "../../ts/scripts/naming.ts";

// --- part 1: the feature-contract parser stand-in ---------------------------

const FEATURE_PATH = /^contexts\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/src\/application\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/\3\.contract\.ts$/;
const TAG_LINE = /^@(exposedVia|implementedBy)((?:\s+[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+)\s*$/;

/** Every feature contract of every context workspace, sorted by context,
 *  area, then feature. */
export function featureContracts(facts: ProjectFacts): FeatureContractModel[] {
  return facts.workspaces
    .filter((workspace) => workspace.dir.startsWith("contexts/"))
    .flatMap((workspace) => featuresOf(workspace, facts.scope))
    .sort((a, b) => byCodePoint(a.context, b.context) || byCodePoint(a.area, b.area) || byCodePoint(a.feature, b.feature));
}

function featuresOf(workspace: WorkspaceFacts, scope: string): FeatureContractModel[] {
  return workspace.contracts.filter((contract) => FEATURE_PATH.test(contract.path)).map((c) => parseFeatureContract(c, scope));
}

interface JsDoc {
  readonly summary: string;
  readonly tags: ReadonlyMap<string, readonly string[]>;
}

function jsDocOf(node: ts.Node, source: ts.SourceFile, where: string): JsDoc | undefined {
  const ranges = ts.getLeadingCommentRanges(source.text, node.getFullStart()) ?? [];
  const block = ranges.filter((r) => r.kind === ts.SyntaxKind.MultiLineCommentTrivia).at(-1);
  if (block === undefined) return undefined;
  const text = source.text.slice(block.pos, block.end);
  if (!text.startsWith("/**")) return undefined;
  const lines = text.slice(3, -2).split("\n").map((line) => line.replace(/^\s*\*?\s?/, "").trimEnd());
  const summary: string[] = [];
  const tags = new Map<string, string[]>();
  let inTags = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("@")) {
      inTags = true;
      const match = TAG_LINE.exec(trimmed);
      if (match === null) throw new Error(`${where}: '${trimmed}' is not an @exposedVia or @implementedBy tag line (TN-26-012 §4)`);
      if (tags.has(match[1]!)) throw new Error(`${where}: at most one @${match[1]} tag per interface`);
      const ids = match[2]!.trim().split(/\s+/);
      if (new Set(ids).size !== ids.length) throw new Error(`${where}: @${match[1]} names an id twice`);
      tags.set(match[1]!, ids);
    } else if (!inTags && trimmed !== "") {
      summary.push(trimmed);
    }
  }
  return { summary: summary.join(" "), tags };
}

function typeText(node: ts.TypeNode, source: ts.SourceFile): string {
  return node.getText(source).replace(/\s+/g, " ");
}

function propertyFields(decl: ts.InterfaceDeclaration, where: string): { name: string; type: ts.TypeNode }[] {
  return decl.members.map((member) => {
    if (!ts.isPropertySignature(member) || !ts.isIdentifier(member.name) || member.type === undefined) {
      throw new Error(`${where}: ${decl.name.text} may declare only readonly properties`);
    }
    if (member.questionToken !== undefined) throw new Error(`${where}: optional field ${member.name.text} is refused for now (TN-26-012)`);
    if (!member.modifiers?.some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword)) {
      throw new Error(`${where}: ${decl.name.text}.${member.name.text} must be readonly`);
    }
    return { name: member.name.text, type: member.type };
  });
}

function referenceName(node: ts.TypeNode): string | undefined {
  return ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && node.typeArguments === undefined
    ? node.typeName.text : undefined;
}

function returnModel(node: ts.TypeNode, source: ts.SourceFile, domain: ReadonlySet<string>, where: string): ReturnModel {
  const text = typeText(node, source);
  const refuse = (): never => {
    throw new Error(`${where}: execute must return Promise<R> or Promise<Result<R>> with R void, a domain concept or a concept array; got ${text}`);
  };
  if (!ts.isTypeReferenceNode(node) || !ts.isIdentifier(node.typeName) || node.typeName.text !== "Promise" ||
      node.typeArguments?.length !== 1) return refuse();
  let inner = node.typeArguments[0]!;
  let result = false;
  if (ts.isTypeReferenceNode(inner) && ts.isIdentifier(inner.typeName) && inner.typeName.text === "Result") {
    if (inner.typeArguments?.length !== 1) return refuse();
    result = true;
    inner = inner.typeArguments[0]!;
  }
  if (inner.kind === ts.SyntaxKind.VoidKeyword) return { text, result, shape: "void" };
  const array = ts.isArrayTypeNode(inner) ? inner.elementType : undefined;
  const concept = referenceName(array ?? inner);
  if (concept === undefined || !domain.has(concept)) return refuse();
  return { text, result, shape: array === undefined ? "value" : "array", concept };
}

function methodsOf(decl: ts.InterfaceDeclaration, source: ts.SourceFile, where: string): MethodModel[] {
  return decl.members.map((member) => {
    if (!ts.isMethodSignature(member) || !ts.isIdentifier(member.name) || member.type === undefined) {
      throw new Error(`${where}: ${decl.name.text} may declare only methods with return types`);
    }
    const returns = typeText(member.type, source);
    if (!returns.startsWith("Promise<")) throw new Error(`${where}: ${decl.name.text}.${member.name.text} must return a Promise`);
    return {
      name: member.name.text,
      parameters: member.parameters.map((p) => ({
        name: p.name.getText(source),
        type: { kind: "other" as const, text: p.type === undefined ? "unknown" : typeText(p.type, source) },
      })),
      returns: { kind: "other" as const, text: returns },
    };
  });
}

export function parseFeatureContract(contract: ContractSource, scope: string): FeatureContractModel {
  const where = contract.path;
  const match = FEATURE_PATH.exec(contract.path);
  if (match === null) throw new Error(`${where}: not a feature contract path (contexts/<context>/src/application/<area>/<feature>/<feature>.contract.ts)`);
  const [, context, area, feature] = match as unknown as [string, string, string, string];
  const inPortName = pascalCase(feature);
  const domainImport = `${scope}/${context}/domain`;
  const source = ts.createSourceFile(contract.path, contract.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  const imports = source.statements.filter(ts.isImportDeclaration);
  const domainNames = new Set<string>();
  for (const decl of imports) {
    const specifier = (decl.moduleSpecifier as ts.StringLiteral).text;
    const bindings = decl.importClause?.namedBindings;
    if (specifier !== domainImport || decl.importClause?.isTypeOnly !== true || bindings === undefined || !ts.isNamedImports(bindings)) {
      throw new Error(`${where}: the only import allowed is \`import type { … } from "${domainImport}"\``);
    }
    for (const element of bindings.elements) domainNames.add(element.name.text);
  }
  if (imports.length > 1) throw new Error(`${where}: import the domain barrel once`);

  const interfaces = new Map<string, ts.InterfaceDeclaration>();
  const order: string[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) continue;
    if (!ts.isInterfaceDeclaration(statement) || !statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      throw new Error(`${where}: a feature contract holds only exported interfaces`);
    }
    if (interfaces.has(statement.name.text)) throw new Error(`${where}: ${statement.name.text} is declared twice`);
    interfaces.set(statement.name.text, statement);
    order.push(statement.name.text);
  }

  const inputName = `${inPortName}Input`;
  const commandName = `${inPortName}Command`;
  const commandFactoryName = `${inPortName}CommandFactory`;
  const present = [inputName, commandName, commandFactoryName].filter((name) => interfaces.has(name));
  if (present.length !== 0 && present.length !== 3) {
    throw new Error(`${where}: ${inputName}, ${commandName} and ${commandFactoryName} are all present or all absent`);
  }
  let input: FeatureInputModel | undefined;
  if (present.length === 3) {
    const wire = propertyFields(interfaces.get(inputName)!, where);
    const command = propertyFields(interfaces.get(commandName)!, where);
    const brand = command.shift();
    if (brand?.name !== "__brand" || typeText(brand.type, source) !== `"${commandName}"`) {
      throw new Error(`${where}: ${commandName} starts with readonly __brand: "${commandName}"`);
    }
    if (wire.length !== command.length || wire.some((field, i) => field.name !== command[i]!.name)) {
      throw new Error(`${where}: ${commandName} declares the same fields as ${inputName}, in the same order`);
    }
    const fields: InputFieldModel[] = wire.map((field, i) => {
      const wireType = typeText(field.type, source);
      if (wireType !== "string" && wireType !== "number" && wireType !== "boolean") {
        throw new Error(`${where}: ${inputName}.${field.name} must be string, number or boolean`);
      }
      const concept = referenceName(command[i]!.type);
      if (concept === undefined || !domainNames.has(concept)) {
        throw new Error(`${where}: ${commandName}.${field.name} must be a domain value object imported from ${domainImport}`);
      }
      return { name: field.name, wireType, concept };
    });
    const factory = interfaces.get(commandFactoryName)!;
    const parse = factory.members[0];
    if (factory.members.length !== 1 || parse === undefined || !ts.isMethodSignature(parse) ||
        parse.getText(source).replace(/\s+/g, " ") !== `parse(raw: unknown): Result<${commandName}>;`) {
      throw new Error(`${where}: ${commandFactoryName} is exactly parse(raw: unknown): Result<${commandName}>`);
    }
    input = { inputName, commandName, commandFactoryName, schemaName: `${camelCase(feature)}Schema`, fields };
  }

  const inPort = interfaces.get(inPortName);
  if (inPort === undefined) throw new Error(`${where}: the in port ${inPortName} is missing`);
  const execute = inPort.members[0];
  if (inPort.members.length !== 1 || execute === undefined || !ts.isMethodSignature(execute) ||
      execute.name.getText(source) !== "execute" || execute.type === undefined) {
    throw new Error(`${where}: ${inPortName} has exactly one member, execute`);
  }
  const domain = new Set([...domainNames].filter((name) => name !== "Result"));
  const returns = returnModel(execute.type, source, domain, where);
  if (input === undefined ? execute.parameters.length !== 0 :
      execute.parameters.length !== 1 || execute.parameters[0]!.getText(source).replace(/\s+/g, " ") !== `command: ${commandName}`) {
    throw new Error(`${where}: ${inPortName}.execute takes ${input === undefined ? "no parameters" : `(command: ${commandName})`}`);
  }
  const inDoc = jsDocOf(inPort, source, where);
  if (inDoc?.tags.has("implementedBy")) throw new Error(`${where}: @implementedBy belongs on an out port, not the in port`);

  const outPorts: OutPortModel[] = [];
  const known = new Set([inputName, commandName, commandFactoryName, inPortName]);
  const roles = new Set<string>();
  for (const name of order.slice(order.indexOf(inPortName) + 1)) {
    const decl = interfaces.get(name)!;
    const doc = jsDocOf(decl, source, where);
    if (doc?.tags.has("exposedVia")) throw new Error(`${where}: @exposedVia belongs on the in port only`);
    const role = portRole(name);
    if (roles.has(role)) throw new Error(`${where}: two out ports share the role '${role}'`);
    roles.add(role);
    const isStore = name === `${inPortName}Store`;
    if (!isStore && name.endsWith("Store")) throw new Error(`${where}: the only store port is ${inPortName}Store`);
    outPorts.push({
      name, role, isStore, methods: methodsOf(decl, source, where),
      implementedBy: doc?.tags.get("implementedBy") ?? [],
      ...(doc?.summary ? { doc: doc.summary } : {}),
    });
    known.add(name);
  }
  const stray = order.find((name) => !known.has(name));
  if (stray !== undefined) throw new Error(`${where}: ${stray} is declared before the in port; out ports follow it`);

  return {
    context, area, feature, kind: featureKind(feature), contractPath: contract.path, domainImport,
    domainTypes: [...domain].sort(),
    ...(input === undefined ? {} : { input }),
    inPort: { name: inPortName, ...(input === undefined ? {} : { parameter: { name: "command", type: { kind: "local" as const, text: commandName, name: commandName } } }), returns },
    outPorts,
    exposedVia: inDoc?.tags.get("exposedVia") ?? [],
    ...(inDoc?.summary ? { doc: inDoc.summary } : {}),
  };
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
