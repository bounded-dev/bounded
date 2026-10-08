import { ESLintUtils, TSESTree } from "@typescript-eslint/utils";
import {
  brandMember,
  conceptPairs,
  contractStemOf,
  exportedInterfaces,
  importedNames,
  inDomainLayer,
  isBrandFor,
  kebabOf,
  localTypeNames,
  memberName,
  PRIMITIVE_KEYWORDS,
  structuralProblems,
  textOf,
} from "./concept-pairs.ts";

// ADR LEG-2026-059 contract rule: a value object's contract is the worked
// example's "contract owns the name" pair, and nothing looser.
//
//   import type { Result } from "../shared/result.ts";
//
//   export interface ProjectName {                 // the instance side
//     readonly __brand: "ProjectName";
//     readonly value: string;
//     equals(other: ProjectName): boolean;
//     toJSON(): string;
//   }
//
//   export interface ProjectNameFactory {          // the static side
//     parse(raw: unknown): Result<ProjectName>;
//     generate(): ProjectName;                      // identifiers only
//   }
//
// Every part is load-bearing downstream, and each is invisible on review:
//
// * The brand (`readonly __brand: "<Name>"`, first member) stops an object
//   literal passing as the value object; a brand string that differs from
//   the name silently gives two unrelated types.
// * `parse(raw: unknown): Result<Name>` is the only door in. `unknown`, so
//   the generated laws can hand it hostile input; `Result`, so a refusal
//   carries a reason instead of an `undefined` (the retired ADR LEG-2026-015
//   form).
// * Exactly one field, `readonly value`, of a primitive, and `toJSON()`
//   returning that primitive: the laws assert toJSON round-trips through
//   parse, and the emitter writes the private constructor from the fields.
// * The factory holds `parse` and, for an identifier, `generate()` — and
//   nothing else, because the emitter turns every factory member into a
//   static on `<Name>Impl`.
//
// SCOPE: a pair of exported interfaces `<Name>` + `<Name>Factory` whose
// factory has no construct signature (those are entities: `entity-shape`)
// and that is not an application command (`<X>Command` beside `<X>Input`,
// whose shape is the feature parser's). A branded interface with no factory
// is reported too: it claims to be a concept and has no door in. One concept
// per contract file, and the file stem is the kebab-case of its name, for
// every concept kind: the emitter derives `<concept>.ts` from it.
//
// Messages are written for an agent reader: each names the defect and the
// exact declaration to write instead.

type MessageId =
  | "missingFactory"
  | "brand"
  | "valueField"
  | "mutableField"
  | "equals"
  | "toJSON"
  | "parse"
  | "generate"
  | "factoryMember"
  | "fileName"
  | "oneConceptPerFile"
  | "member"
  | "shape"
  | "domainFile"
  | "resultSource";

const MODEL = "A value object's contract is 'interface <Name>' plus 'interface <Name>Factory' (ADR LEG-2026-059, ts-contract-authoring).";

const createRule = ESLintUtils.RuleCreator.withoutDocs;

