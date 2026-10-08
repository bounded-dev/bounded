import { TSESTree } from "@typescript-eslint/utils";

// Shared reading of the ADR LEG-2026-059 contract form for the concept rules
// (value-object-shape, entity-shape, value-object-documented,
// no-naked-primitives). A CONCEPT is a pair of exported interfaces in one
// contract file:
//
//   export interface <Name> { readonly __brand: "<Name>"; … }   instance side
//   export interface <Name>Factory { … }                          static side
//
// The factory decides the kind: a construct signature (`new (…): Name`) makes
// an entity; otherwise it is a value object (an identifier when it also has
// `generate()`). A `<X>Command` pair beside a `<X>Input` interface is an
// application command: its shape belongs to the feature parser, not to these
// rules, so it is reported as kind "command" and the domain rules skip it.

export type ConceptKind = "value-object" | "entity" | "command";

export interface ConceptPair {
  readonly name: string;
  readonly kind: ConceptKind;
  readonly instance: TSESTree.TSInterfaceDeclaration;
  readonly factory: TSESTree.TSInterfaceDeclaration;
}

/** Exported interfaces of a program, by name (first declaration wins). */
export function exportedInterfaces(program: TSESTree.Program): Map<string, TSESTree.TSInterfaceDeclaration> {
  const out = new Map<string, TSESTree.TSInterfaceDeclaration>();
  for (const stmt of program.body) {
    if (stmt.type !== TSESTree.AST_NODE_TYPES.ExportNamedDeclaration) continue;
    const decl = stmt.declaration;
    if (decl?.type === TSESTree.AST_NODE_TYPES.TSInterfaceDeclaration && !out.has(decl.id.name)) {
      out.set(decl.id.name, decl);
    }
  }
  return out;
}

/** Does this interface declare a `__brand` property (in any form)? */
export function brandMember(node: TSESTree.TSInterfaceDeclaration): TSESTree.TSPropertySignature | undefined {
  return node.body.body.find(
    (m): m is TSESTree.TSPropertySignature =>
      m.type === TSESTree.AST_NODE_TYPES.TSPropertySignature &&
      m.key.type === TSESTree.AST_NODE_TYPES.Identifier &&
      m.key.name === "__brand",
  );
}

/** Is this contract in a hexagonal domain layer (a `domain/` directory)?
 *  There every pair is a domain concept: an application command belongs in
 *  `application/`, so `<X>Command` beside `<X>Input` gets no exemption. */
export function inDomainLayer(filename: string): boolean {
  return filename.replace(/\\/g, "/").split("/").includes("domain");
}

/** Local names bound by the file's import declarations, by source. */
export function importedNames(program: TSESTree.Program): Map<string, string> {
  const out = new Map<string, string>();
  for (const stmt of program.body) {
    if (stmt.type !== TSESTree.AST_NODE_TYPES.ImportDeclaration) continue;
    for (const spec of stmt.specifiers) out.set(spec.local.name, stmt.source.value);
  }
  return out;
}

/** Names the file declares itself (interfaces, type aliases, classes…). */
export function localTypeNames(program: TSESTree.Program): Set<string> {
  const out = new Set<string>();
  const visit = (node: TSESTree.Node): void => {
    if (
      (node.type === TSESTree.AST_NODE_TYPES.TSInterfaceDeclaration ||
        node.type === TSESTree.AST_NODE_TYPES.TSTypeAliasDeclaration ||
        node.type === TSESTree.AST_NODE_TYPES.TSEnumDeclaration ||
        node.type === TSESTree.AST_NODE_TYPES.ClassDeclaration) &&
      node.id !== null
    ) {
      out.add(node.id.name);
    }
    if (node.type === TSESTree.AST_NODE_TYPES.ExportNamedDeclaration && node.declaration) visit(node.declaration);
    if (node.type === TSESTree.AST_NODE_TYPES.TSModuleDeclaration && node.body?.type === TSESTree.AST_NODE_TYPES.TSModuleBlock) {
      node.body.body.forEach(visit);
    }
  };
  program.body.forEach(visit);
  return out;
}

/** One structural defect in a concept pair, as the parser would refuse it. */
export interface ShapeProblem {
  readonly node: TSESTree.Node;
  readonly what: string;
}

/**
 * The structural refusals the domain-concept parser makes of any concept, so
 * lint-passing implies emittable: a generic or extending interface; an
 * optional, duplicated (overloaded), computed or string-keyed member; a
 * generic method, one without a return type, and a parameter that is not a
 * plain required `name: Type`.
 */
