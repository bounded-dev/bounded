import { ESLintUtils, TSESTree } from "@typescript-eslint/utils";

// TN-26-001 architect zone rule: `*.contract.ts` files are declaration-only —
// types, interfaces and ambient (declare) declarations; no function bodies,
// no value bindings, no runtime imports. Classes are refused in every form:
// `declare class` was the contract model ADR LEG-2026-059 retired, and its
// message teaches the interface + factory form that replaced it. Which files the rule applies to is
// gate wiring (flat-config `files:`), not the rule's concern.
//
// Error messages are written for an agent reader, not a human (TN appendix,
// Kinney: "write lint error messages like prompts"): each one names the sin
// and the correct destination for the code.

type MessageId =
  | "functionBody"
  | "missingDeclare"
  | "valueBinding"
  | "classBody"
  | "retiredDeclareClass"
  | "enumRuntime"
  | "namespaceRuntime"
  | "valueImport"
  | "importEquals"
  | "valueExport"
  | "sideEffect"
  | "defaultValue"
  | "exportAssignment";

const DECLARATION_ONLY =
  "Contract files are declaration-only (TN-26-001): types, interfaces and 'declare' shapes live here; runtime code belongs in the sibling implementation file.";

const createRule = ESLintUtils.RuleCreator.withoutDocs;

function nameOf(node: TSESTree.Node): string {
  if (node.type === TSESTree.AST_NODE_TYPES.Identifier) return node.name;
  return "<anonymous>";
}

