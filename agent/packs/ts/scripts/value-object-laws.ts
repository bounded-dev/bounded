// Domain-concept law generator (ADR 2026-059, TN-26-012 §7): one domain
// concept contract → its colocated `<concept>.laws.test.ts`, run by `bun test`.
//
//   contexts/pm/src/domain/notes/note-text.contract.ts
//     → contexts/pm/src/domain/notes/note-text.laws.test.ts   (generated)
//
// The laws are what holds for EVERY concept of a kind, whatever the domain:
//
//   value object  parse refuses cross-type junk with a reason; equality is by
//                 value; toJSON round-trips through parse; parsing is
//                 deterministic.
//   identifier    all of that, plus generate() yields distinct, parseable ids.
//   entity        equality is by identity, not content; toJSON is each
//                 field's own wire form, and every id in it parses back.
//
// What no generator can know is left to the test-writer's `<concept>.test.ts`:
// which strings are valid project names. A law that needs a valid input takes
// it from the concept itself — `generate()` for an identifier, an `@accepts`
// example on a value object's instance interface — and is emitted as a named
// `test.skip` when neither exists, so the gap is visible in the runner output.
//
// Two properties are forced by the red gate, which accepts only
// NotImplementedError failures (unchanged from ADR 2026-024):
//
//   * A missing sample is SKIPPED, never failed: the fix is an `@accepts` tag
//     in the architect's frozen contract, not the test-writer's work.
//   * `parse()` is never wrapped in try/catch, and no law runs concept code at
//     module load: against the throwing skeleton the NotImplementedError must
//     reach the runner inside a test.
//
// Pure: the same model and lookup always give the same bytes.

import type { DomainConceptModel } from "./feature-model.ts";
import { implementationSpecifierOf, RESULT_SPECIFIER, valueTypeOf } from "./domain-concept.ts";

export class ValueObjectLawsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueObjectLawsError";
  }
}

/** The generator named in the laws file's first-line marker. */
export const LAWS_GENERATOR = "packs/ts/scripts/value-object-laws.ts";

/**
 * The universal hostile-input corpus, as expression source. Which entries are
 * hostile to a given value object depends on the type of its `value`: an input
 * is hostile when it is cross-type, or a same-type sentinel no value of that
 * type could mean (`NaN`, `Infinity`). A same-type ordinary value (`""`, `0`)
 * is a range decision the test-writer makes, so it is not asserted here.
 */
export const HOSTILE_INPUT_EXPRESSIONS: readonly string[] = [
  "undefined",
  "null",
  "true",
  "false",
  "0",
  "-1",
  "NaN",
  "Infinity",
  '""',
  '" "',
  "[]",
  "{}",
  "() => {}",
  'Symbol("x")',
  "new Date()",
  "9007199254740993n",
];

const HOSTILE_KIND: Readonly<Record<string, string>> = {
  undefined: "undefined",
  null: "null",
  true: "boolean",
  false: "boolean",
  "0": "number",
  "-1": "number",
  NaN: "number",
  Infinity: "number",
  '""': "string",
  '" "': "string",
  "[]": "object",
  "{}": "object",
  "() => {}": "function",
  'Symbol("x")': "symbol",
  "new Date()": "object",
  "9007199254740993n": "bigint",
};

const PATHOLOGICAL: Readonly<Record<string, ReadonlySet<string>>> = {
  number: new Set(["NaN", "Infinity"]),
};

/** The corpus entries hostile to a value object whose `value` is `base`. An
 *  `@accepts` example is never also asserted hostile. */
export function hostileExpressionsFor(base: string, accepts: readonly string[] = []): readonly string[] {
  const pathological = PATHOLOGICAL[base] ?? new Set<string>();
  return HOSTILE_INPUT_EXPRESSIONS.filter(
    (expr) => !accepts.includes(expr) && (HOSTILE_KIND[expr] !== base || pathological.has(expr)),
  );
}

/** What the laws need to know about a concept other than the one under test:
 *  an entity's fields are built from these. */
export interface ConceptSampleSource {
  readonly model: DomainConceptModel;
  /** `@accepts` examples on its instance interface, as expression source. */
  readonly examples: readonly string[];
}

/** The concepts of the same domain, by interface name. */
export type ConceptLookup = (name: string) => ConceptSampleSource | undefined;

/** `.../<stem>.contract.ts` → `.../<stem>.laws.test.ts` */
export function lawsPathFor(contractPath: string): string {
  if (!contractPath.endsWith(".contract.ts")) {
    throw new ValueObjectLawsError(`value-object-laws: '${contractPath}' is not a *.contract.ts path`);
  }
  return contractPath.slice(0, -".contract.ts".length) + ".laws.test.ts";
}

const q = (text: string): string => JSON.stringify(text);

