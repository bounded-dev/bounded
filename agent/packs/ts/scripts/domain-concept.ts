// The domain-concept parser (ADR 2026-059, TN-26-012 §3): one
// `<concept>.contract.ts` in a context's domain → the `DomainConceptModel`
// every domain emitter codes against (feature-model.ts).
//
// The contract shape is the worked example's `domain.md`, "Contracts own the
// name":
//
//   import type { Result } from "../shared/result.ts";
//
//   export interface NoteText {
//     readonly __brand: "NoteText";
//     readonly value: string;
//     equals(other: NoteText): boolean;
//     toJSON(): string;
//   }
//
//   export interface NoteTextFactory {
//     parse(raw: unknown): Result<NoteText>;
//   }
//
// The parser is the backstop behind contract-purity's lint rules
// (value-object-shape, entity-shape, contract-imports-contracts-only): the
// lint rules explain a defect to the architect at design time, and this
// parser refuses to emit anything from a contract that slipped past them.
// Every refusal names the contract and the fix. Nothing is guessed: a shape
// outside the grammar below is an error, never a best effort.

import { ts } from "ts-morph";
import type {
  ConceptKind,
  ContractImport,
  DomainConceptModel,
  FactoryMember,
  FieldModel,
  MethodModel,
  ParameterModel,
  TypeRef,
} from "./feature-model.ts";
import { pascalCase } from "./naming.ts";

export class DomainConceptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainConceptError";
  }
}

const KEBAB = "[a-z][a-z0-9]*(?:-[a-z0-9]+)*";

/** `contexts/<context>/src/domain/<area>/<stem>.contract.ts` (TN-26-012 §1). */
const DOMAIN_CONCEPT_PATH = new RegExp(`^contexts/(${KEBAB})/src/domain/(${KEBAB})/(${KEBAB})\\.contract\\.ts$`);

/** Relative specifiers a domain contract may import: a sibling contract, a
 *  contract in another area of the same domain, or the shared result type. */
const SIBLING_CONTRACT = new RegExp(`^\\./${KEBAB}\\.contract\\.ts$`);
const AREA_CONTRACT = new RegExp(`^\\.\\./${KEBAB}/${KEBAB}\\.contract\\.ts$`);
export const RESULT_SPECIFIER = "../shared/result.ts";

/** Is this project-relative path a domain concept contract? */
export function isDomainConceptPath(path: string): boolean {
  return DOMAIN_CONCEPT_PATH.test(path);
}

/** `contexts/pm/src/domain/notes/note.contract.ts` → `contexts/pm/src/domain/notes/note.ts` */
export function implementationPathOf(contractPath: string): string {
  return contractPath.replace(/\.contract\.ts$/, ".ts");
}

/** `contexts/pm/src/domain/notes/note.contract.ts` → `contexts/pm/src/domain/notes/note.laws.test.ts` */
export function lawsPathOf(contractPath: string): string {
  return contractPath.replace(/\.contract\.ts$/, ".laws.test.ts");
}

/** The implementation module a contract specifier stands for:
 *  `../projects/project-id.contract.ts` → `../projects/project-id.ts`. */
export function implementationSpecifierOf(contractSpecifier: string): string {
  return contractSpecifier.replace(/\.contract\.ts$/, ".ts");
}

function refuse(path: string, message: string): never {
  throw new DomainConceptError(`${path}: ${message}`);
}

/** Source text with every run of whitespace collapsed to one space. */
function normalised(node: ts.Node, sf: ts.SourceFile): string {
  return node.getText(sf).replace(/\s+/g, " ").trim();
}

/** Canonical print of a type: object literal types are printed on one line as
 *  `{ a; b }` without a trailing separator, whatever the contract's layout,
 *  so a skeleton reads the same however the architect wrapped the line. */
export function typeText(node: ts.TypeNode, sf: ts.SourceFile): string {
  if (ts.isTypeLiteralNode(node)) {
    const members = node.members.map((m) => normalised(m, sf).replace(/[;,]$/, ""));
    return members.length === 0 ? "{}" : `{ ${members.join("; ")} }`;
  }
  return normalised(node, sf);
}

