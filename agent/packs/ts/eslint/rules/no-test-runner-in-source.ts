import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";

// Implementation code never touches the test runner (final review, item 2).
//
// bun collects more than `.test.ts`: also `.spec.*`, `_test.*` and
// `_spec.*`, in any JS/TS extension. The gates hand bun the test-side files
// by path, and the .ts/.tsx forms are test-side, but a builder file shaped like a test
// is still a test the builder wrote, and `mock.module` is worse: one call,
// in any file bun loads, replaces a module for every file loaded after it,
// so a builder could make the code under test whatever the tests expect.
// This rule, on every implementation file under a source root (test-side
// files are exempt, the test-writer may mock):
//
//   · refuses `mock.module(…)`, however the `mock` binding was reached;
//   · refuses importing `bun:test`, by any import form;
//   · refuses a file name bun would collect as a test that is not
//     test-side (the source lint never sees test-side files).

const BUN_TEST_NAME = /[._](?:test|spec)\.[cm]?[jt]sx?$/i;

export const noTestRunnerInSource = ESLintUtils.RuleCreator.withoutDocs({
  meta: {
    type: "problem",
    schema: [],
    messages: {
      mockModule:
        "`mock.module` replaces a module for every file loaded after it — in implementation code it can make the code under test whatever a test expects. Implementation files never mock; only test-side files may.",
      testImport:
        "Implementation code may not import 'bun:test': a builder file that registers tests or mocks is a test the builder wrote. Tests live in test-side files only.",
      testName:
        "'{{name}}' is a name bun collects as a test file, and it is not test-side. Name implementation files by their layout role.",
    },
  },
  defaultOptions: [],
  create(context) {
    const isBunTest = (source: TSESTree.Node | null | undefined): boolean =>
      source !== null && source !== undefined && source.type === "Literal" && source.value === "bun:test";
    return {
      Program(node) {
        const name = context.filename.split(/[\\/]/).pop() ?? "";
        if (BUN_TEST_NAME.test(name)) context.report({ node, messageId: "testName", data: { name } });
      },
      ImportDeclaration(node) {
        if (isBunTest(node.source)) context.report({ node, messageId: "testImport" });
      },
      ExportNamedDeclaration(node) {
        if (isBunTest(node.source)) context.report({ node, messageId: "testImport" });
      },
      ExportAllDeclaration(node) {
        if (isBunTest(node.source)) context.report({ node, messageId: "testImport" });
      },
      ImportExpression(node) {
        if (isBunTest(node.source)) context.report({ node, messageId: "testImport" });
      },
      TSImportEqualsDeclaration(node) {
        if (node.moduleReference.type === "TSExternalModuleReference" && isBunTest(node.moduleReference.expression)) {
          context.report({ node, messageId: "testImport" });
        }
      },
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type === "Identifier" && callee.name === "require" && isBunTest(node.arguments[0])) {
          context.report({ node, messageId: "testImport" });
          return;
        }
        if (callee.type !== "MemberExpression") return;
        const property = callee.property;
        const named = (!callee.computed && property.type === "Identifier" && property.name === "module") ||
          (callee.computed && property.type === "Literal" && property.value === "module");
        if (!named) return;
        const object = callee.object;
        const mockish = (object.type === "Identifier" && object.name === "mock") ||
          (object.type === "MemberExpression" && !object.computed && object.property.type === "Identifier" && object.property.name === "mock");
        if (mockish) context.report({ node, messageId: "mockModule" });
      },
    };
  },
});
