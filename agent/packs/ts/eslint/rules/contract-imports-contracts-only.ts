import { ESLintUtils, TSESTree } from "@typescript-eslint/utils";

// ADR 2026-059 contract rule (it replaces, and inverts, the retired
// `no-cross-contract-type-import`): a contract imports only other contracts
// and the shared result type, and only as types.
//
//   import type { ProjectId } from "../projects/project-id.contract.ts";   ✓
//   import type { Result } from "../shared/result.ts";                    ✓
//   import type { Note, Result } from "@example/project-management/domain"; ✓ application contracts only
//   import type { ProjectId } from "../projects/project-id.ts";            ✗ an implementation
//   import { ProjectId } from "../projects/project-id.contract.ts";        ✗ a value import
//
// Why: under the contract-owns-the-name form, the contract is the concept's
// only declaration and the implementation re-exports it. A contract that
// reached into an implementation file would make the frozen design depend on
// builder-written code, and the red gate could no longer typecheck the design
// before the builder starts. The retired `declare class` form needed the
// opposite rule because it had two declarations of every class.
//
// The one exception is lead decision Q3 (ADR 2026-059): an application
// contract may `import type` from its context's GENERATED domain barrel,
// `@<scope>/<context>/domain`. The barrel is generated, so the import cannot
// reach a body. A domain contract (any file under a `domain/` directory) may
// not: it imports its sibling contracts directly.
//
// Form: the whole declaration is `import type { … } from "…"`. An inline
// `import { type X }` leaves an empty runtime import behind under
// `verbatimModuleSyntax`; a namespace or default import has no single
// parseable name list. Re-exports are refused outright: a contract declares
// its own names, and a re-export would give a name a second home (domain.md:
// "`<Name>` means exactly one type everywhere").

type MessageId = "notAContract" | "barrelInDomain" | "valueImport" | "inlineType" | "shape" | "sideEffect" | "reexport" | "jsSpecifier";

const RULE = "A contract imports only other contracts and the shared Result type, as types (ADR 2026-059):";

const CONTRACT = /^\.\.?\/(?:[^/]+\/)*[a-z0-9][a-z0-9-]*\.contract\.ts$/;
const RESULT = /^\.\.?\/(?:[^/]+\/)*shared\/result\.ts$/;
const DOMAIN_BARREL = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*\/domain$/;
const JS_TWIN = /^\.\.?\/.*\.(?:contract\.)?js$/;

const createRule = ESLintUtils.RuleCreator.withoutDocs;

function inDomainLayer(filename: string): boolean {
  return filename.replace(/\\/g, "/").split("/").includes("domain");
}

export const contractImportsContractsOnly = createRule<[], MessageId>({
  name: "contract-imports-contracts-only",
  meta: {
    type: "problem",
    schema: [],
    messages: {
      notAContract: `${RULE} '{{source}}' is not a contract. Import the type from the concept's contract instead, e.g. 'import type { ProjectId } from "../projects/project-id.contract.ts";' — a design that depends on an implementation file cannot be checked before the builder writes it.`,
      barrelInDomain: `${RULE} '{{source}}' is the domain barrel, which only application contracts may import (it re-exports the implementations). A domain contract imports its sibling concepts directly: 'import type { ProjectId } from "../projects/project-id.contract.ts";'.`,
      valueImport: `${RULE} 'import … from "{{source}}"' is a value import — write 'import type { … } from "{{source}}";'. A contract declares shapes; nothing in it exists at runtime.`,
      inlineType: `${RULE} 'import { type … } from "{{source}}"' leaves an empty runtime import behind under verbatimModuleSyntax — move 'type' to the declaration: 'import type { … } from "{{source}}";'.`,
      shape: `${RULE} import the names from '{{source}}' as a plain list, 'import type { A, B } from "{{source}}";' — no default, namespace or renamed ('as') imports.`,
      sideEffect: `${RULE} 'import "{{source}}"' runs code at import time — a contract has none. Delete it.`,
      reexport: `A contract declares its own names and re-exports nothing (ADR 2026-059: '<Name>' means exactly one type everywhere). Delete this re-export from '{{source}}' and import the names where they are used; the generated barrel re-exports every concept.`,
      jsSpecifier: `${RULE} '{{source}}' uses a '.js' specifier — the monorepo imports TypeScript files by their real name (allowImportingTsExtensions): write '{{fixed}}'.`,
    },
  },
  defaultOptions: [],
  create(context) {
    const domain = inDomainLayer(context.filename);
    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration): void {
        const source = node.source.value;
        if (node.specifiers.length === 0) {
          context.report({ node, messageId: node.importKind === "type" ? "shape" : "sideEffect", data: { source } });
          return;
        }
        if (JS_TWIN.test(source)) {
          context.report({ node, messageId: "jsSpecifier", data: { source, fixed: source.replace(/\.js$/, ".ts") } });
          return;
        }
        const barrel = DOMAIN_BARREL.test(source);
        if (barrel && domain) {
          context.report({ node, messageId: "barrelInDomain", data: { source } });
          return;
        }
        if (!barrel && !CONTRACT.test(source) && !RESULT.test(source)) {
          context.report({ node, messageId: "notAContract", data: { source } });
          return;
        }
        if (node.importKind !== "type") {
          const inline = node.specifiers.every(
            (s) => s.type === TSESTree.AST_NODE_TYPES.ImportSpecifier && s.importKind === "type",
          );
          context.report({ node, messageId: inline ? "inlineType" : "valueImport", data: { source } });
          return;
        }
        const plain = node.specifiers.every(
          (s) =>
            s.type === TSESTree.AST_NODE_TYPES.ImportSpecifier &&
            s.imported.type === TSESTree.AST_NODE_TYPES.Identifier &&
            s.imported.name === s.local.name,
        );
        if (!plain) context.report({ node, messageId: "shape", data: { source } });
      },
      ExportNamedDeclaration(node: TSESTree.ExportNamedDeclaration): void {
        if (node.source !== null) context.report({ node, messageId: "reexport", data: { source: node.source.value } });
      },
      ExportAllDeclaration(node: TSESTree.ExportAllDeclaration): void {
        context.report({ node, messageId: "reexport", data: { source: node.source.value } });
      },
    };
  },
});
