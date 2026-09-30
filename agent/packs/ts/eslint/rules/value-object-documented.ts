import { ESLintUtils, TSESTree } from "@typescript-eslint/utils";
import { conceptPairs, memberName, PRIMITIVE_KEYWORDS, textOf } from "./concept-pairs.ts";

// ADR 2026-059 contract rule: when a concept's instance interface carries a
// doc comment, the comment says something and its `@accepts` examples are
// usable.
//
//   /**
//    * The name of a project: any string that is not empty once trimmed.
//    * @accepts "Website relaunch"
//    * @accepts "Office move"
//    */
//   export interface ProjectName { … }
//
// The doc comment is OPTIONAL: the worked example's contracts carry none, and
// the example wins where it does not cost determinism. What a doc comment
// carries is still load-bearing when present, which is what this rule holds:
//
// * The `@accepts` examples are the generated laws' samples (the domain
//   emitter): with them, a value object's equality, determinism and toJSON
//   round-trip laws run, and an entity built from it gets identity laws.
//   Without them those laws are emitted as named skips. So an example must be
//   something the emitter can print as a TypeScript literal of the value's
//   own type — a double-quoted string for `value: string`, a decimal number
//   for `number`, `true`/`false` for `boolean` — or it would generate a law
//   file that does not compile, or a law that asserts nonsense.
// * An empty `/** */` satisfies a checklist and tells the test-writer
//   nothing; it is reported as loudly as it misleads.
// * `@accepts` means nothing on an entity (it has no `parse`) and is refused
//   there rather than silently ignored.
//
// Only a tag that opens its own line counts; "add an @accepts tag" in prose
// is prose (the generator reads tags the same way).

type MessageId = "emptyDoc" | "badAccepts" | "acceptsOnEntity";

const createRule = ESLintUtils.RuleCreator.withoutDocs;

const LITERAL: Readonly<Record<string, RegExp>> = {
  string: /^"(?:[^"\\\n]|\\.)*"$/,
  number: /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/,
  boolean: /^(?:true|false)$/,
};

function isJsDoc(comment: TSESTree.Comment): boolean {
  return comment.type === TSESTree.AST_TOKEN_TYPES.Block && comment.value.startsWith("*");
}

/** The lines of a JSDoc block with the leading `*` stripped. */
function jsDocLines(comment: TSESTree.Comment): string[] {
  return comment.value
    .slice(1)
    .split("\n")
    .map((line) => line.replace(/^\s*\*?/, "").trim());
}

export const valueObjectDocumented = createRule<[], MessageId>({
  name: "value-object-documented",
  meta: {
    type: "problem",
    schema: [],
    messages: {
      emptyDoc: `'{{name}}' has an empty doc comment, which satisfies a checklist and tells the reader nothing. Either delete it or say what makes a {{name}} valid, e.g. /** The name of a project: not empty once trimmed. @accepts "Website relaunch" */ (ts-contract-authoring).`,
      badAccepts: `'@accepts {{example}}' on '{{name}}' is not a {{type}} literal — an @accepts example is printed verbatim into the generated laws as a sample '{{name}}.parse' must accept, so write one literal of the value's type per tag, e.g. {{sample}}, and nothing else on the line.`,
      acceptsOnEntity: `'@accepts' on the entity '{{name}}' means nothing — an entity has no 'parse'; it is built from value objects. Put the examples on the value objects it holds.`,
    },
  },
  defaultOptions: [],
  create(context) {
    const sourceCode = context.sourceCode;
    const source = sourceCode.getText();
    return {
      Program(program) {
        for (const pair of conceptPairs(program)) {
          if (pair.kind === "command") continue;
          const docNode = pair.instance.parent;
          const comments = sourceCode.getCommentsBefore(docNode);
          const last = comments[comments.length - 1];
          if (last === undefined || !isJsDoc(last)) continue;
          const lines = jsDocLines(last);
          if (lines.every((l) => l === "")) {
            context.report({ node: pair.instance.id, messageId: "emptyDoc", data: { name: pair.name } });
            continue;
          }
          const tags = lines.filter((l) => /^@accepts(?:\s|$)/.test(l)).map((l) => l.slice("@accepts".length).trim());
          if (tags.length === 0) continue;
          if (pair.kind === "entity") {
            context.report({ node: pair.instance.id, messageId: "acceptsOnEntity", data: { name: pair.name } });
            continue;
          }
          const value = pair.instance.body.body.find(
            (m): m is TSESTree.TSPropertySignature => m.type === TSESTree.AST_NODE_TYPES.TSPropertySignature && memberName(m) === "value",
          );
          const typeText = textOf(source, value?.typeAnnotation?.typeAnnotation);
          const type = PRIMITIVE_KEYWORDS.has(typeText) ? typeText : "string";
          const sample = type === "string" ? '@accepts "Website relaunch"' : type === "number" ? "@accepts 42" : "@accepts true";
          for (const example of tags) {
            if (!LITERAL[type]!.test(example)) {
              context.report({ node: pair.instance.id, messageId: "badAccepts", data: { name: pair.name, example, type, sample } });
            }
          }
        }
      },
    };
  },
});
