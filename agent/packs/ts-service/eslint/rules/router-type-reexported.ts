import { ESLintUtils, TSESTree } from "@typescript-eslint/utils";

// TN-26-006 A2 / ADR 2026-030 architect zone rule: an API-service contract must
// RE-EXPORT its router's inferred type. The omission is the defect.
//
// WHY THIS EXISTS, AND WHY IT IS NOT `no-erased-router` WITH A WIDER NET. Its
// sibling rule refuses a router type that has been ERASED (`ServiceRouter =
// AnyRouter`, dogfood r22) — a present, wrong declaration. Run 23 then showed
// the other half of the same hole: both service arms delivered green having
// simply NOT declared the router type at all. That is legal, invisible, and
// costs exactly what erasure costs — a frontend has nothing to type its client
// against, so the typed client the whole service exists to provide dies
// silently and nobody bounces. A rule that only refuses a bad declaration
// cannot see an absent one, because there is no node to report on; absence has
// to be checked at the end of the file, against the whole file.
//
// THE WHOLE-FILE SHAPE THIS DEMANDS:
//
//   import type { serviceRouter } from "./api.js";   // the impl module
//   export type ServiceRouter = typeof serviceRouter;
//
// The router's type is INFERRED from the implementation — it cannot be written
// out by hand, which is precisely why r22 reached for `AnyRouter` — so the
// contract reaches for it through the sibling implementation module, the same
// route ADR 2026-026 already sanctions for value objects. The type-only import
// cycle (impl imports contract, contract imports impl's type) is legal
// TypeScript and erases at compile time.
//
// SCOPE: a contract that imports a `service-runtime` module, and nothing else.
// That specifier is the marker of an API-service contract — the same marker the
// scaffolder reads (`serviceRuntimeTargets`) to decide where to ship the
// runtime. A domain contract has no router and must not be asked for one, so a
// file with no service-runtime import is silently out of scope; that half of
// the rule is as load-bearing as the refusal, and the test pins it.
//
// WHAT COUNTS AS SATISFYING IT. One exported `export type X = typeof id;` whose
// `id` came from a RELATIVE, non-contract module. Three exclusions, each doing
// real work:
//   * a non-relative specifier is a package, not this component's sibling;
//   * a `*.contract.js` specifier is the second-identity defect
//     `no-cross-contract-type-import` already refuses, and a router type
//     borrowed from another contract's ambient declarations is not this
//     router's inferred type;
//   * the service-runtime module itself, so that `typeof createService` — a
//     name that IS importable from a relative non-contract module — cannot
//     stand in for the router and satisfy the rule by accident.
// A locally `declare`d const is deliberately NOT accepted: `export type X =
// typeof someLocalDeclare` is hand-writing the router's type, which is the
// erasure this set refuses, wearing one more layer of indirection.

const createRule = ESLintUtils.RuleCreator.withoutDocs;

/** The marker of an API-service contract: it points at the runtime the
 *  scaffolder ships (the same specifier `serviceRuntimeTargets` resolves). */
function isServiceRuntimeSpecifier(source: string): boolean {
  return /(^|\/)[^/]*service-runtime\.js$/.test(source);
}

/** A sibling IMPLEMENTATION module — where an inferred type can be found. */
function isSiblingImplementation(source: string): boolean {
  if (!source.startsWith(".")) return false;
  if (/\.contract(\.[cm]?[jt]s)?$/.test(source)) return false;
  return !isServiceRuntimeSpecifier(source);
}

export const routerTypeReexported = createRule<[], "missing">({
  name: "router-type-reexported",
  meta: {
    type: "problem",
    schema: [],
    messages: {
      missing:
        "this contract declares an API service (it imports \"{{source}}\") but never re-exports the router's " +
        "inferred type, so no caller can type a client against it. Omission is legal erasure: dogfood r23 " +
        "delivered two services green with the type simply absent, which costs exactly what `AnyRouter` costs " +
        "(r22) and bounces nobody. The router's type is INFERRED, so borrow it from the implementation module " +
        '(ADR 2026-030): import type { serviceRouter } from "./api.js"; export type ServiceRouter = typeof ' +
        "serviceRouter;",
    },
  },
  defaultOptions: [],
  create(context) {
    /** Every service-runtime import; the first is where the absence is reported
     *  — it is the line that made this file a service contract. */
    const serviceRuntimeImports: TSESTree.ImportDeclaration[] = [];
    /** Names imported from a sibling implementation module: the only ids whose
     *  `typeof` is an INFERRED type rather than a hand-written one. */
    const fromImplementation = new Set<string>();
    /** Ids appearing as `export type X = typeof <id>;`. */
    const reexportedTypeofIds: string[] = [];

    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration): void {
        const source = node.source.value;
        if (isServiceRuntimeSpecifier(source)) {
          serviceRuntimeImports.push(node);
          return;
        }
        if (!isSiblingImplementation(source)) return;
        for (const spec of node.specifiers) {
          // The local binding is what a `typeof` can name. Contracts are
          // type-only by `declaration-only`, so importKind is not re-checked
          // here: a value import is already that rule's block, and reporting it
          // twice would teach nothing the first message did not.
          if (spec.type === TSESTree.AST_NODE_TYPES.ImportSpecifier) fromImplementation.add(spec.local.name);
        }
      },

      TSTypeAliasDeclaration(node: TSESTree.TSTypeAliasDeclaration): void {
        if (node.parent.type !== TSESTree.AST_NODE_TYPES.ExportNamedDeclaration) return;
        const annotation = node.typeAnnotation;
        if (annotation.type !== TSESTree.AST_NODE_TYPES.TSTypeQuery) return;
        if (annotation.exprName.type !== TSESTree.AST_NODE_TYPES.Identifier) return;
        reexportedTypeofIds.push(annotation.exprName.name);
      },

      // Absence has no node of its own, so the verdict waits for the whole
      // file. Reported once, on the import that put the file in scope.
      "Program:exit"(): void {
        const first = serviceRuntimeImports[0];
        if (first === undefined) return;
        if (reexportedTypeofIds.some((id) => fromImplementation.has(id))) return;
        context.report({
          node: first,
          messageId: "missing",
          data: { source: first.source.value },
        });
      },
    };
  },
});