export function structuralProblems(pair: ConceptPair, source: string): ShapeProblem[] {
  const out: ShapeProblem[] = [];
  for (const iface of [pair.instance, pair.factory]) {
    if (iface.typeParameters !== undefined) {
      out.push({ node: iface.id, what: `'${iface.id.name}' is generic — a concept interface has no type parameters` });
    }
    if (iface.extends.length > 0) {
      out.push({ node: iface.id, what: `'${iface.id.name}' extends ${iface.extends.map((e) => textOf(source, e)).join(", ")} — a concept interface stands alone, so every member is declared here and the emitter sees it` });
    }
    const seen = new Set<string>();
    for (const member of iface.body.body) {
      if (member.type === TSESTree.AST_NODE_TYPES.TSConstructSignatureDeclaration) {
        out.push(...parameterProblems(member.params, `new ${pair.name}`, source));
        continue;
      }
      if (member.type !== TSESTree.AST_NODE_TYPES.TSPropertySignature && member.type !== TSESTree.AST_NODE_TYPES.TSMethodSignature) {
        continue; // accessors, index and call signatures: each rule's own 'member' report
      }
      const name = memberName(member);
      if (name === undefined) {
        out.push({ node: member, what: `'${textOf(source, member)}' has no plain name — every member is 'name: Type' or 'name(…): Type'` });
        continue;
      }
      const where = `${iface.id.name}.${name}`;
      if (seen.has(name)) out.push({ node: member, what: `${where} is declared twice — overloads are not part of a concept` });
      seen.add(name);
      if (member.optional) out.push({ node: member, what: `${where} is optional — every member of a concept is required` });
      if (member.type === TSESTree.AST_NODE_TYPES.TSMethodSignature && member.kind === "method") {
        if (member.typeParameters !== undefined) out.push({ node: member, what: `${where} is generic — a concept's members have concrete types` });
        if (member.returnType === undefined) out.push({ node: member, what: `${where} has no return type — write it` });
        out.push(...parameterProblems(member.params, where, source));
      }
    }
  }
  return out;
}

function parameterProblems(params: readonly TSESTree.Parameter[], where: string, source: string): ShapeProblem[] {
  return params
    .filter((p) => p.type !== TSESTree.AST_NODE_TYPES.Identifier || p.optional || p.typeAnnotation === undefined)
    .map((p) => ({ node: p, what: `${where} takes '${textOf(source, p)}' — every parameter is a plain required 'name: Type'` }));
}

/** Every concept pair in the file, in source order of the instance side. In
 *  a domain layer (`domain` true) no pair is an application command. */
export function conceptPairs(program: TSESTree.Program, domain = false): ConceptPair[] {
  const interfaces = exportedInterfaces(program);
  const out: ConceptPair[] = [];
  for (const [name, instance] of interfaces) {
    const factory = interfaces.get(`${name}Factory`);
    if (factory === undefined) continue;
    const hasConstruct = factory.body.body.some((m) => m.type === TSESTree.AST_NODE_TYPES.TSConstructSignatureDeclaration);
    const isCommand = !domain && name.endsWith("Command") && name.length > "Command".length &&
      interfaces.has(`${name.slice(0, -"Command".length)}Input`);
    out.push({ name, instance, factory, kind: hasConstruct ? "entity" : isCommand ? "command" : "value-object" });
  }
  return out.sort((a, b) => a.instance.range[0] - b.instance.range[0]);
}

/** A member's plain name, or undefined for computed/string keys. */
export function memberName(member: TSESTree.TypeElement): string | undefined {
  if (!("key" in member) || member.computed) return undefined;
  return member.key.type === TSESTree.AST_NODE_TYPES.Identifier ? member.key.name : undefined;
}

/** Is `node` exactly `readonly __brand: "<name>"`? */
export function isBrandFor(member: TSESTree.TypeElement | undefined, name: string): boolean {
  if (member?.type !== TSESTree.AST_NODE_TYPES.TSPropertySignature) return false;
  if (memberName(member) !== "__brand" || !member.readonly || member.optional) return false;
  const type = member.typeAnnotation?.typeAnnotation;
  return type?.type === TSESTree.AST_NODE_TYPES.TSLiteralType &&
    type.literal.type === TSESTree.AST_NODE_TYPES.Literal && type.literal.value === name;
}

/** kebab-case of a PascalCase concept name: `NoteId` → `note-id`. */
export function kebabOf(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/** The concept stem a contract file name carries (`note-id.contract.ts` →
 *  `note-id`), or undefined when the file is not a contract (a test's
 *  default file name). */
export function contractStemOf(filename: string): string | undefined {
  const base = filename.replace(/\\/g, "/").split("/").pop() ?? "";
  return base.endsWith(".contract.ts") ? base.slice(0, -".contract.ts".length) : undefined;
}

/** Type text, whitespace-collapsed, for comparing signatures. */
export function textOf(source: string, node: TSESTree.Node | undefined): string {
  return node === undefined ? "" : source.slice(node.range[0], node.range[1]).replace(/\s+/g, " ").trim();
}

export const PRIMITIVE_KEYWORDS: ReadonlySet<string> = new Set(["string", "number", "boolean"]);
