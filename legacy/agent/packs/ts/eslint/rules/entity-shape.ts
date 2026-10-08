import { ESLintUtils, TSESTree } from "@typescript-eslint/utils";
import { conceptPairs, importedNames, inDomainLayer, isBrandFor, memberName, PRIMITIVE_KEYWORDS, textOf } from "./concept-pairs.ts";

// ADR LEG-2026-059 contract rule: an entity's contract is the worked example's
// pair, built only from already-valid value objects and equal by identity.
//
//   export interface Note {
//     readonly __brand: "Note";
//     readonly id: NoteId;
//     readonly projectId: ProjectId;
//     readonly text: NoteText;
//     equals(other: Note): boolean;
//     toJSON(): { readonly id: string; readonly projectId: string; readonly text: string };
//   }
//
//   export interface NoteFactory {
//     new (id: NoteId, projectId: ProjectId, text: NoteText): Note;
//   }
//
// What the rule holds, and who relies on it:
//
// * The factory has exactly one construct signature and nothing else. An
//   entity is built from values that are already valid, so it has no `parse`.
// * The construct parameters ARE the fields: same names, same types, same
//   order. The emitter writes the constructor as parameter properties from
//   them (`constructor(readonly id: NoteId, …) {}`), so a mismatch would be
//   a skeleton that does not implement its contract.
// * The first field is the identity, `id`: the generated laws check equality
//   by identity against it, and toJSON's id against its identifier.
// * Every field is a named concept (a type reference): an entity holds value
//   objects and other entities' ids, never a naked primitive.
// * `toJSON()` returns one readonly primitive per field, in field order: the
//   wire shape the laws compare to each field's own `toJSON()`.
//
// Scope: a `<Name>` + `<Name>Factory` pair whose factory has a construct
// signature. File naming and one-concept-per-file are `value-object-shape`'s.

type MessageId = "brand" | "construct" | "factoryMember" | "fields" | "identity" | "fieldType" | "equals" | "toJSON" | "member";

const MODEL = "An entity's contract is 'interface <Name>' plus 'interface <Name>Factory { new (…): <Name>; }' (ADR LEG-2026-059, ts-contract-authoring).";

const createRule = ESLintUtils.RuleCreator.withoutDocs;