const PRIMITIVES = new Set(["string", "number", "boolean"]);

function typeRef(node: ts.TypeNode, sf: ts.SourceFile, concepts: ReadonlySet<string>): TypeRef {
  const text = typeText(node, sf);
  switch (node.kind) {
    case ts.SyntaxKind.StringKeyword:
      return { kind: "primitive", text, name: "string" };
    case ts.SyntaxKind.NumberKeyword:
      return { kind: "primitive", text, name: "number" };
    case ts.SyntaxKind.BooleanKeyword:
      return { kind: "primitive", text, name: "boolean" };
    case ts.SyntaxKind.VoidKeyword:
      return { kind: "void", text: "void" };
    default:
      break;
  }
  if (ts.isArrayTypeNode(node)) return { kind: "array", text, element: typeRef(node.elementType, sf, concepts) };
  if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword && ts.isArrayTypeNode(node.type)) {
    return { kind: "array", text, element: typeRef(node.type.elementType, sf, concepts) };
  }
  if (ts.isTypeLiteralNode(node)) {
    const fields: FieldModel[] = [];
    for (const member of node.members) {
      if (!ts.isPropertySignature(member) || member.type === undefined || !ts.isIdentifier(member.name)) {
        return { kind: "other", text };
      }
      fields.push({
        name: member.name.text,
        type: typeRef(member.type, sf, concepts),
        readonly: member.modifiers?.some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword) ?? false,
      });
    }
    return { kind: "object", text, fields };
  }
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
    const name = node.typeName.text;
    const args = node.typeArguments ?? [];
    if (args.length === 1 && name === "Result") return { kind: "result", text, value: typeRef(args[0]!, sf, concepts) };
    if (args.length === 1 && name === "Promise") return { kind: "promise", text, value: typeRef(args[0]!, sf, concepts) };
    if (args.length === 1 && (name === "Array" || name === "ReadonlyArray")) {
      return { kind: "array", text, element: typeRef(args[0]!, sf, concepts) };
    }
    if (args.length === 0 && concepts.has(name)) return { kind: "concept", text, name };
  }
  return { kind: "other", text };
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false);
}

/** The JSDoc blocks directly above a node, innermost last. */
function jsDocsOf(node: ts.Node): readonly ts.JSDoc[] {
  return ((node as { jsDoc?: readonly ts.JSDoc[] }).jsDoc ?? []);
}

function commentText(comment: string | ts.NodeArray<ts.JSDocComment> | undefined): string {
  if (comment === undefined) return "";
  if (typeof comment === "string") return comment;
  return comment.map((c) => c.text).join("");
}

/** A JSDoc block's summary: its text before the first tag, lines joined with
 *  single spaces, trimmed (the TN-26-012 §4 rule, applied to concepts). */
function summaryOf(node: ts.Node): string | undefined {
  const doc = jsDocsOf(node).at(-1);
  if (doc === undefined) return undefined;
  const text = commentText(doc.comment).replace(/\s+/g, " ").trim();
  return text === "" ? undefined : text;
}

/** One `@accepts` example, as TypeScript expression source. */
const ACCEPTS_LITERAL = /^(?:"(?:[^"\\\n]|\\.)*"|-?(?:0|[1-9]\d*)(?:\.\d+)?|true|false)$/;

/**
 * The `@accepts` examples on a value object's instance interface: literal
 * inputs its `parse` must accept, which the generated laws use as samples.
 * Each must be a JSON-style string, a decimal number or a boolean, so it is
 * valid TypeScript as written. Absent → []. The parser refuses a malformed
 * one rather than dropping it.
 */
