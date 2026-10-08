import { ESLintUtils, TSESTree } from "@typescript-eslint/utils";
import { conceptPairs, inDomainLayer, memberName, PRIMITIVE_KEYWORDS, textOf } from "./concept-pairs.ts";
import { distinctExamples } from "../../scripts/value-object-laws.ts";

// ADR 2026-059 contract rule: every value object states two valid examples,
// and a concept's doc comment, when present, says something usable.
//
//   /**
//    * The name of a project: any string that is not empty once trimmed.
//    * @accepts "Website relaunch"
//    * @accepts "Office move"
//    */
//   export interface ProjectName { … }
//
// * **Two different `@accepts` examples per value object and identifier —
//   required.** For a value object they are the generated laws' samples (the
//   domain emitter): the first runs the equality, determinism and toJSON
//   round-trip laws and lets every entity holding the value object get
//   identity laws; the second is what "equals discriminates" compares
//   against. With this rule the laws are never emitted as skips. An
//   identifier's laws sample `generate()`, but its examples are still the
//   only valid wire form the blind test-writer can see: the boundaries
//   obligation asks every identifier for an accepted literal, and the laws
//   check `parse` accepts both. "Different" means different after trimming a
//   string's whitespace, because a value object that trims would parse
//   `" a "` and `"a"` to one value. (The worked example's value objects and
//   identifiers carry no examples, so the reference adds them — the one
//   place the harness is stricter than the example, and it buys laws and
//   boundary tests that actually run.)
// * Each example is a literal of the value's own type — a double-quoted
//   string for `value: string`, a decimal number for `number`, `true`/`false`
//   for `boolean` — because it is printed verbatim into the laws.
// * An empty `/** */` tells the test-writer nothing, and `@accepts` on an
//   entity means nothing (it has no `parse`); both are refused.
//
// Only a tag that opens its own line counts; "add an @accepts tag" in prose
// is prose (the generator reads tags the same way).

type MessageId = "emptyDoc" | "badAccepts" | "acceptsOnEntity" | "missingAccepts" | "sameAccepts";

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
      missingAccepts: `'{{name}}' is {{kind}}, so its doc comment states its validity rule and two different valid examples, one '@accepts <literal>' tag per line — found {{found}}. They are the generated laws' samples and the only valid literals the test-writer can see for its boundaries block. E.g.\n/**\n * {{rule}}\n * {{sample}}\n * {{sample2}}\n */`,
      sameAccepts: `'{{name}}''s @accepts examples {{examples}} are the same value once whitespace is trimmed — a value object that trims parses them to one value, so "equals discriminates" has nothing to compare. Give two genuinely different examples.`,
      acceptsOnEntity: `'@accepts' on the entity '{{name}}' means nothing — an entity has no 'parse'; it is built from value objects. Put the examples on the value objects it holds.`,
    },
  },
  defaultOptions: [],
  create(context) {
    const sourceCode = context.sourceCode;
    const source = sourceCode.getText();
    return {
      Program(program) {
        for (const pair of conceptPairs(program, inDomainLayer(context.filename))) {
          if (pair.kind === "command") continue;
          const docNode = pair.instance.parent;
          const comments = sourceCode.getCommentsBefore(docNode);
          const last = comments[comments.length - 1];
          const doc = last !== undefined && isJsDoc(last) ? jsDocLines(last) : undefined;
          if (doc !== undefined && doc.every((l) => l === "")) {
            context.report({ node: pair.instance.id, messageId: "emptyDoc", data: { name: pair.name } });
          }
          const tags = (doc ?? []).filter((l) => /^@accepts(?:\s|$)/.test(l)).map((l) => l.slice("@accepts".length).trim());
          if (pair.kind === "entity") {
            if (tags.length > 0) context.report({ node: pair.instance.id, messageId: "acceptsOnEntity", data: { name: pair.name } });
            continue;
          }
          const value = pair.instance.body.body.find(
            (m): m is TSESTree.TSPropertySignature => m.type === TSESTree.AST_NODE_TYPES.TSPropertySignature && memberName(m) === "value",
          );
          const typeText = textOf(source, value?.typeAnnotation?.typeAnnotation);
          const type = PRIMITIVE_KEYWORDS.has(typeText) ? typeText : "string";
          const identifier = pair.factory.body.body.some((m) => memberName(m) === "generate");
          const samples = type === "string"
            ? identifier
              ? ['@accepts "7c9e6679-7425-40de-944b-e07fc1f90ae7"', '@accepts "16fd2706-8baf-433b-82eb-8c7fada847da"']
              : ['@accepts "Website relaunch"', '@accepts "Office move"']
            : type === "number" ? ["@accepts 42", "@accepts 7"] : ["@accepts true", "@accepts false"];
          const valid: string[] = [];
          for (const example of tags) {
            if (LITERAL[type]!.test(example)) valid.push(example);
            else context.report({ node: pair.instance.id, messageId: "badAccepts", data: { name: pair.name, example, type, sample: samples[0]! } });
          }
          if (tags.length < 2) {
            context.report({
              node: pair.instance.id,
              messageId: "missingAccepts",
              data: {
                name: pair.name,
                kind: identifier ? "an identifier" : "a value object",
                found: tags.length === 0 ? (doc === undefined ? "no doc comment" : "no @accepts tag") : "one @accepts tag",
                rule: `What makes a ${pair.name} valid.`,
                sample: samples[0]!,
                sample2: samples[1]!,
              },
            });
          } else if (valid.length === tags.length && distinctExamples(valid).length < 2) {
            context.report({ node: pair.instance.id, messageId: "sameAccepts", data: { name: pair.name, examples: valid.join(" and ") } });
          }
        }
      },
    };
  },
});