export const valueObjectShape = createRule<[], MessageId>({
  name: "value-object-shape",
  meta: {
    type: "problem",
    schema: [],
    messages: {
      missingFactory: `${MODEL} '{{name}}' carries a '__brand' but this file declares no 'export interface {{name}}Factory' — add it with the only door in: 'export interface {{name}}Factory { parse(raw: unknown): Result<{{name}}>; }' (identifiers add 'generate(): {{name}};', entities declare 'new (…): {{name}};' instead).`,
      brand: `${MODEL} '{{name}}' must open with its brand, exactly 'readonly __brand: "{{name}}";' — the brand stops an object literal passing as the value object, and a brand string that differs from the name silently makes two unrelated types.`,
      valueField: `${MODEL} '{{name}}' holds exactly one field, 'readonly value: string' (or number, or boolean) — found {{found}}. A value object wraps one primitive; a concept holding other concepts is an entity ('new (…)' on the factory).`,
      mutableField: `${MODEL} '{{name}}.{{field}}' must be 'readonly' — a value object never changes after parse.`,
      equals: `${MODEL} '{{name}}' needs 'equals(other: {{name}}): boolean;' — equality is by value, and the generated laws check it.`,
      toJSON: `${MODEL} '{{name}}' needs 'toJSON(): {{type}};' — the wire form, the type of 'value', which the generated laws round-trip through parse.`,
      parse: `${MODEL} '{{name}}Factory' needs exactly 'parse(raw: unknown): Result<{{name}}>;' — 'unknown' so it can be handed any input, 'Result' so a refusal carries its reason (import type { Result } from "../shared/result.ts"). The retired form 'T | undefined' throws the reason away.`,
      generate: `${MODEL} '{{name}}Factory.generate' must be exactly 'generate(): {{name}};' — it makes a fresh identifier.`,
      factoryMember: `${MODEL} '{{name}}Factory' holds 'parse' and, for an identifier, 'generate()' — '{{member}}' does not belong there. Behaviour goes on the instance interface; a concept built from other concepts is an entity ('new (…): {{name}};').`,
      fileName: `A concept's contract file is named after it: '{{name}}' lives in '{{stem}}.contract.ts', because the emitter derives '{{stem}}.ts' and '{{stem}}.laws.test.ts' from the file name. Rename the file or the concept.`,
      member: `${MODEL} '{{name}}' has '{{member}}', which is not a field or a method — accessors, index and call signatures are not part of a value object; derived values are methods.`,
      shape: `${MODEL} {{what}}. The emitter writes every member into '<Name>Impl', so the contract must say exactly what that class holds.`,
      domainFile: `A domain contract declares exactly one concept, named after its file: '{{stem}}.contract.ts' holds 'export interface {{name}}' and 'export interface {{name}}Factory', its imports, and nothing else — found {{found}}. Another type goes in its own contract (a value object) or in an application contract (an input, a command, a port).`,
      resultSource: `${MODEL} 'Result' in '{{name}}Factory.parse' must be the shared one — 'import type { Result } from "../shared/result.ts";' — {{found}}. A local or differently sourced 'Result' makes 'parse' return something the generated laws and every caller misread.`,
      oneConceptPerFile: `One concept per contract file: '{{name}}' is a second concept here. Move it to its own '{{stem}}.contract.ts' and import it with 'import type { {{name}} } from "./{{stem}}.contract.ts";'.`,
    },
  },
  defaultOptions: [],
  create(context) {
    const source = context.sourceCode.getText();
    return {
      Program(program) {
        const domain = inDomainLayer(context.filename);
        const pairs = conceptPairs(program, domain);
        const stem = contractStemOf(context.filename);
        const domainPairs = pairs.filter((p) => p.kind !== "command");
        const imported = importedNames(program);
        const locals = localTypeNames(program);

        // A domain contract is one concept and nothing else (the parser's
        // grammar), so every other declaration is refused here first.
        if (domain && stem !== undefined && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(stem)) {
          const name = stem.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
          for (const stmt of program.body) {
            if (stmt.type === TSESTree.AST_NODE_TYPES.ImportDeclaration) {
              for (const spec of stmt.specifiers) {
                if (spec.local.name === name || spec.local.name === `${name}Factory`) {
                  context.report({ node: spec, messageId: "domainFile", data: { stem, name, found: `an import of '${spec.local.name}', which this file declares` } });
                }
              }
              continue;
            }
            const decl = stmt.type === TSESTree.AST_NODE_TYPES.ExportNamedDeclaration ? stmt.declaration : undefined;
            // A concept pair under the wrong name is `fileName` /
            // `oneConceptPerFile`'s to report; everything else is refused here.
            const pairInterface = decl?.type === TSESTree.AST_NODE_TYPES.TSInterfaceDeclaration &&
              pairs.some((p) => p.kind !== "command" && (p.instance === decl || p.factory === decl));
            const ok = pairInterface || (decl?.type === TSESTree.AST_NODE_TYPES.TSInterfaceDeclaration &&
              (decl.id.name === name || decl.id.name === `${name}Factory`));
            if (!ok) {
              context.report({ node: stmt, messageId: "domainFile", data: { stem, name, found: `'${textOf(source, stmt).slice(0, 60)}'` } });
            }
          }
          const names = [...program.body].flatMap((st) => st.type === TSESTree.AST_NODE_TYPES.ImportDeclaration ? st.specifiers.map((sp) => sp.local.name) : []);
          const twice = names.find((n, i) => names.indexOf(n) !== i);
          if (twice !== undefined) {
            context.report({ node: program, messageId: "domainFile", data: { stem, name, found: `'${twice}' imported twice` } });
          }
        }

        for (const pair of domainPairs) {
          for (const problem of structuralProblems(pair, source)) {
            context.report({ node: problem.node, messageId: "shape", data: { what: problem.what } });
          }
        }

        domainPairs.forEach((pair, index) => {
          if (index > 0) {
            context.report({ node: pair.instance.id, messageId: "oneConceptPerFile", data: { name: pair.name, stem: kebabOf(pair.name) } });
          } else if (stem !== undefined && stem !== kebabOf(pair.name)) {
            context.report({ node: pair.instance.id, messageId: "fileName", data: { name: pair.name, stem: kebabOf(pair.name) } });
          }
        });

        // A branded interface with no factory claims to be a concept.
        const paired = new Set(pairs.map((p) => p.name));
        for (const [name, iface] of exportedInterfaces(program)) {
          if (!paired.has(name) && brandMember(iface) !== undefined) {
            context.report({ node: iface.id, messageId: "missingFactory", data: { name } });
          }
        }

        for (const pair of domainPairs) {
          if (pair.kind !== "value-object") continue;
          const { name, instance, factory } = pair;
          const members = instance.body.body;
          if (!isBrandFor(members[0], name)) {
            context.report({ node: members[0] ?? instance.id, messageId: "brand", data: { name } });
          }

          const fields = members.filter(
            (m): m is TSESTree.TSPropertySignature =>
              m.type === TSESTree.AST_NODE_TYPES.TSPropertySignature && memberName(m) !== "__brand",
          );
          for (const field of fields) {
            if (!field.readonly) {
              context.report({ node: field, messageId: "mutableField", data: { name, field: memberName(field) ?? "?" } });
            }
          }
          const value = fields[0];
          const valueType = value?.typeAnnotation?.typeAnnotation;
          const valueTypeText = textOf(source, valueType);
          if (fields.length !== 1 || memberName(value!) !== "value" || value!.optional || !PRIMITIVE_KEYWORDS.has(valueTypeText)) {
            const found = fields.length === 0 ? "no field" : fields.map((f) => `'${textOf(source, f)}'`).join(", ");
            context.report({ node: value ?? instance.id, messageId: "valueField", data: { name, found } });
          }

          for (const member of members) {
            const plain = member.type === TSESTree.AST_NODE_TYPES.TSPropertySignature ||
              (member.type === TSESTree.AST_NODE_TYPES.TSMethodSignature && member.kind === "method");
            if (!plain) context.report({ node: member, messageId: "member", data: { name, member: textOf(source, member) } });
          }
          const methods = members.filter(
            (m): m is TSESTree.TSMethodSignature => m.type === TSESTree.AST_NODE_TYPES.TSMethodSignature && m.kind === "method",
          );
          const equals = methods.find((m) => memberName(m) === "equals");
          const equalsOk = equals !== undefined && equals.params.length === 1 &&
            textOf(source, (equals.params[0] as TSESTree.Identifier).typeAnnotation?.typeAnnotation) === name &&
            textOf(source, equals.returnType?.typeAnnotation) === "boolean";
          if (!equalsOk) context.report({ node: equals ?? instance.id, messageId: "equals", data: { name } });

          const toJSON = methods.find((m) => memberName(m) === "toJSON");
          const jsonType = PRIMITIVE_KEYWORDS.has(valueTypeText) ? valueTypeText : "string";
          if (toJSON === undefined || toJSON.params.length !== 0 || textOf(source, toJSON.returnType?.typeAnnotation) !== jsonType) {
            context.report({ node: toJSON ?? instance.id, messageId: "toJSON", data: { name, type: jsonType } });
          }

          let sawParse = false;
          for (const member of factory.body.body) {
            const memberText = memberName(member);
            if (member.type === TSESTree.AST_NODE_TYPES.TSMethodSignature && memberText === "parse") {
              sawParse = true;
              const param = member.params[0];
              const ok = member.params.length === 1 && param?.type === TSESTree.AST_NODE_TYPES.Identifier &&
                param.name === "raw" && !param.optional && textOf(source, param.typeAnnotation?.typeAnnotation) === "unknown" &&
                textOf(source, member.returnType?.typeAnnotation) === `Result<${name}>` && !member.optional;
              if (!ok) context.report({ node: member, messageId: "parse", data: { name } });
              // Resolve the name, don't match the text: 'Result' must be the
              // shared import, never a local alias or another module's.
              const from = imported.get("Result");
              const shared = from !== undefined && (/^\.\.?\/(?:[^/]+\/)*shared\/result\.ts$/.test(from) ||
                (!domain && /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*\/domain$/.test(from)));
              if (ok && (!shared || locals.has("Result"))) {
                const found = locals.has("Result")
                  ? "this file declares its own 'Result'"
                  : from === undefined ? "it is not imported" : `it is imported from '${from}'`;
                context.report({ node: member, messageId: "resultSource", data: { name, found } });
              }
            } else if (member.type === TSESTree.AST_NODE_TYPES.TSMethodSignature && memberText === "generate") {
              if (member.params.length !== 0 || member.optional || textOf(source, member.returnType?.typeAnnotation) !== name) {
                context.report({ node: member, messageId: "generate", data: { name } });
              }
            } else {
              context.report({ node: member, messageId: "factoryMember", data: { name, member: memberText ?? textOf(source, member) } });
            }
          }
          if (!sawParse) context.report({ node: factory.id, messageId: "parse", data: { name } });
        }
      },
    };
  },
});
