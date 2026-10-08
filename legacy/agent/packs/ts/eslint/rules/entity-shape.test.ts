import { afterAll, describe, it } from "vitest";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { entityShape } from "./entity-shape.ts";
import { EXAMPLE_CONCEPTS } from "../../scripts/testdata/example-domain.ts";

// ADR 2026-059: an entity's contract is `interface <Name>` + a factory whose
// only member is `new (…fields): <Name>`. Both example entities pass; each
// near miss fails with the fix.

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

const IMPORTS = `import type { ProjectId } from "./project-id.contract.ts";
import type { ProjectName } from "./project-name.contract.ts";
`;

function entity(opts: { instance?: string; factory?: string } = {}): string {
  const instance = opts.instance ??
    'readonly __brand: "Project";\n  readonly id: ProjectId;\n  readonly name: ProjectName;\n  equals(other: Project): boolean;\n  toJSON(): { readonly id: string; readonly name: string };';
  const factory = opts.factory ?? "new (id: ProjectId, name: ProjectName): Project;";
  return `${IMPORTS}\nexport interface Project {\n  ${instance}\n}\n\nexport interface ProjectFactory {\n  ${factory}\n}\n`;
}

const MEMBERS_AFTER_BRAND =
  "readonly id: ProjectId;\n  readonly name: ProjectName;\n  equals(other: Project): boolean;\n  toJSON(): { readonly id: string; readonly name: string };";