export function acceptsExamplesOf(contractPath: string, source: string, name: string): readonly string[] {
  const sf = ts.createSourceFile(contractPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const instance = sf.statements.find(
    (s): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s) && s.name.text === name,
  );
  if (instance === undefined) return [];
  const out: string[] = [];
  for (const doc of jsDocsOf(instance)) {
    for (const tag of doc.tags ?? []) {
      if (tag.tagName.text !== "accepts") continue;
      // TypeScript reads `@accepts` as a tag even mid-sentence ("add an
      // @accepts tag"), so a tag counts only where a reader sees one: opening
      // its own line, or opening the comment. Anything with prose before it
      // on the line is prose.
      const start = tag.getStart(sf);
      const lineStart = source.lastIndexOf("\n", start - 1) + 1;
      if (!/^\s*(\/\*\*)?[\s*]*$/.test(source.slice(lineStart, start))) continue;
      const example = commentText(tag.comment).trim();
      if (!ACCEPTS_LITERAL.test(example)) {
        refuse(contractPath, `@accepts '${example}' on ${name} is not a literal — write a double-quoted string, a decimal number or true/false, e.g. @accepts "Website relaunch"`);
      }
      out.push(example);
    }
  }
  if (out.length === 0) return out;
  // An example is printed into the laws as a sample `parse` must accept, so
  // it must be a literal of the value's own type — and an entity has none.
  const value = instance.members.find(
    (m): m is ts.PropertySignature => ts.isPropertySignature(m) && ts.isIdentifier(m.name) && m.name.text === "value",
  );
  const valueType = value?.type === undefined ? undefined : value.type.getText(sf);
  if (valueType === undefined || !PRIMITIVES.has(valueType)) {
    refuse(contractPath, `@accepts on ${name} means nothing — only a value object (one 'readonly value' of a primitive) has a parse to accept it`);
  }
  const kindOf = (example: string): string =>
    example.startsWith('"') ? "string" : example === "true" || example === "false" ? "boolean" : "number";
  for (const example of out) {
    if (kindOf(example) !== valueType) {
      refuse(contractPath, `@accepts ${example} on ${name} is not a ${valueType} — ${name}.value is a ${valueType}, so each example is a ${valueType} literal`);
    }
  }
  return out;
}

function parameterOf(
  param: ts.ParameterDeclaration,
  sf: ts.SourceFile,
  concepts: ReadonlySet<string>,
  where: string,
  path: string,
): ParameterModel {
  if (!ts.isIdentifier(param.name) || param.type === undefined || param.questionToken !== undefined ||
      param.dotDotDotToken !== undefined || param.initializer !== undefined) {
    refuse(path, `${where} takes '${normalised(param, sf)}' — every parameter is a plain 'name: Type', not optional, rest or destructured`);
  }
  return { name: param.name.text, type: typeRef(param.type, sf, concepts) };
}

function methodOf(
  member: ts.MethodSignature,
  sf: ts.SourceFile,
  concepts: ReadonlySet<string>,
  owner: string,
  path: string,
): MethodModel {
  const name = ts.isIdentifier(member.name) ? member.name.text : refuse(path, `${owner} has a computed member name`);
  const where = `${owner}.${name}`;
  if (member.questionToken !== undefined) refuse(path, `${where} is optional — every member of a concept is required`);
  if (member.typeParameters !== undefined) refuse(path, `${where} is generic — a concept's members have concrete types`);
  if (member.type === undefined) refuse(path, `${where} has no return type — write it, e.g. '${name}(): boolean'`);
  return {
    name,
    parameters: member.parameters.map((p) => parameterOf(p, sf, concepts, where, path)),
    returns: typeRef(member.type, sf, concepts),
  };
}

