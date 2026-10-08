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
// Every contract is bound, whatever its directory: contract-first freezing
// means a frozen design never depends on a builder-written file. An
// `import("…")` type expression is refused too — it is an import the
// declaration list cannot show.
//
// What else a contract may import, by where it lives:
//
//   domain/        contracts and the shared Result only (as strict as the
//                  domain-concept parser, so lint-passing implies emittable).
//   application/   also its context's GENERATED domain barrel,
//                  `@<scope>/<context>/domain` (lead decision Q3): the barrel
//                  is generated, so the import cannot reach a body.
//   elsewhere      also a package (`react`), which is a pinned dependency and
//                  not builder-written — but never a workspace's layer path
//                  (`@<scope>/<pkg>/application`, `…/domain/notes`), which is.
//
// Relative non-contract modules are refused everywhere. (The shipped
// contract-support modules of ADR 2026-046 were retired with the declare-class
// model; no pack ships one.)
//
// Form: the whole declaration is `import type { … } from "…"`. An inline
// `import { type X }` leaves an empty runtime import behind under
// `verbatimModuleSyntax`; a namespace or default import has no single
// parseable name list. Re-exports are refused outright: a contract declares
// its own names, and a re-export would give a name a second home (domain.md:
// "`<Name>` means exactly one type everywhere").

type MessageId =
  | "notAContract"
  | "barrelInDomain"
  | "packageInLayer"
  | "valueImport"
  | "inlineType"
  | "shape"
  | "sideEffect"
  | "reexport"
  | "jsSpecifier"
  | "importType";

const RULE = "A contract imports only other contracts and the shared Result type, as types (ADR 2026-059):";

const CONTRACT = /^\.\.?\/(?:[^/]+\/)*[a-z0-9][a-z0-9-]*\.contract\.ts$/;
const RESULT = /^\.\.?\/(?:[^/]+\/)*shared\/result\.ts$/;
const DOMAIN_BARREL = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*\/domain$/;
const WORKSPACE_LAYER = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*\/(?:domain|application|adapters)(?:\/|$)/;
const JS_TWIN = /^\.\.?\/.*\.(?:contract\.)?js$/;

const createRule = ESLintUtils.RuleCreator.withoutDocs;

type Layer = "domain" | "application" | "other";

function layerOf(filename: string): Layer {
  const segments = filename.replace(/\\/g, "/").split("/");
  if (segments.includes("domain")) return "domain";
  if (segments.includes("application")) return "application";
  return "other";
}

export interface ContractImportProblem {
  readonly messageId: "notAContract" | "barrelInDomain" | "packageInLayer" | "jsSpecifier";
  readonly data: Readonly<Record<string, string>>;
  /** The same reason in one line, for the scaffolder's backstop. */
  readonly text: string;
}

/**
 * Why a contract at `filename` may not import `specifier`, or undefined when
 * it may. The one definition of the allowed specifiers: the lint reports it,
 * and the scaffolder's backstop asks the same question, so the two can never
 * disagree.
 */
export function contractImportProblem(
  specifier: string,
  filename: string,
): ContractImportProblem | undefined {
  const layer = layerOf(filename);
  if (specifier.startsWith(".")) {
    if (JS_TWIN.test(specifier)) {
      const fixed = specifier.replace(/\.js$/, ".ts");
      return { messageId: "jsSpecifier", data: { source: specifier, fixed }, text: `'${specifier}' uses a '.js' specifier — write '${fixed}'` };
    }
    if (CONTRACT.test(specifier) || RESULT.test(specifier)) return undefined;
    return {
      messageId: "notAContract",
      data: { source: specifier },
      text: `'${specifier}' is not a contract — a contract imports only other '*.contract.ts' files and the shared '../shared/result.ts'`,
    };
  }
  if (DOMAIN_BARREL.test(specifier)) {
    return layer === "domain"
      ? { messageId: "barrelInDomain", data: { source: specifier }, text: `'${specifier}' is the domain barrel, which only application contracts may import` }
      : undefined;
  }
  if (layer !== "other") {
    return {
      messageId: "packageInLayer",
      data: { source: specifier, layer },
      text: `'${specifier}' is a package — a ${layer} contract imports only contracts, the shared Result${layer === "application" ? " and its domain barrel" : ""}`,
    };
  }
  if (WORKSPACE_LAYER.test(specifier)) {
    return {
      messageId: "notAContract",
      data: { source: specifier },
      text: `'${specifier}' is a workspace layer path, whose files the builder writes — import the concept's contract instead`,
    };
  }
  return undefined;
}

export const contractImportsContractsOnly = createRule<[], MessageId>({
  name: "contract-imports-contracts-only",
  meta: {
    type: "problem",
    schema: [],
    messages: {
      packageInLayer: `${RULE} '{{source}}' is a package, and a {{layer}} contract imports only other contracts and the shared Result (an application contract also its context's domain barrel). A package type on a hexagonal contract is a dependency the emitters cannot see — wrap the concept in a value object instead.`,
      notAContract: `${RULE} '{{source}}' is not a contract. Import the type from the concept's contract instead, e.g. 'import type { ProjectId } from "../projects/project-id.contract.ts";' — a design that depends on an implementation file cannot be checked before the builder writes it.`,
      barrelInDomain: `${RULE} '{{source}}' is the domain barrel, which only application contracts may import (it re-exports the implementations). A domain contract imports its sibling concepts directly: 'import type { ProjectId } from "../projects/project-id.contract.ts";'.`,
      valueImport: `${RULE} 'import … from "{{source}}"' is a value import — write 'import type { … } from "{{source}}";'. A contract declares shapes; nothing in it exists at runtime.`,
      inlineType: `${RULE} 'import { type … } from "{{source}}"' leaves an empty runtime import behind under verbatimModuleSyntax — move 'type' to the declaration: 'import type { … } from "{{source}}";'.`,
      shape: `${RULE} import the names from '{{source}}' as a plain list, 'import type { A, B } from "{{source}}";' — no default, namespace or renamed ('as') imports.`,
      sideEffect: `${RULE} 'import "{{source}}"' runs code at import time — a contract has none. Delete it.`,
      reexport: `A contract declares its own names and re-exports nothing (ADR 2026-059: '<Name>' means exactly one type everywhere). Delete this re-export from '{{source}}' and import the names where they are used; the generated barrel re-exports every concept.`,
      importType: `${RULE} 'import("{{source}}")' in a type position is an import no import declaration shows, so it would let a contract depend on any file. Declare it at the top instead: 'import type { … } from "./<concept>.contract.ts";'.`,
      jsSpecifier: `${RULE} '{{source}}' uses a '.js' specifier — the monorepo imports TypeScript files by their real name (allowImportingTsExtensions): write '{{fixed}}'.`,
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration): void {
        const source = node.source.value;
        if (node.specifiers.length === 0) {
          context.report({ node, messageId: node.importKind === "type" ? "shape" : "sideEffect", data: { source } });
          return;
        }
        const problem = contractImportProblem(source, context.filename);
        if (problem !== undefined) {
          context.report({ node, messageId: problem.messageId, data: problem.data });
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
      // `import("…").Name` in a type is refused whatever it names: a
      // contract's dependencies are exactly its import declarations.
      TSImportType(node: TSESTree.TSImportType): void {
        const arg = node.argument;
        const source =
          arg.type === TSESTree.AST_NODE_TYPES.TSLiteralType && arg.literal.type === TSESTree.AST_NODE_TYPES.Literal
            ? String(arg.literal.value)
            : context.sourceCode.getText(arg);
        context.report({ node, messageId: "importType", data: { source } });
      },
    };
  },
});
