import { ESLintUtils, TSESTree } from "@typescript-eslint/utils";

// ADR 2026-029 zone rule, src/** and tests/**: the stack that satisfies a
// capability is harness policy — one blessed choice per capability — so the
// known members of the two governed categories (API frameworks, schema
// engines) other than the blessed ones may not be imported at all. tRPC is
// the RPC stack; zod is the schema engine; everything on the list below is a
// competitor whose presence means a "how" leaked past intake (ADR 2026-032)
// or a worker reached for a familiar tool against policy.
//
// This is the mechanical backstop of a three-layer binding: guidance (the
// pack skill) can fail to load, availability (targets cannot add
// dependencies) can be pre-empted by something already installed — this rule
// holds regardless. A ticket that genuinely REQUIRES one of these is a
// product decision for the user, not an import for a worker.
//
// The list is curated, not clever: package names, matched exactly or as a
// path prefix (`graphql` and `graphql/utilities`), plus the ecosystems'
// scope prefixes. When a second pack exists, packs contribute their own
// category members (same plan as the phase gate's spec denylist).

const createRule = ESLintUtils.RuleCreator.withoutDocs;

/** Exact package roots (also matched as `<name>/…` subpaths). */
const BANNED_PACKAGES: readonly string[] = [
  "graphql",
  "graphql-yoga",
  "graphql-tag",
  "type-graphql",
  "mercurius",
  "express",
  "fastify",
  "koa",
  "hapi",
  "restify",
  "ajv",
  "joi",
  "yup",
  "superstruct",
  "io-ts",
  "runtypes",
  "class-validator",
  "valibot",
  "arktype",
];

/** Scope/family prefixes that ban the whole namespace. */
const BANNED_PREFIXES: readonly string[] = [
  "@apollo/",
  "apollo-server",
  "@graphql-tools/",
  "@hapi/",
  "@koa/",
  "@nestjs/",
  "@sinclair/typebox",
];

/** The banned package a specifier resolves to, or undefined. */
export function bannedStack(source: string): string | undefined {
  for (const name of BANNED_PACKAGES) {
    if (source === name || source.startsWith(`${name}/`)) return name;
  }
  for (const prefix of BANNED_PREFIXES) {
    if (source.startsWith(prefix)) return prefix.replace(/\/$/, "");
  }
  return undefined;
}

const MESSAGE =
  '"{{source}}" is {{banned}} — a non-blessed stack (ADR 2026-029). The harness binds capabilities to ' +
  "stacks as policy: tRPC (@trpc/server) is the RPC stack, zod the schema engine. If the requirement " +
  "genuinely depends on this framework, that is a product decision for the user (ADR 2026-032) — raise it; " +
  "do not import it.";

export const blessedStacksOnly = createRule<[], "bannedImport">({
  name: "blessed-stacks-only",
  meta: {
    type: "problem",
    schema: [],
    messages: { bannedImport: MESSAGE },
  },
  defaultOptions: [],
  create(context) {
    const report = (node: TSESTree.Node, source: string): void => {
      const banned = bannedStack(source);
      if (banned !== undefined) {
        context.report({ node, messageId: "bannedImport", data: { source, banned } });
      }
    };
    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration): void {
        report(node, node.source.value);
      },
      ExportNamedDeclaration(node: TSESTree.ExportNamedDeclaration): void {
        if (node.source) report(node, node.source.value);
      },
      ExportAllDeclaration(node: TSESTree.ExportAllDeclaration): void {
        report(node, node.source.value);
      },
      ImportExpression(node: TSESTree.ImportExpression): void {
        if (
          node.source.type === TSESTree.AST_NODE_TYPES.Literal &&
          typeof node.source.value === "string"
        ) {
          report(node, node.source.value);
        }
      },
    };
  },
});