ruleTester.run("entity-shape", entityShape, {
  valid: [
    ...EXAMPLE_CONCEPTS.map((c) => ({ code: c.contract, filename: c.contractPath })),
    entity(),
    // toJSON written across lines, with trailing separators
    entity({
      instance: 'readonly __brand: "Project";\n  readonly id: ProjectId;\n  readonly name: ProjectName;\n  equals(other: Project): boolean;\n  toJSON(): {\n    readonly id: string;\n    readonly name: string;\n  };',
    }),
    // behaviour on the instance side is welcome
    entity({ instance: `readonly __brand: "Project";\n  ${MEMBERS_AFTER_BRAND}\n  rename(name: ProjectName): Project;` }),
    // value objects are value-object-shape's business
    EXAMPLE_CONCEPTS[0]!.contract,
  ],

  invalid: [
    {
      code: entity({ instance: MEMBERS_AFTER_BRAND }),
      errors: [{ messageId: "brand" }],
    },
    {
      code: entity({ instance: `readonly __brand: "Projects";\n  ${MEMBERS_AFTER_BRAND}` }),
      errors: [{ messageId: "brand" }],
    },
    // identity first
    {
      code: entity({
        instance: 'readonly __brand: "Project";\n  readonly name: ProjectName;\n  readonly id: ProjectId;\n  equals(other: Project): boolean;\n  toJSON(): { readonly name: string; readonly id: string };',
        factory: "new (name: ProjectName, id: ProjectId): Project;",
      }),
      errors: [{ messageId: "identity" }],
    },
    {
      code: entity({ instance: 'readonly __brand: "Project";\n  equals(other: Project): boolean;\n  toJSON(): {};', factory: "new (): Project;" }),
      errors: [{ messageId: "fields" }],
    },
    // a naked primitive, a mutable field, an optional field, an array
    {
      code: entity({
        instance: 'readonly __brand: "Project";\n  readonly id: ProjectId;\n  readonly name: string;\n  equals(other: Project): boolean;\n  toJSON(): { readonly id: string; readonly name: string };',
        factory: "new (id: ProjectId, name: string): Project;",
      }),
      errors: [{ messageId: "fieldType" }],
    },
    {
      code: entity({ instance: MEMBERS_AFTER_BRAND.replace("readonly name", "name").replace(/^/, 'readonly __brand: "Project";\n  ') }),
      errors: [{ messageId: "fieldType" }],
    },
    {
      code: entity({ instance: MEMBERS_AFTER_BRAND.replace("readonly name:", "readonly name?:").replace(/^/, 'readonly __brand: "Project";\n  ') }),
      errors: [{ messageId: "fieldType" }],
    },
    {
      code: entity({
        instance: 'readonly __brand: "Project";\n  readonly id: ProjectId;\n  readonly name: ProjectName[];\n  equals(other: Project): boolean;\n  toJSON(): { readonly id: string; readonly name: string };',
        factory: "new (id: ProjectId, name: ProjectName[]): Project;",
      }),
      errors: [{ messageId: "fieldType" }],
    },
    // a field of a type the file does not import: not a concept the emitter can resolve
    {
      code: entity({
        instance: 'readonly __brand: "Project";\n  readonly id: ProjectId;\n  readonly name: Title;\n  equals(other: Project): boolean;\n  toJSON(): { readonly id: string; readonly name: string };',
        factory: "new (id: ProjectId, name: Title): Project;",
      }),
      errors: [{ messageId: "fieldType" }],
    },
    // an entity holding itself
    {
      code: entity({
        instance: 'readonly __brand: "Project";\n  readonly id: ProjectId;\n  readonly parent: Project;\n  equals(other: Project): boolean;\n  toJSON(): { readonly id: string; readonly parent: string };',
        factory: "new (id: ProjectId, parent: Project): Project;",
      }),
      errors: [{ messageId: "fieldType" }],
    },
    // --- the construct signature ---------------------------------------------
    // params out of field order
    { code: entity({ factory: "new (name: ProjectName, id: ProjectId): Project;" }), errors: [{ messageId: "construct" }] },
    // a param renamed
    { code: entity({ factory: "new (projectId: ProjectId, name: ProjectName): Project;" }), errors: [{ messageId: "construct" }] },
    // a field missing from the constructor
    { code: entity({ factory: "new (id: ProjectId): Project;" }), errors: [{ messageId: "construct" }] },
    // optional param
    { code: entity({ factory: "new (id: ProjectId, name?: ProjectName): Project;" }), errors: [{ messageId: "construct" }] },
    // wrong return
    { code: entity({ factory: "new (id: ProjectId, name: ProjectName): ProjectId;" }), errors: [{ messageId: "construct" }] },
    // two constructors
    {
      code: entity({ factory: "new (id: ProjectId, name: ProjectName): Project;\n  new (id: ProjectId, name: ProjectName): Project;" }),
      errors: [{ messageId: "construct" }],
    },
    // a parse beside the constructor
    {
      code: entity({ factory: "new (id: ProjectId, name: ProjectName): Project;\n  parse(raw: unknown): Result<Project>;" }),
      errors: [{ messageId: "factoryMember" }],
    },
    // --- equals / toJSON --------------------------------------------------------
    {
      code: entity({ instance: 'readonly __brand: "Project";\n  readonly id: ProjectId;\n  readonly name: ProjectName;\n  toJSON(): { readonly id: string; readonly name: string };' }),
      errors: [{ messageId: "equals" }],
    },
    {
      code: entity({ instance: 'readonly __brand: "Project";\n  readonly id: ProjectId;\n  readonly name: ProjectName;\n  equals(other: ProjectId): boolean;\n  toJSON(): { readonly id: string; readonly name: string };' }),
      errors: [{ messageId: "equals" }],
    },
    // toJSON: a field missing, out of order, not readonly, not primitive, not an object
    {
      code: entity({ instance: 'readonly __brand: "Project";\n  readonly id: ProjectId;\n  readonly name: ProjectName;\n  equals(other: Project): boolean;\n  toJSON(): { readonly id: string };' }),
      errors: [{ messageId: "toJSON" }],
    },
    {
      code: entity({ instance: 'readonly __brand: "Project";\n  readonly id: ProjectId;\n  readonly name: ProjectName;\n  equals(other: Project): boolean;\n  toJSON(): { readonly name: string; readonly id: string };' }),
      errors: [{ messageId: "toJSON" }],
    },
    {
      code: entity({ instance: 'readonly __brand: "Project";\n  readonly id: ProjectId;\n  readonly name: ProjectName;\n  equals(other: Project): boolean;\n  toJSON(): { id: string; readonly name: string };' }),
      errors: [{ messageId: "toJSON" }],
    },
    {
      code: entity({ instance: 'readonly __brand: "Project";\n  readonly id: ProjectId;\n  readonly name: ProjectName;\n  equals(other: Project): boolean;\n  toJSON(): { readonly id: ProjectId; readonly name: string };' }),
      errors: [{ messageId: "toJSON" }],
    },
    {
      code: entity({ instance: 'readonly __brand: "Project";\n  readonly id: ProjectId;\n  readonly name: ProjectName;\n  equals(other: Project): boolean;\n  toJSON(): string;' }),
      errors: [{ messageId: "toJSON" }],
    },
    // an accessor is not part of an entity
    {
      code: entity({ instance: `readonly __brand: "Project";\n  ${MEMBERS_AFTER_BRAND}\n  get label(): string;` }),
      errors: [{ messageId: "member" }],
    },
  ],
});
