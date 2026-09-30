import { afterAll, describe, it } from "vitest";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { valueObjectDocumented } from "./value-object-documented.ts";
import { EXAMPLE_CONCEPTS } from "../../scripts/testdata/example-domain.ts";

// ADR 2026-059: a concept's doc comment is optional (the worked example has
// none), but when present it says something, and its `@accepts` examples are
// literals of the value's own type, because the generated laws print them.

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
    // the worked example: no doc comments at all
    ...EXAMPLE_CONCEPTS.map((c) => c.contract),
    // a summary with no tags
    vo("/** The name of a project: not empty once trimmed. */"),
    // examples of each value type
    vo('/**\n * The name of a project.\n * @accepts "Website relaunch"\n * @accepts "Office move"\n */'),
    vo('/** @accepts "Website relaunch" */'),
    vo('/** Escapes are fine. @accepts is prose here.\n * @accepts "say \\"hi\\""\n */'),
    vo("/**\n * Pages read.\n * @accepts 0\n * @accepts 12.5\n * @accepts -3\n */", "number", "PagesRead"),
    vo("/**\n * A flag.\n * @accepts true\n */", "boolean", "Flag"),
    // a `//` comment is not a doc comment: nothing to check
    vo("// just a note"),
    // mid-sentence mentions are prose, not tags
    vo("/** Add an @accepts example when you know one. */"),
    // an entity with a doc comment but no @accepts
    ENTITY.replace(' * @accepts "x"\n', ""),
    // interfaces that are not concepts are out of scope
    '/** @accepts nonsense */\nexport interface Store { save(): Promise<void>; }',
  ],
  invalid: [
    { code: vo("/** */"), errors: [{ messageId: "emptyDoc", data: { name: "ProjectName" } }] },
    { code: vo("/**\n *\n */"), errors: [{ messageId: "emptyDoc" }] },
    // an example that is not a literal, or not of the value's type
    { code: vo("/** @accepts Website relaunch */"), errors: [{ messageId: "badAccepts" }] },
    { code: vo("/** @accepts 'Website relaunch' */"), errors: [{ messageId: "badAccepts" }] },
    { code: vo("/** @accepts `Website` */"), errors: [{ messageId: "badAccepts" }] },
    { code: vo('/** @accepts "Website" // the usual */'), errors: [{ messageId: "badAccepts" }] },
    { code: vo("/** @accepts 42 */"), errors: [{ messageId: "badAccepts", data: { name: "ProjectName", example: "42", type: "string", sample: '@accepts "Website relaunch"' } }] },
    { code: vo('/** @accepts "12" */', "number", "PagesRead"), errors: [{ messageId: "badAccepts" }] },
    { code: vo("/** @accepts 1e3 */", "number", "PagesRead"), errors: [{ messageId: "badAccepts" }] },
    { code: vo("/** @accepts 007 */", "number", "PagesRead"), errors: [{ messageId: "badAccepts" }] },
    { code: vo('/** @accepts "true" */', "boolean", "Flag"), errors: [{ messageId: "badAccepts" }] },
    { code: vo("/** @accepts */"), errors: [{ messageId: "badAccepts" }] },
    // one report per bad example
    {
      code: vo('/**\n * @accepts "ok"\n * @accepts nope\n * @accepts 3\n */'),
      errors: [{ messageId: "badAccepts" }, { messageId: "badAccepts" }],
    },
    // an entity has no parse, so @accepts means nothing there
    { code: ENTITY, errors: [{ messageId: "acceptsOnEntity", data: { name: "Project" } }] },
  ],
});
