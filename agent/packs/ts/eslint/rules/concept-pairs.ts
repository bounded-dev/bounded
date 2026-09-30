import { TSESTree } from "@typescript-eslint/utils";

// Shared reading of the ADR 2026-059 contract form for the concept rules
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

/** Every concept pair in the file, in source order of the instance side. */
export function conceptPairs(program: TSESTree.Program): ConceptPair[] {
  const interfaces = exportedInterfaces(program);
  const out: ConceptPair[] = [];
  for (const [name, instance] of interfaces) {
    const factory = interfaces.get(`${name}Factory`);
    if (factory === undefined) continue;
    const hasConstruct = factory.body.body.some((m) => m.type === TSESTree.AST_NODE_TYPES.TSConstructSignatureDeclaration);
    const isCommand = name.endsWith("Command") && name.length > "Command".length &&
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
