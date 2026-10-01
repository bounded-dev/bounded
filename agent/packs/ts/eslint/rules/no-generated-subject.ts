import { relative, sep } from "node:path";
import { ESLintUtils, type TSESLint, type TSESTree } from "@typescript-eslint/utils";
import { generatedFileGlobs, hasTestFileSuffix, pathGlobMatcher, testFileSuffixes } from "../../../../src/pack-contrib.ts";
import { analyseTestFile, onlyGenerated, subjectLabel, subjectResolver, type SubjectResolver } from "../../scripts/test-subjects.ts";

// Tests of generated code are refused before the suite runs (issue #36).
//
// Generated code (a feature's command, an in adapter: whatever the composed
// packs' `generatedFileGlobs` match) works before anything is built, and its
// generated laws (`*.laws.test.ts`) already test it. A hand-written test of it
// passes against the skeletons, so red refuses it; in the 2026-10-01 dogfood
// eight `CreateNoteCommand.parse` tests reached red that way, after both
// workers had finished. This rule says it on the test file instead:
//
//   · a test file whose every imported subject is generated, once;
//   · otherwise each `test` / `it` whose body reaches only generated code.
//
// What a test reaches is test-subjects.ts's analysis, the same one the red
// gate uses to explain a spurious pass. A handler test that builds its input
// with the generated command reaches the handler too, so it is fine.

/** What the rule reads about a project, afresh for every file: a lint run in
 *  a long-lived session must see the workspaces and barrels as they are now. */
function isTestSide(cwd: string, path: string): boolean {
  try {
    return hasTestFileSuffix(path, testFileSuffixes(cwd)) && !pathGlobMatcher(generatedFileGlobs(cwd))(path);
  } catch {
    // No readable composition: nothing is test-side, and the rule says nothing.
    return false;
  }
}

const LAWS = "the generated laws (`*.laws.test.ts`) already test it";

export const noGeneratedSubject = ESLintUtils.RuleCreator.withoutDocs({
  meta: {
    type: "problem",
    schema: [],
    messages: {
      file:
        "Every module this test file exercises is generated ({{subjects}}): generated code works before anything is built, " +
        `and ${LAWS}. Delete this file; test the code a role writes instead (a domain concept, a handler, a store, an out adapter).`,
      test:
        "This test exercises only generated code ({{subjects}}): it passes before anything is built, so red refuses it, and " +
        `${LAWS}. Remove it. A handler test may still build its input with a generated command.`,
    },
  },
  defaultOptions: [],
  create(context) {
    const path = relative(context.cwd, context.filename).split(sep).join("/");
    if (path.startsWith("..")) return {};
    if (!isTestSide(context.cwd, path)) return {};
    const resolve: SubjectResolver = subjectResolver(context.cwd);
    return {
      "Program:exit"(program: TSESTree.Program): void {
        const analysis = analyseTestFile(program, context.sourceCode.scopeManager as unknown as TSESLint.Scope.ScopeManager);
        const subjects = (values: Parameters<typeof subjectLabel>[0][]): string => [...new Set(values.map(subjectLabel))].join(", ");
        const wholeFile = onlyGenerated(analysis.imports, path, resolve);
        if (wholeFile !== undefined) {
          context.report({ node: wholeFile[0]!.node, messageId: "file", data: { subjects: subjects([...wholeFile]) } });
          return;
        }
        for (const test of analysis.tests) {
          const generated = onlyGenerated(test.subjects, path, resolve);
          if (generated !== undefined) context.report({ node: test.node, messageId: "test", data: { subjects: subjects([...generated]) } });
        }
      },
    };
  },
});
