import { afterAll, describe, it } from "vitest";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { valueObjectDocumented } from "./value-object-documented.ts";
import { DOCUMENTED_CONCEPTS, documentedConcept, exampleConcept } from "../../scripts/testdata/example-domain.ts";

// ADR 2026-059: every value object carries two different `@accepts` examples
// (the generated laws' samples, so no law is ever skipped), each a literal of
// the value's own type; an identifier needs them too (its only valid literal
// the blind test-writer can see); a doc comment is never empty; an entity
// takes no @accepts.

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

function vo(doc: string, valueType = "string", name = "ProjectName"): string {
  return `import type { Result } from "../shared/result.ts";

${doc}
export interface ${name} {
  readonly __brand: "${name}";
  readonly value: ${valueType};
  equals(other: ${name}): boolean;
  toJSON(): ${valueType};
}

export interface ${name}Factory {
  parse(raw: unknown): Result<${name}>;
}
`;
}

const TWO = '/**\n * The name of a project.\n * @accepts "Website relaunch"\n * @accepts "Office move"\n */';

const ENTITY = `/**
 * A project.
 * @accepts "x"
 */
export interface Project {
  readonly __brand: "Project";
  readonly id: ProjectId;
  equals(other: Project): boolean;
  toJSON(): { readonly id: string };
}

export interface ProjectFactory {
  new (id: ProjectId): Project;
}
`;

ruleTester.run("value-object-documented", valueObjectDocumented, {
  valid: [
    // the worked example as the gates require it: documented value objects
    // and identifiers, and entities with no examples at all
    ...DOCUMENTED_CONCEPTS.map((c) => c.contract),
    vo(TWO),
    vo('/** @accepts "Website relaunch"\n * @accepts "Office move" */'),
    vo('/** Escapes are fine. @accepts is prose here.\n * @accepts "say \\"hi\\""\n * @accepts "bye"\n */'),
    vo("/**\n * Pages read.\n * @accepts 0\n * @accepts 12.5\n * @accepts -3\n */", "number", "PagesRead"),
    vo("/**\n * A flag.\n * @accepts true\n * @accepts false\n */", "boolean", "Flag"),
    // an entity with a doc comment but no @accepts
    ENTITY.replace(' * @accepts "x"\n', ""),
    // interfaces that are not concepts are out of scope
    '/** @accepts nonsense */\nexport interface Store { save(): Promise<void>; }',
  ],
  invalid: [
    // the worked example's plain value objects, as the example ships them
    { code: exampleConcept("note-text").contract, errors: [{ messageId: "missingAccepts", data: { name: "NoteText", kind: "a value object", found: "no doc comment", rule: "What makes a NoteText valid.", sample: '@accepts "Website relaunch"', sample2: '@accepts "Office move"' } }] },
    { code: exampleConcept("project-name").contract, errors: [{ messageId: "missingAccepts" }] },
    // the worked example's identifiers, as the example ships them
    { code: exampleConcept("project-id").contract, errors: [{ messageId: "missingAccepts", data: { name: "ProjectId", kind: "an identifier", found: "no doc comment", rule: "What makes a ProjectId valid.", sample: '@accepts "7c9e6679-7425-40de-944b-e07fc1f90ae7"', sample2: '@accepts "16fd2706-8baf-433b-82eb-8c7fada847da"' } }] },
    { code: documentedConcept("note-id").contract.replace(/ \* @accepts "16fd[^\n]*\n/, ""), errors: [{ messageId: "missingAccepts", data: { name: "NoteId", kind: "an identifier", found: "one @accepts tag", rule: "What makes a NoteId valid.", sample: '@accepts "7c9e6679-7425-40de-944b-e07fc1f90ae7"', sample2: '@accepts "16fd2706-8baf-433b-82eb-8c7fada847da"' } }] },
    // a `//` comment is not a doc comment
    { code: vo("// just a note"), errors: [{ messageId: "missingAccepts" }] },
    { code: vo("/** The name of a project: not empty once trimmed. */"), errors: [{ messageId: "missingAccepts", data: { name: "ProjectName", kind: "a value object", found: "no @accepts tag", rule: "What makes a ProjectName valid.", sample: '@accepts "Website relaunch"', sample2: '@accepts "Office move"' } }] },
    { code: vo('/** @accepts "Website relaunch" */'), errors: [{ messageId: "missingAccepts" }] },
    // mid-sentence mentions are prose, not tags
    { code: vo("/** Add an @accepts example when you know one. */"), errors: [{ messageId: "missingAccepts" }] },
    // two examples that trim to one value
    { code: vo('/**\n * @accepts "Office"\n * @accepts "  Office "\n */'), errors: [{ messageId: "sameAccepts" }] },
    { code: vo('/**\n * @accepts "Office"\n * @accepts "Office"\n */'), errors: [{ messageId: "sameAccepts" }] },
    { code: vo("/**\n * @accepts 3\n * @accepts 3\n */", "number", "PagesRead"), errors: [{ messageId: "sameAccepts" }] },
    { code: vo("/** */"), errors: [{ messageId: "emptyDoc", data: { name: "ProjectName" } }, { messageId: "missingAccepts" }] },
    // an example that is not a literal, or not of the value's type
    { code: vo('/**\n * @accepts Website relaunch\n * @accepts "Office move"\n */'), errors: [{ messageId: "badAccepts" }] },
    { code: vo("/**\n * @accepts 'Website'\n * @accepts \"Office move\"\n */"), errors: [{ messageId: "badAccepts" }] },
    { code: vo('/**\n * @accepts "Website" // the usual\n * @accepts "Office move"\n */'), errors: [{ messageId: "badAccepts" }] },
    { code: vo('/**\n * @accepts 42\n * @accepts "Office move"\n */'), errors: [{ messageId: "badAccepts", data: { name: "ProjectName", example: "42", type: "string", sample: '@accepts "Website relaunch"' } }] },
    { code: vo('/**\n * @accepts "12"\n * @accepts 3\n */', "number", "PagesRead"), errors: [{ messageId: "badAccepts" }] },
    { code: vo("/**\n * @accepts 1e3\n * @accepts 3\n */", "number", "PagesRead"), errors: [{ messageId: "badAccepts" }] },
    { code: vo('/**\n * @accepts "true"\n * @accepts false\n */', "boolean", "Flag"), errors: [{ messageId: "badAccepts" }] },
    // an entity has no parse, so @accepts means nothing there
    { code: ENTITY, errors: [{ messageId: "acceptsOnEntity", data: { name: "Project" } }] },
  ],
});