export const declarationOnly = createRule<[], MessageId>({
  name: "declaration-only",
  meta: {
    type: "problem",
    messages: {
      functionBody: `${DECLARATION_ONLY} '{{name}}' has a function body — keep only the signature here; the scaffolder generates the throwing skeleton in the sibling .ts and the builder implements there.`,
      missingDeclare: `${DECLARATION_ONLY} '{{name}}' is a bodiless function signature missing 'declare' — write 'export declare function {{name}}(...): ...;' instead. Without 'declare', tsc treats a bodiless signature as an incomplete implementation (TS2391 "Function implementation is missing or not immediately following the declaration") and the contract fails to compile.`,
      valueBinding: `${DECLARATION_ONLY} '{{name}}' is a value binding and would emit runtime code — declare the shape with 'export declare const {{name}}: …' or move the value into the implementation.`,
      classBody: `${DECLARATION_ONLY} class '{{name}}' has a runtime body — a contract declares interfaces only: 'export interface {{name}}' for the instance side and 'export interface {{name}}Factory' for the static side (ADR LEG-2026-059). The implementation class, '{{name}}Impl', is generated into the sibling .ts.`,
      retiredDeclareClass: `'export declare class {{name}}' is the retired contract form (ADR LEG-2026-059 replaced ADRs LEG-2026-015/023/026). The contract owns the name as two interfaces — the instance side and the static side:\n  import type { Result } from "../shared/result.ts";\n  export interface {{name}} {\n    readonly __brand: "{{name}}";\n    readonly value: string;\n    equals(other: {{name}}): boolean;\n    toJSON(): string;\n  }\n  export interface {{name}}Factory {\n    parse(raw: unknown): Result<{{name}}>;\n  }\nAn identifier's factory adds 'generate(): {{name}};'; an entity's factory is 'new (…fields): {{name}};' instead of parse. The emitter generates '{{name}}Impl' and the file's two exports; the builder writes only the class body.`,
      enumRuntime: `${DECLARATION_ONLY} enum '{{name}}' is not allowed (the scaffolder cannot skeleton enums) — use a string-literal union: type {{name}} = 'a' | 'b'.`,
      namespaceRuntime: `${DECLARATION_ONLY} namespace '{{name}}' emits runtime code — use 'declare namespace' with type members only.`,
      valueImport: `${DECLARATION_ONLY} '{{source}}' is imported as a value — use 'import type … from "{{source}}"'; concrete infra (db, http, fs) belongs behind ports in the implementation, never in a contract.`,
      importEquals: `${DECLARATION_ONLY} 'import … = require("{{source}}")' pulls runtime code — use 'import type … from "{{source}}"' instead.`,
      valueExport: `${DECLARATION_ONLY} re-exporting from '{{source}}' as values pulls runtime code — use 'export type … from "{{source}}"'.`,
      sideEffect: `${DECLARATION_ONLY} this statement runs at import time — remove it.`,
      defaultValue: `${DECLARATION_ONLY} a default export must be an interface ('export default interface …'), not a value.`,
      exportAssignment: `${DECLARATION_ONLY} 'export =' is CommonJS interop, not a declaration — use named type exports.`,
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    function checkStatement(node: TSESTree.Node): void {
      switch (node.type) {
        // --- pure declarations: always allowed ---
        case TSESTree.AST_NODE_TYPES.TSInterfaceDeclaration:
        case TSESTree.AST_NODE_TYPES.TSTypeAliasDeclaration:
          return;

        // A bodiless function signature — `function f(): T;` — always parses
        // as TSDeclareFunction, whether or not the source wrote `declare`
        // (FunctionDeclaration only occurs when a body is present). Without
        // `declare`, tsc requires an implementation to follow immediately
        // (TS2391); a contract file never provides one, so the signature is
        // dead on arrival. `node.declare` is the only thing distinguishing
        // the compiling form from the one that doesn't.
        case TSESTree.AST_NODE_TYPES.TSDeclareFunction:
          if (node.declare) return;
          context.report({
            node,
            messageId: "missingDeclare",
            data: { name: node.id ? node.id.name : "default" },
          });
          return;

        case TSESTree.AST_NODE_TYPES.FunctionDeclaration:
          // FunctionDeclaration always carries a body in this parser (a
          // bodiless signature is TSDeclareFunction, handled above); this
          // guard is defensive, not load-bearing.
          if (!node.body) return;
          context.report({
            node,
            messageId: "functionBody",
            data: { name: node.id ? node.id.name : "default" },
          });
          return;

        case TSESTree.AST_NODE_TYPES.ClassDeclaration:
          if (node.declare) {
            context.report({
              node,
              messageId: "retiredDeclareClass",
              data: { name: node.id ? node.id.name : "Name" },
            });
            return;
          }
          context.report({
            node,
            messageId: "classBody",
            data: { name: node.id ? node.id.name : "<anonymous>" },
          });
          return;

        case TSESTree.AST_NODE_TYPES.VariableDeclaration:
          if (node.declare) return;
          for (const decl of node.declarations) {
            context.report({
              node: decl,
              messageId: "valueBinding",
              data: { name: nameOf(decl.id) },
            });
          }
          return;

        case TSESTree.AST_NODE_TYPES.TSEnumDeclaration:
          // No exemption for 'declare enum': the scaffolder can't skeleton
          // enums, and lint-passing must imply scaffoldable (TN-26-001).
          context.report({
            node,
            messageId: "enumRuntime",
            data: { name: node.id.name },
          });
          return;

        case TSESTree.AST_NODE_TYPES.TSModuleDeclaration: {
          if (!node.declare) {
            context.report({
              node,
              messageId: "namespaceRuntime",
              data: {
                name:
                  node.id.type === TSESTree.AST_NODE_TYPES.Identifier
                    ? node.id.name
                    : node.id.type === TSESTree.AST_NODE_TYPES.Literal
                      ? String(node.id.value)
                      : "<qualified>",
              },
            });
            return;
          }
          // Ambient namespace: contents are compiler-forced ambient, but
          // recurse so nested modules stay honest.
          if (node.body) checkStatement(node.body);
          return;
        }

        case TSESTree.AST_NODE_TYPES.TSModuleBlock:
          for (const stmt of node.body) checkStatement(stmt);
          return;

        // --- module graph: type-only or nothing ---
        case TSESTree.AST_NODE_TYPES.ImportDeclaration: {
          if (node.importKind === "type") return;
          const allTypeSpecifiers =
            node.specifiers.length > 0 &&
            node.specifiers.every(
              (s) => s.type === TSESTree.AST_NODE_TYPES.ImportSpecifier && s.importKind === "type",
            );
          if (allTypeSpecifiers) return;
          context.report({
            node,
            messageId: "valueImport",
            data: { source: node.source.value },
          });
          return;
        }

        case TSESTree.AST_NODE_TYPES.TSImportEqualsDeclaration:
          context.report({
            node,
            messageId: "importEquals",
            data: {
              source:
                node.moduleReference.type === TSESTree.AST_NODE_TYPES.TSExternalModuleReference
                  ? String(node.moduleReference.expression.value)
                  : "<local>",
            },
          });
          return;

        case TSESTree.AST_NODE_TYPES.ExportNamedDeclaration: {
          if (node.declaration) {
            checkStatement(node.declaration);
            return;
          }
          // No source: a bare local re-export ('export { Foo }') — the binding
          // is checked at its own declaration, so nothing to do here.
          if (!node.source) return;
          if (node.exportKind === "type") return;
          const allTypeSpecifiers =
            node.specifiers.length > 0 &&
            node.specifiers.every(
              (s) => s.type === TSESTree.AST_NODE_TYPES.ExportSpecifier && s.exportKind === "type",
            );
          if (allTypeSpecifiers) return;
          context.report({
            node,
            messageId: "valueExport",
            data: { source: node.source.value },
          });
          return;
        }

        case TSESTree.AST_NODE_TYPES.ExportAllDeclaration:
          if (node.exportKind === "type") return;
          context.report({
            node,
            messageId: "valueExport",
            data: { source: node.source.value },
          });
          return;

        case TSESTree.AST_NODE_TYPES.ExportDefaultDeclaration: {
          const decl = node.declaration;
          if (decl.type === TSESTree.AST_NODE_TYPES.TSInterfaceDeclaration) return;
          if (decl.type === TSESTree.AST_NODE_TYPES.FunctionDeclaration && !decl.body) return;
          context.report({ node, messageId: "defaultValue" });
          return;
        }

        case TSESTree.AST_NODE_TYPES.TSExportAssignment:
          context.report({ node, messageId: "exportAssignment" });
          return;

        default:
          context.report({ node, messageId: "sideEffect" });
      }
    }

    return {
      Program(program) {
        for (const stmt of program.body) checkStatement(stmt);
      },
    };
  },
});