/** Deterministic import order, the one the worked example uses: packages
 *  first, then relative paths, compared with `.` sorting before every other
 *  character (so `./note.contract.ts` precedes `./note-id.contract.ts`). */
export function compareSpecifiers(a: string, b: string): number {
  const rank = (s: string): number => (s.startsWith(".") ? 1 : 0);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  const key = (s: string): string => s.replace(/\./g, "\u0001");
  const ka = key(a);
  const kb = key(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

interface Sample {
  /** An expression producing a valid instance (no module-load evaluation). */
  readonly first: string;
  /** An expression producing a different valid instance, when one is known. */
  readonly second?: string;
  /** Uses `mustParse`, so the file needs the helper and the Result type. */
  readonly parses: boolean;
}

function sampleFor(source: ConceptSampleSource): Sample | undefined {
  const { model, examples } = source;
  if (model.kind === "identifier") {
    return { first: `${model.name}.generate()`, second: `${model.name}.generate()`, parses: false };
  }
  if (model.kind !== "value-object" || examples.length === 0) return undefined;
  const parse = (ex: string): string => `mustParse(${model.name}.parse(${ex}), ${q(`${model.name}.parse(${ex})`)})`;
  const distinct = examples.find((ex) => ex !== examples[0]);
  return distinct === undefined
    ? { first: parse(examples[0]!), parses: true }
    : { first: parse(examples[0]!), second: parse(distinct), parses: true };
}

class Writer {
  private readonly lines: string[] = [];
  private depth = 0;
  line(text = ""): this {
    this.lines.push(text === "" ? "" : "  ".repeat(this.depth) + text);
    return this;
  }
  open(text: string): this {
    this.line(text);
    this.depth += 1;
    return this;
  }
  close(text: string): this {
    this.depth -= 1;
    return this.line(text);
  }
  toString(): string {
    return this.lines.join("\n") + "\n";
  }
}

const MUST_PARSE = [
  "/** The value a parse produced, or a failure naming the refused example. A",
  " *  throwing skeleton never reaches this line: its NotImplementedError",
  " *  propagates first, which is what the red gate looks for. */",
  "function mustParse<T>(result: Result<T>, what: string): T {",
  "  if (!result.ok) throw new Error(`${what} was refused: ${String(result.error)}`);",
  "  return result.value;",
  "}",
];

function header(model: DomainConceptModel): string[] {
  const file = model.contractPath.split("/").at(-1)!;
  return [`// GENERATED from ${file} by ${LAWS_GENERATOR} — do not edit.`];
}

function imports(entries: ReadonlyMap<string, { names: Set<string>; typeOnly: boolean }>): string[] {
  return [...entries.keys()].sort(compareSpecifiers).map((specifier) => {
    const { names, typeOnly } = entries.get(specifier)!;
    return `import ${typeOnly ? "type " : ""}{ ${[...names].sort().join(", ")} } from ${q(specifier)};`;
  });
}

function valueObjectLaws(model: DomainConceptModel, examples: readonly string[]): string {
  const name = model.name;
  const base = valueTypeOf(model);
  const hostile = hostileExpressionsFor(base, examples);
  const sample = sampleFor({ model, examples });
  const usesParse = sample?.parses ?? false;
  // The round-trip and equality laws parse a sample's wire form, so every
  // file with a sample needs the helper; so does an identifier's.
  const needsHelper = sample !== undefined;

  const importMap = new Map<string, { names: Set<string>; typeOnly: boolean }>();
  importMap.set("bun:test", { names: new Set(["describe", "expect", "test"]), typeOnly: false });
  if (needsHelper) importMap.set(RESULT_SPECIFIER, { names: new Set(["Result"]), typeOnly: true });
  importMap.set(`./${model.stem}.ts`, { names: new Set([name]), typeOnly: false });

  const w = new Writer();
  for (const l of header(model)) w.line(l);
  for (const l of imports(importMap)) w.line(l);
  w.line();
  w.line("/** Inputs no value of this type may accept, labelled so a failing law names them. */");
  w.open("const HOSTILE_INPUTS: readonly (readonly [string, unknown])[] = [");
  for (const expr of hostile) w.line(`[${q(expr)}, ${expr}],`);
  w.close("];");
  if (needsHelper) {
    w.line();
    for (const l of MUST_PARSE) w.line(l);
  }
  w.line();
  const kindLabel = model.kind === "identifier" ? "identifier" : "value-object";
  w.open(`describe(${q(`${name} — ${kindLabel} laws (generated)`)}, () => {`);

  w.open(`test("parse refuses every hostile input", () => {`);
  w.line(`const wronglyAccepted = HOSTILE_INPUTS.filter(([, raw]) => ${name}.parse(raw).ok).map(([label]) => label);`);
  w.line("expect(wronglyAccepted).toEqual([]);");
  w.close("});");
  w.line();
  w.open(`test("parse gives a reason for every refusal", () => {`);
  w.open("const silent = HOSTILE_INPUTS.filter(([, raw]) => {");
  w.line(`const result = ${name}.parse(raw);`);
  w.line(`return !result.ok && !(typeof result.error === "string" && result.error.trim() !== "");`);
  w.close("}).map(([label]) => label);");
  w.line("expect(silent).toEqual([]);");
  w.close("});");

  if (sample === undefined) {
    w.line();
    w.line(`test.skip(${q(`value laws need a valid ${name} — add an @accepts example to ${name}'s contract`)}, () => {});`);
  } else {
    const a = sample.first;
    const reparse = (x: string): string => `mustParse(${name}.parse(${x}.toJSON()), ${q(`${name}.parse(toJSON())`)})`;
    if (usesParse) {
      w.line();
      w.open(`test("parse accepts the contract's @accepts examples", () => {`);
      for (const ex of examples) w.line(`expect(${name}.parse(${ex}).ok).toBe(true);`);
      w.close("});");
    }
    w.line();
    w.open(`test("toJSON is the ${base} wire form", () => {`);
    w.line(`expect(typeof ${a}.toJSON()).toBe(${q(base)});`);
    w.close("});");
    w.line();
    w.open(`test("toJSON round-trips through parse", () => {`);
    w.line(`const a = ${a};`);
    w.line(`const back = ${reparse("a")};`);
    w.line("expect(back.equals(a)).toBe(true);");
    w.line("expect(back.toJSON()).toStrictEqual(a.toJSON());");
    w.close("});");
    w.line();
    w.open(`test("parses deterministically", () => {`);
    w.line(`const a = ${a};`);
    w.line(`expect(${reparse("a")}.toJSON()).toStrictEqual(${reparse("a")}.toJSON());`);
    w.close("});");
    w.line();
    w.open(`test("equals is reflexive", () => {`);
    w.line(`const a = ${a};`);
    w.line("expect(a.equals(a)).toBe(true);");
    w.close("});");
    w.line();
    w.open(`test("equals compares by value, not by reference", () => {`);
    w.line(`const a = ${a};`);
    w.line(`const b = ${reparse("a")};`);
    w.line("expect(a.equals(b)).toBe(true);");
    w.line("expect(b.equals(a)).toBe(true);");
    w.close("});");
    w.line();
    if (sample.second === undefined) {
      w.line(`test.skip(${q(`equals discriminates — add a second, different @accepts example to ${name}'s contract`)}, () => {});`);
    } else {
      w.open(`test("equals discriminates two different values", () => {`);
      w.line(`const a = ${a};`);
      w.line(`const other = ${sample.second};`);
      w.line("expect(a.equals(other)).toBe(false);");
      w.line("expect(other.equals(a)).toBe(false);");
      w.close("});");
    }
    if (model.kind === "identifier") {
      w.line();
      w.open(`test("generate yields distinct identifiers", () => {`);
      w.line(`expect(${name}.generate().equals(${name}.generate())).toBe(false);`);
      w.close("});");
    }
  }
  w.close("});");
  return w.toString();
}

/** Locals the entity laws declare beside one `const` per field. */
const RESERVED_LOCALS: ReadonlySet<string> = new Set([
  "a", "sameId", "otherId", "json", "mustParse", "describe", "expect", "test", "Result",
]);

function entityLaws(model: DomainConceptModel, lookup: ConceptLookup): string {
  const name = model.name;
  const specifierOf = new Map<string, string>();
  for (const imp of model.imports) for (const n of imp.names) specifierOf.set(n, imp.specifier);

  const samples = new Map<string, Sample>();
  let missing: string | undefined;
  for (const field of model.fields) {
    const conceptName = field.type.kind === "concept" ? field.type.name : field.type.text;
    const source = lookup(conceptName);
    if (source === undefined) {
      throw new ValueObjectLawsError(
        `value-object-laws: ${model.contractPath}: ${name}.${field.name} is '${conceptName}', which is not a concept contract in this domain`,
      );
    }
    if (source.model.kind === "entity") {
      throw new ValueObjectLawsError(
        `value-object-laws: ${model.contractPath}: ${name}.${field.name} holds the entity '${conceptName}' — an entity refers to another entity by its id value object only`,
      );
    }
    const sample = sampleFor(source);
    if (sample === undefined) missing ??= conceptName;
    else samples.set(field.name, sample);
  }

  const idField = model.fields[0]!;
  const idConcept = idField.type.kind === "concept" ? idField.type.name : idField.type.text;
  const identifierFields = model.fields.filter((f) => f.type.kind === "concept" && lookup(f.type.name)?.model.kind === "identifier");
  const needsHelper = missing === undefined && ([...samples.values()].some((s) => s.parses) || identifierFields.length > 0);

  const importMap = new Map<string, { names: Set<string>; typeOnly: boolean }>();
  importMap.set("bun:test", { names: new Set(["describe", "expect", "test"]), typeOnly: false });
  if (missing === undefined) {
    if (needsHelper) importMap.set(RESULT_SPECIFIER, { names: new Set(["Result"]), typeOnly: true });
    importMap.set(`./${model.stem}.ts`, { names: new Set([name]), typeOnly: false });
    for (const field of model.fields) {
      const conceptName = field.type.kind === "concept" ? field.type.name : field.type.text;
      const specifier = implementationSpecifierOf(specifierOf.get(conceptName)!);
      const entry = importMap.get(specifier) ?? { names: new Set<string>(), typeOnly: false };
      entry.names.add(conceptName);
      importMap.set(specifier, entry);
    }
  }

  const w = new Writer();
  for (const l of header(model)) w.line(l);
  for (const l of imports(importMap)) w.line(l);
  if (needsHelper) {
    w.line();
    for (const l of MUST_PARSE) w.line(l);
  }
  w.line();
  w.open(`describe(${q(`${name} — entity laws (generated)`)}, () => {`);
  if (missing !== undefined) {
    w.line(`test.skip(${q(`entity laws need a valid ${missing} — add an @accepts example to ${missing}'s contract`)}, () => {});`);
    w.close("});");
    return w.toString();
  }

  const clash = model.fields.find((f) => RESERVED_LOCALS.has(f.name));
  if (clash !== undefined) {
    throw new ValueObjectLawsError(
      `value-object-laws: ${model.contractPath}: ${name}.${clash.name} shadows a name the generated laws use — rename the field`,
    );
  }
  const firsts = model.fields.map((f) => samples.get(f.name)!.first);
  const construct = (args: readonly string[]): string => `new ${name}(${args.join(", ")})`;

  w.open(`test("equals compares by identity, not by content", () => {`);
  w.line(`const id = ${firsts[0]};`);
  const rest = model.fields.slice(1);
  rest.forEach((f, i) => w.line(`const ${f.name} = ${firsts[i + 1]};`));
  const others = rest.map((f) => {
    const s = samples.get(f.name)!;
    return s.second ?? f.name;
  });
  w.line(`const a = ${construct(["id", ...rest.map((f) => f.name)])};`);
  w.line(`const sameId = ${construct(["id", ...others])};`);
  w.line(`const otherId = ${construct([samples.get(idField.name)!.second ?? firsts[0]!, ...rest.map((f) => f.name)])};`);
  w.line("expect(a.equals(a)).toBe(true);");
  w.line("expect(a.equals(sameId)).toBe(true);");
  w.line("expect(sameId.equals(a)).toBe(true);");
  if (samples.get(idField.name)!.second !== undefined) {
    w.line("expect(a.equals(otherId)).toBe(false);");
    w.line("expect(otherId.equals(a)).toBe(false);");
  }
  w.close("});");
  w.line();

  w.open(`test("toJSON is each field's own wire form", () => {`);
  model.fields.forEach((f, i) => w.line(`const ${f.name} = ${firsts[i]};`));
  w.line(`const json = ${construct(model.fields.map((f) => f.name))}.toJSON();`);
  for (const f of model.fields) w.line(`expect(json.${f.name}).toStrictEqual(${f.name}.toJSON());`);
  w.close("});");

  if (identifierFields.length > 0) {
    w.line();
    w.open(`test("every id in toJSON parses back to the same identifier", () => {`);
    model.fields.forEach((f, i) => w.line(`const ${f.name} = ${firsts[i]};`));
    w.line(`const json = ${construct(model.fields.map((f) => f.name))}.toJSON();`);
    for (const f of identifierFields) {
      const concept = f.type.kind === "concept" ? f.type.name : idConcept;
      w.line(`expect(mustParse(${concept}.parse(json.${f.name}), ${q(`${concept}.parse(json.${f.name})`)}).equals(${f.name})).toBe(true);`);
    }
    w.close("});");
  }
  w.close("});");
  return w.toString();
}

/**
 * The laws file for one domain concept. `examples` are the concept's own
 * `@accepts` examples; `lookup` finds the other concepts of the same domain
 * (an entity's fields). Throws ValueObjectLawsError when an entity names a
 * field concept the domain does not declare, or holds another entity.
 */
export function conceptLawsSource(
  model: DomainConceptModel,
  examples: readonly string[],
  lookup: ConceptLookup,
): string {
  return model.kind === "entity" ? entityLaws(model, lookup) : valueObjectLaws(model, examples);
}