function parseImports(sf: ts.SourceFile, path: string): ContractImport[] {
  const imports: ContractImport[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const specifier = (stmt.moduleSpecifier as ts.StringLiteral).text;
    const clause = stmt.importClause;
    const bindings = clause?.namedBindings;
    if (clause === undefined || !clause.isTypeOnly || clause.name !== undefined || bindings === undefined ||
        !ts.isNamedImports(bindings)) {
      refuse(path, `'${normalised(stmt, sf)}' — a domain contract imports only 'import type { … } from "…"'`);
    }
    if (!SIBLING_CONTRACT.test(specifier) && !AREA_CONTRACT.test(specifier) && specifier !== RESULT_SPECIFIER) {
      refuse(path, `imports from '${specifier}' — a domain contract imports only other domain contracts ('./<concept>.contract.ts', '../<area>/<concept>.contract.ts') and '${RESULT_SPECIFIER}'`);
    }
    const names: string[] = [];
    for (const element of bindings.elements) {
      if (element.propertyName !== undefined || element.isTypeOnly) {
        refuse(path, `'${normalised(element, sf)}' in the import from '${specifier}' — import each name as itself, with no alias and no inner 'type'`);
      }
      names.push(element.name.text);
    }
    if (names.length === 0) refuse(path, `the import from '${specifier}' names nothing — delete it`);
    if (specifier === RESULT_SPECIFIER && names.some((n) => n !== "Result")) {
      refuse(path, `'${RESULT_SPECIFIER}' exports only 'Result'`);
    }
    imports.push({ specifier, names });
  }
  const seen = new Set<string>();
  for (const name of imports.flatMap((i) => i.names)) {
    if (seen.has(name)) refuse(path, `'${name}' is imported twice`);
    seen.add(name);
  }
  return imports;
}

/**
 * Parse one domain concept contract. `contractPath` is project-relative and
 * must follow TN-26-012's layout; the file stem must be the kebab-case of the
 * concept name.
 */