export const entityShape = createRule<[], MessageId>({
  name: "entity-shape",
  meta: {
    type: "problem",
    schema: [],
    messages: {
      brand: `${MODEL} '{{name}}' must open with its brand, exactly 'readonly __brand: "{{name}}";'.`,
      construct: `${MODEL} '{{name}}Factory' must hold exactly one 'new ({{params}}): {{name}};' — the construct parameters are the fields, in the same order with the same names and types, because the generated constructor declares them as its fields.`,
      factoryMember: `${MODEL} '{{name}}Factory' of an entity holds only its 'new (…)' — '{{member}}' does not belong there. An entity is built from already-valid value objects, so it has no 'parse'; behaviour goes on the instance interface.`,
      fields: `${MODEL} '{{name}}' declares no fields — an entity holds at least its identity, 'readonly id: {{name}}Id;'.`,
      identity: `${MODEL} '{{name}}''s first field must be its identity, 'readonly id: <Name>Id;' — the generated laws check equality by identity against it.`,
      fieldType: `${MODEL} '{{name}}.{{field}}' is '{{type}}' — an entity field is 'readonly', required, and typed by an imported value object or identifier (another entity is referred to by its id), never a primitive, literal, array or local type.`,
      equals: `${MODEL} '{{name}}' needs 'equals(other: {{name}}): boolean;' — entities are equal by identity.`,
      toJSON: `${MODEL} '{{name}}' needs 'toJSON(): {{shape}};' — one readonly primitive per field, in field order: the wire shape.`,
      member: `${MODEL} '{{name}}' has '{{member}}', which is not a field or a method — accessors, index and call signatures are not part of an entity.`,
    },
  },
  defaultOptions: [],
  create(context) {
    const source = context.sourceCode.getText();
    return {
      Program(program) {
        const imported = importedNames(program);
        for (const pair of conceptPairs(program, inDomainLayer(context.filename))) {
          if (pair.kind !== "entity") continue;
          const { name, instance, factory } = pair;
          const members = instance.body.body;
          if (!isBrandFor(members[0], name)) {
            context.report({ node: members[0] ?? instance.id, messageId: "brand", data: { name } });
          }
          const fields: TSESTree.TSPropertySignature[] = [];
          const methods: TSESTree.TSMethodSignature[] = [];
          for (const member of members.slice(isBrandFor(members[0], name) ? 1 : 0)) {
            if (member.type === TSESTree.AST_NODE_TYPES.TSPropertySignature) {
              if (memberName(member) !== "__brand") fields.push(member);
            } else if (member.type === TSESTree.AST_NODE_TYPES.TSMethodSignature && member.kind === "method") {
              methods.push(member);
            } else {
              context.report({ node: member, messageId: "member", data: { name, member: textOf(source, member) } });
            }
          }

          if (fields.length === 0) context.report({ node: instance.id, messageId: "fields", data: { name } });
          else if (memberName(fields[0]!) !== "id") context.report({ node: fields[0]!, messageId: "identity", data: { name } });
          for (const field of fields) {
            const type = field.typeAnnotation?.typeAnnotation;
            const ok = field.readonly && !field.optional && type?.type === TSESTree.AST_NODE_TYPES.TSTypeReference &&
              type.typeName.type === TSESTree.AST_NODE_TYPES.Identifier && type.typeArguments === undefined &&
              type.typeName.name !== name &&
              // an imported concept: a field's type the file does not import
              // is one the emitter cannot resolve to a concept
              imported.has(type.typeName.name);
            if (!ok) {
              context.report({
                node: field,
                messageId: "fieldType",
                data: { name, field: memberName(field) ?? "?", type: textOf(source, type) || "(untyped)" },
              });
            }
          }

          const fieldList = fields.map((f) => `${memberName(f) ?? "?"}: ${textOf(source, f.typeAnnotation?.typeAnnotation)}`);
          const constructs = factory.body.body.filter(
            (m): m is TSESTree.TSConstructSignatureDeclaration => m.type === TSESTree.AST_NODE_TYPES.TSConstructSignatureDeclaration,
          );
          for (const member of factory.body.body) {
            if (member.type !== TSESTree.AST_NODE_TYPES.TSConstructSignatureDeclaration) {
              context.report({ node: member, messageId: "factoryMember", data: { name, member: memberName(member) ?? textOf(source, member) } });
            }
          }
          constructs.forEach((construct, index) => {
            const params = construct.params.map((p) =>
              p.type === TSESTree.AST_NODE_TYPES.Identifier && !p.optional
                ? `${p.name}: ${textOf(source, p.typeAnnotation?.typeAnnotation)}`
                : `(${textOf(source, p)})`,
            );
            const ok = index === 0 && params.join(", ") === fieldList.join(", ") &&
              textOf(source, construct.returnType?.typeAnnotation) === name;
            if (!ok) context.report({ node: construct, messageId: "construct", data: { name, params: fieldList.join(", ") } });
          });

          const equals = methods.find((m) => memberName(m) === "equals");
          const equalsParam = equals?.params[0];
          const equalsOk = equals !== undefined && equals.params.length === 1 && equalsParam?.type === TSESTree.AST_NODE_TYPES.Identifier &&
            textOf(source, equalsParam.typeAnnotation?.typeAnnotation) === name &&
            textOf(source, equals.returnType?.typeAnnotation) === "boolean";
          if (!equalsOk) context.report({ node: equals ?? instance.id, messageId: "equals", data: { name } });

          const shape = `{ ${fields.map((f) => `readonly ${memberName(f) ?? "?"}: string`).join("; ")} }`;
          const toJSON = methods.find((m) => memberName(m) === "toJSON");
          const returned = toJSON?.returnType?.typeAnnotation;
          const toJSONOk = toJSON !== undefined && toJSON.params.length === 0 &&
            returned?.type === TSESTree.AST_NODE_TYPES.TSTypeLiteral && returned.members.length === fields.length &&
            returned.members.every((m, i) =>
              m.type === TSESTree.AST_NODE_TYPES.TSPropertySignature && m.readonly && !m.optional &&
              memberName(m) === memberName(fields[i]!) && PRIMITIVE_KEYWORDS.has(textOf(source, m.typeAnnotation?.typeAnnotation)),
            );
          if (!toJSONOk) context.report({ node: toJSON ?? instance.id, messageId: "toJSON", data: { name, shape } });
        }
      },
    };
  },
});