export function parseDomainConcept(contractPath: string, source: string): DomainConceptModel {
  const match = DOMAIN_CONCEPT_PATH.exec(contractPath);
  if (match === null) {
    refuse(contractPath, "a domain concept contract lives at contexts/<context>/src/domain/<area>/<concept>.contract.ts, every segment kebab-case");
  }
  const [, context, area, stem] = match as unknown as [string, string, string, string];
  const name = pascalCase(stem);
  const factoryName = `${name}Factory`;
  const sf = ts.createSourceFile(contractPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  // `parseDiagnostics` is populated by createSourceFile but not in the public
  // type; a syntax error must refuse rather than yield a half-read model.
  const syntaxErrors = (sf as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics ?? [];
  if (syntaxErrors.length > 0) refuse(contractPath, "does not parse as TypeScript — fix the syntax first");

  const imports = parseImports(sf, contractPath);
  const imported = new Set(imports.flatMap((i) => i.names));
  if (imported.has(name) || imported.has(factoryName)) refuse(contractPath, `imports '${name}' — the concept is declared here`);

  let instance: ts.InterfaceDeclaration | undefined;
  let factory: ts.InterfaceDeclaration | undefined;
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) continue;
    if (!ts.isInterfaceDeclaration(stmt) || !hasModifier(stmt, ts.SyntaxKind.ExportKeyword) ||
        hasModifier(stmt, ts.SyntaxKind.DefaultKeyword)) {
      refuse(contractPath, `'${normalised(stmt, sf).slice(0, 60)}' — a domain contract declares exactly 'export interface ${name}' and 'export interface ${factoryName}', nothing else`);
    }
    const which = stmt.name.text === name ? "instance" : stmt.name.text === factoryName ? "factory" : undefined;
    if (which === undefined) {
      refuse(contractPath, `declares '${stmt.name.text}' — this file is '${stem}.contract.ts', so it declares exactly '${name}' and '${factoryName}' (the file stem is the kebab-case of the concept name; one concept per file)`);
    }
    if ((which === "instance" ? instance : factory) !== undefined) refuse(contractPath, `declares '${stmt.name.text}' twice`);
    if (stmt.typeParameters !== undefined || stmt.heritageClauses !== undefined) {
      refuse(contractPath, `'${stmt.name.text}' is generic or extends another type — a concept interface stands alone`);
    }
    if (which === "instance") instance = stmt;
    else factory = stmt;
  }
  if (instance === undefined) refuse(contractPath, `declares no 'export interface ${name}'`);
  if (factory === undefined) refuse(contractPath, `declares no 'export interface ${factoryName}' — the static side ('parse', 'generate' or 'new (...)') lives there`);

  const concepts = new Set([...imported, name]);

  // --- the instance side ------------------------------------------------------
  const [brand, ...rest] = instance.members;
  const brandOk = brand !== undefined && ts.isPropertySignature(brand) && ts.isIdentifier(brand.name) &&
    brand.name.text === "__brand" && hasModifier(brand, ts.SyntaxKind.ReadonlyKeyword) && brand.questionToken === undefined &&
    brand.type !== undefined && ts.isLiteralTypeNode(brand.type) && ts.isStringLiteral(brand.type.literal) &&
    brand.type.literal.text === name;
  if (!brandOk) refuse(contractPath, `${name}'s first member must be 'readonly __brand: "${name}";'`);

  const fields: FieldModel[] = [];
  const instanceMethods: MethodModel[] = [];
  const memberNames = new Set<string>(["__brand"]);
  for (const member of rest) {
    const memberName = member.name !== undefined && ts.isIdentifier(member.name) ? member.name.text : undefined;
    if (memberName === undefined) refuse(contractPath, `${name} has a member without a plain name: '${normalised(member, sf)}'`);
    if (memberNames.has(memberName)) refuse(contractPath, `${name}.${memberName} is declared twice — overloads are not part of a concept`);
    memberNames.add(memberName);
    if (ts.isPropertySignature(member)) {
      if (!hasModifier(member, ts.SyntaxKind.ReadonlyKeyword)) refuse(contractPath, `${name}.${memberName} must be readonly — a concept never changes after it is built`);
      if (member.questionToken !== undefined || member.type === undefined) {
        refuse(contractPath, `${name}.${memberName} must be a required, typed field`);
      }
      fields.push({ name: memberName, type: typeRef(member.type, sf, concepts), readonly: true });
    } else if (ts.isMethodSignature(member)) {
      instanceMethods.push(methodOf(member, sf, concepts, name, contractPath));
    } else {
      refuse(contractPath, `${name}.${memberName} is not a field or a method — accessors, index and call signatures are not part of a concept`);
    }
  }

  const equals = instanceMethods.find((m) => m.name === "equals");
  if (equals === undefined || equals.parameters.length !== 1 || equals.parameters[0]!.type.text !== name ||
      equals.returns.text !== "boolean") {
    refuse(contractPath, `${name} needs 'equals(other: ${name}): boolean;'`);
  }
  const toJSON = instanceMethods.find((m) => m.name === "toJSON");
  if (toJSON === undefined || toJSON.parameters.length !== 0) {
    refuse(contractPath, `${name} needs 'toJSON(): <wire form>;' with no parameters`);
  }

  // --- the static side ----------------------------------------------------------
  const factoryMembers: FactoryMember[] = [];
  for (const member of factory.members) {
    if (ts.isConstructSignatureDeclaration(member)) {
      if (member.type === undefined || normalised(member.type, sf) !== name || member.typeParameters !== undefined) {
        refuse(contractPath, `${factoryName}'s construct signature must return '${name}': 'new (…): ${name};'`);
      }
      factoryMembers.push({
        kind: "construct",
        parameters: member.parameters.map((p) => parameterOf(p, sf, concepts, `new ${name}`, contractPath)),
      });
    } else if (ts.isMethodSignature(member)) {
      factoryMembers.push({ kind: "method", ...methodOf(member, sf, concepts, factoryName, contractPath) });
    } else {
      refuse(contractPath, `${factoryName} has '${normalised(member, sf)}' — a factory holds 'parse', 'generate' or one 'new (…)'`);
    }
  }

  const constructs = factoryMembers.filter((m) => m.kind === "construct");
  const methods = factoryMembers.filter((m): m is Extract<FactoryMember, { kind: "method" }> => m.kind === "method");
  let kind: ConceptKind;

  if (constructs.length > 0) {
    kind = "entity";
    if (constructs.length > 1 || methods.length > 0) {
      refuse(contractPath, `${factoryName} of an entity holds exactly one 'new (…): ${name};' and nothing else — entities are built from already-valid value objects, so they have no 'parse'`);
    }
    const construct = constructs[0]!;
    const expected = fields.map((f) => `${f.name}: ${f.type.text}`).join(", ");
    const actual = construct.parameters.map((p) => `${p.name}: ${p.type.text}`).join(", ");
    if (fields.length === 0 || expected !== actual) {
      refuse(contractPath, `new (${actual}) must take ${name}'s fields in declaration order: 'new (${expected}): ${name};'`);
    }
    if (fields[0]!.name !== "id") refuse(contractPath, `${name}'s first field must be its identity, 'readonly id: <Name>Id;'`);
    for (const field of fields) {
      if (field.type.kind !== "concept" || field.type.name === name) {
        refuse(contractPath, `${name}.${field.name} is '${field.type.text}' — an entity holds imported value objects and identifiers only`);
      }
    }
    const json = toJSON.returns;
    const jsonOk = json.kind === "object" && json.fields.length === fields.length &&
      json.fields.every((f, i) => f.readonly && f.name === fields[i]!.name && f.type.kind === "primitive");
    if (!jsonOk) {
      const shape = fields.map((f) => `readonly ${f.name}: string`).join("; ");
      refuse(contractPath, `${name}.toJSON must return one readonly primitive per field, in field order, e.g. 'toJSON(): { ${shape} };'`);
    }
  } else {
    const parse = methods.find((m) => m.name === "parse");
    const generate = methods.find((m) => m.name === "generate");
    const extra = methods.filter((m) => m.name !== "parse" && m.name !== "generate");
    if (extra.length > 0) {
      refuse(contractPath, `${factoryName}.${extra[0]!.name} — a value object's factory holds 'parse' and, for an identifier, 'generate'`);
    }
    const parseOk = parse !== undefined && parse.parameters.length === 1 && parse.parameters[0]!.name === "raw" &&
      parse.parameters[0]!.type.text === "unknown" && parse.returns.kind === "result" &&
      parse.returns.value.text === name && imported.has("Result");
    if (!parseOk) {
      refuse(contractPath, `${factoryName} needs 'parse(raw: unknown): Result<${name}>;' with 'import type { Result } from "${RESULT_SPECIFIER}";' — or 'new (…): ${name};' for an entity`);
    }
    if (generate !== undefined && (generate.parameters.length !== 0 || generate.returns.text !== name)) {
      refuse(contractPath, `${factoryName}.generate must be 'generate(): ${name};'`);
    }
    kind = generate === undefined ? "value-object" : "identifier";
    const [value, ...others] = fields;
    if (value === undefined || value.name !== "value" || value.type.kind !== "primitive" || others.length > 0) {
      refuse(contractPath, `a value object holds exactly one field, 'readonly value: string | number | boolean' — ${name} has ${fields.map((f) => `'${f.name}: ${f.type.text}'`).join(", ") || "none"}`);
    }
    if (toJSON.returns.text !== value.type.text) {
      refuse(contractPath, `${name}.toJSON must return its wire form, the type of 'value': 'toJSON(): ${value.type.text};'`);
    }
  }

  const doc = summaryOf(instance);
  return {
    kind,
    name,
    stem,
    context,
    area,
    contractPath,
    implementationPath: implementationPathOf(contractPath),
    ...(doc === undefined ? {} : { doc }),
    fields,
    instanceMethods,
    factoryMembers,
    imports,
  };
}

/** The base primitive of a value object's `value` field. */
export function valueTypeOf(model: DomainConceptModel): "string" | "number" | "boolean" {
  const value = model.fields.find((f) => f.name === "value");
  if (value?.type.kind !== "primitive" || !PRIMITIVES.has(value.type.name)) {
    throw new DomainConceptError(`${model.contractPath}: ${model.name} has no primitive 'value' field`);
  }
  return value.type.name;
}
