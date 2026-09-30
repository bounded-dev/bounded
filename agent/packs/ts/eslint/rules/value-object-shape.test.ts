import { afterAll, describe, it } from "vitest";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { valueObjectShape } from "./value-object-shape.ts";
import { EXAMPLE_CONCEPTS, exampleConcept } from "../../scripts/testdata/example-domain.ts";

// ADR 2026-059: a value object's contract is `interface <Name>` +
// `interface <Name>Factory`. Every example contract passes; every near miss of
// the canonical form fails with the message naming the fix.

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

const RESULT = 'import type { Result } from "../shared/result.ts";\n';

/** A value object contract with one part swapped out. */
function vo(opts: { instance?: string; factory?: string; name?: string } = {}): string {
  const name = opts.name ?? "ProjectName";
  const instance = opts.instance ??
    `readonly __brand: "${name}";\n  readonly value: string;\n  equals(other: ${name}): boolean;\n  toJSON(): string;`;
  const factory = opts.factory ?? `parse(raw: unknown): Result<${name}>;`;
  return `${RESULT}\nexport interface ${name} {\n  ${instance}\n}\n\nexport interface ${name}Factory {\n  ${factory}\n}\n`;
}

const FILE = "contexts/pm/src/domain/projects/project-name.contract.ts";

ruleTester.run("value-object-shape", valueObjectShape, {
  valid: [
    // Every contract of the worked example, at its own path.
    ...EXAMPLE_CONCEPTS.map((c) => ({ code: c.contract, filename: c.contractPath })),
    { code: vo(), filename: FILE },
    // an identifier: generate() beside parse, in either order
    {
      code: vo({ name: "ProjectId", factory: "parse(raw: unknown): Result<ProjectId>;\n  generate(): ProjectId;" }),
      filename: "contexts/pm/src/domain/projects/project-id.contract.ts",
    },
    // number and boolean values
    {
      code: vo({ name: "Quantity", instance: 'readonly __brand: "Quantity";\n  readonly value: number;\n  equals(other: Quantity): boolean;\n  toJSON(): number;' }),
      filename: "contexts/pm/src/domain/orders/quantity.contract.ts",
    },
    // behaviour on the instance side is welcome
    {
      code: vo({ instance: 'readonly __brand: "ProjectName";\n  readonly value: string;\n  equals(other: ProjectName): boolean;\n  toJSON(): string;\n  initials(): string;' }),
      filename: FILE,
    },
    // entities are entity-shape's; an application command is the feature parser's
    exampleConcept("note").contract,
    `export interface CreateNoteInput { readonly text: string; }
export interface CreateNoteCommand { readonly __brand: "CreateNoteCommand"; readonly text: NoteText; }
export interface CreateNoteCommandFactory { parse(raw: unknown): Result<CreateNoteCommand>; }`,
    // plain interfaces and a factory that is not a concept's are out of scope
    "export interface CreateNoteStore { save(note: Note): Promise<void>; }",
    "export interface WidgetFactory { build(): Widget; }",
    // outside a contract file name the stem is not checked
    { code: vo(), filename: "file.ts" },
  ],

  invalid: [
    // --- the brand -------------------------------------------------------------
    {
      code: vo({ instance: "readonly value: string;\n  equals(other: ProjectName): boolean;\n  toJSON(): string;" }),
      filename: FILE,
      errors: [{ messageId: "brand" }],
    },
    // brand string differs from the name: two unrelated types
    {
      code: vo({ instance: 'readonly __brand: "Projectname";\n  readonly value: string;\n  equals(other: ProjectName): boolean;\n  toJSON(): string;' }),
      filename: FILE,
      errors: [{ messageId: "brand" }],
    },
    // brand not readonly
    {
      code: vo({ instance: '__brand: "ProjectName";\n  readonly value: string;\n  equals(other: ProjectName): boolean;\n  toJSON(): string;' }),
      filename: FILE,
      errors: [{ messageId: "brand" }],
    },
    // optional brand: any object literal passes (and no member is optional)
    {
      code: vo({ instance: 'readonly __brand?: "ProjectName";\n  readonly value: string;\n  equals(other: ProjectName): boolean;\n  toJSON(): string;' }),
      filename: FILE,
      errors: [{ messageId: "shape" }, { messageId: "brand" }],
    },
    // brand not first
    {
      code: vo({ instance: 'readonly value: string;\n  readonly __brand: "ProjectName";\n  equals(other: ProjectName): boolean;\n  toJSON(): string;' }),
      filename: FILE,
      errors: [{ messageId: "brand" }],
    },
    // brand typed string, not the literal
    {
      code: vo({ instance: "readonly __brand: string;\n  readonly value: string;\n  equals(other: ProjectName): boolean;\n  toJSON(): string;" }),
      filename: FILE,
      errors: [{ messageId: "brand" }],
    },
    // --- the value field -------------------------------------------------------
    {
      code: vo({ instance: 'readonly __brand: "ProjectName";\n  readonly text: string;\n  equals(other: ProjectName): boolean;\n  toJSON(): string;' }),
      filename: FILE,
      errors: [{ messageId: "valueField" }],
    },
    {
      code: vo({ instance: 'readonly __brand: "ProjectName";\n  equals(other: ProjectName): boolean;\n  toJSON(): string;' }),
      filename: FILE,
      errors: [{ messageId: "valueField" }],
    },
    {
      code: vo({ instance: 'readonly __brand: "ProjectName";\n  readonly value: string;\n  readonly slug: string;\n  equals(other: ProjectName): boolean;\n  toJSON(): string;' }),
      filename: FILE,
      errors: [{ messageId: "valueField" }],
    },
    {
      code: vo({ instance: 'readonly __brand: "ProjectName";\n  readonly value: Date;\n  equals(other: ProjectName): boolean;\n  toJSON(): string;' }),
      filename: FILE,
      errors: [{ messageId: "valueField" }],
    },
    {
      code: vo({ instance: 'readonly __brand: "ProjectName";\n  value: string;\n  equals(other: ProjectName): boolean;\n  toJSON(): string;' }),
      filename: FILE,
      errors: [{ messageId: "mutableField" }],
    },
    // --- equals / toJSON ---------------------------------------------------------
    {
      code: vo({ instance: 'readonly __brand: "ProjectName";\n  readonly value: string;\n  toJSON(): string;' }),
      filename: FILE,
      errors: [{ messageId: "equals" }],
    },
    {
      code: vo({ instance: 'readonly __brand: "ProjectName";\n  readonly value: string;\n  equals(other: string): boolean;\n  toJSON(): string;' }),
      filename: FILE,
      errors: [{ messageId: "equals" }],
    },
    {
      code: vo({ instance: 'readonly __brand: "ProjectName";\n  readonly value: string;\n  equals(other: ProjectName): boolean;' }),
      filename: FILE,
      errors: [{ messageId: "toJSON" }],
    },
    // toJSON must return the value's own type
    {
      code: vo({ instance: 'readonly __brand: "ProjectName";\n  readonly value: string;\n  equals(other: ProjectName): boolean;\n  toJSON(): number;' }),
      filename: FILE,
      errors: [{ messageId: "toJSON" }],
    },
    // --- the factory ---------------------------------------------------------------
    // the retired return: T | undefined
    { code: vo({ factory: "parse(raw: unknown): ProjectName | undefined;" }), filename: FILE, errors: [{ messageId: "parse" }] },
    { code: vo({ factory: "parse(raw: string): Result<ProjectName>;" }), filename: FILE, errors: [{ messageId: "parse" }] },
    { code: vo({ factory: "parse(raw?: unknown): Result<ProjectName>;" }), filename: FILE, errors: [{ messageId: "parse" }, { messageId: "shape" }] },
    { code: vo({ factory: "parse(raw: unknown, strict: boolean): Result<ProjectName>;" }), filename: FILE, errors: [{ messageId: "parse" }] },
    { code: vo({ factory: "parse(raw: unknown): Result<ProjectId>;" }), filename: FILE, errors: [{ messageId: "parse" }] },
    { code: vo({ factory: "parse?(raw: unknown): Result<ProjectName>;" }), filename: FILE, errors: [{ messageId: "shape" }, { messageId: "parse" }] },
    // no parse at all
    { code: vo({ factory: "generate(): ProjectName;" }), filename: FILE, errors: [{ messageId: "parse" }] },
    {
      code: vo({ factory: "parse(raw: unknown): Result<ProjectName>;\n  generate(seed: string): ProjectName;" }),
      filename: FILE,
      errors: [{ messageId: "generate" }],
    },
    {
      code: vo({ factory: "parse(raw: unknown): Result<ProjectName>;\n  fromParts(a: string): ProjectName;" }),
      filename: FILE,
      errors: [{ messageId: "factoryMember" }],
    },
    {
      code: vo({ factory: "parse(raw: unknown): Result<ProjectName>;\n  readonly max: number;" }),
      filename: FILE,
      errors: [{ messageId: "factoryMember" }],
    },
    // accessors and index signatures are not part of a value object
    {
      code: vo({ instance: 'readonly __brand: "ProjectName";\n  readonly value: string;\n  equals(other: ProjectName): boolean;\n  toJSON(): string;\n  get initials(): string;' }),
      filename: FILE,
      errors: [{ messageId: "member" }],
    },
    {
      code: vo({ instance: 'readonly __brand: "ProjectName";\n  readonly value: string;\n  equals(other: ProjectName): boolean;\n  toJSON(): string;\n  [key: string]: unknown;' }),
      filename: FILE,
      errors: [{ messageId: "member" }],
    },
    // --- as strict as the domain-concept parser (lint-passing implies emittable) ---
    {
      code: vo().replace("export interface ProjectName {", "export interface ProjectName extends Mut {") + "export interface Mut { owner: string }\n",
      filename: FILE,
      errors: [{ messageId: "shape" }, { messageId: "domainFile" }],
    },
    {
      code: vo().replace("export interface ProjectNameFactory {", "export interface ProjectNameFactory extends Extra {"),
      filename: FILE,
      errors: [{ messageId: "shape" }],
    },
    { code: vo().replace("export interface ProjectName {", "export interface ProjectName<T> {"), filename: FILE, errors: [{ messageId: "shape" }] },
    { code: vo({ instance: 'readonly __brand: "ProjectName";\n  readonly value: string;\n  equals?(other: ProjectName): boolean;\n  toJSON(): string;' }), filename: FILE, errors: [{ messageId: "shape" }] },
    { code: vo({ instance: 'readonly __brand: "ProjectName";\n  readonly value: string;\n  equals(other: ProjectName): boolean;\n  toJSON(): string;\n  toJSON(): string;' }), filename: FILE, errors: [{ messageId: "shape" }] },
    { code: vo({ instance: 'readonly __brand: "ProjectName";\n  readonly value: string;\n  equals<T>(other: ProjectName): boolean;\n  toJSON(): string;' }), filename: FILE, errors: [{ messageId: "shape" }] },
    { code: vo({ instance: 'readonly __brand: "ProjectName";\n  readonly value: string;\n  equals(other: ProjectName): boolean;\n  toJSON(): string;\n  initials();' }), filename: FILE, errors: [{ messageId: "shape" }] },
    { code: vo({ instance: 'readonly __brand: "ProjectName";\n  readonly value: string;\n  equals(other: ProjectName): boolean;\n  toJSON(): string;\n  join(...parts: ProjectName[]): ProjectName;' }), filename: FILE, errors: [{ messageId: "shape" }] },
    { code: vo({ factory: "parse(input: unknown): Result<ProjectName>;" }), filename: FILE, errors: [{ messageId: "parse" }] },
    // Result must RESOLVE to the shared import, not merely read "Result"
    { code: vo().replace(RESULT, "type Result<T> = T | undefined;\n"), filename: FILE, errors: [{ messageId: "domainFile" }, { messageId: "resultSource" }] },
    { code: vo().replace(RESULT, "type Result<T> = T | undefined;\n"), filename: "src/readings/project-name.contract.ts", errors: [{ messageId: "resultSource" }] },
    { code: vo().replace("../shared/result.ts", "../shared/results.ts"), filename: FILE, errors: [{ messageId: "resultSource" }] },
    { code: vo().replace(RESULT, ""), filename: FILE, errors: [{ messageId: "resultSource" }] },
    // a domain contract is one concept and nothing else
    { code: `${vo()}export type Shade = "a" | "b";\n`, filename: FILE, errors: [{ messageId: "domainFile" }] },
    {
      code: `${RESULT}export interface FooInput { readonly x: string }\nexport interface FooCommand { readonly __brand: "FooCommand"; readonly value: string; equals(other: FooCommand): boolean; toJSON(): string; }\nexport interface FooCommandFactory { parse(raw: unknown): Result<FooCommand>; }\n`,
      filename: "contexts/pm/src/domain/notes/foo.contract.ts",
      errors: [{ messageId: "domainFile" }, { messageId: "fileName" }],
    },
    {
      code: vo().replace(RESULT, `${RESULT}import type { ProjectName } from "./project-name.contract.ts";\n`),
      filename: FILE,
      errors: [{ messageId: "domainFile" }],
    },
    // --- pairing and files ---------------------------------------------------------
    // branded, but no factory: no door in
    {
      code: 'export interface ProjectName { readonly __brand: "ProjectName"; readonly value: string; }',
      errors: [{ messageId: "missingFactory" }],
    },
    // the factory must be exported beside it, not merely declared
    {
      code: `${RESULT}export interface ProjectName { readonly __brand: "ProjectName"; readonly value: string; equals(other: ProjectName): boolean; toJSON(): string; }
interface ProjectNameFactory { parse(raw: unknown): Result<ProjectName>; }`,
      errors: [{ messageId: "missingFactory" }],
    },
    // file stem must be the concept's kebab-case
    { code: vo(), filename: "contexts/pm/src/domain/projects/name.contract.ts", errors: [{ messageId: "fileName" }] },
    { code: vo(), filename: "contexts/pm/src/domain/projects/projectname.contract.ts", errors: [{ messageId: "fileName" }] },
    // one concept per file
    {
      code: `${vo()}\n${vo({ name: "ProjectCode" }).replace(RESULT, "")}`,
      filename: FILE,
      errors: [{ messageId: "oneConceptPerFile", data: { name: "ProjectCode", stem: "project-code" } }],
    },
    // a value object beside an entity is still a second concept
    {
      code: `${exampleConcept("project").contract}\n${vo().replace(RESULT, "")}`,
      filename: "contexts/pm/src/domain/projects/project.contract.ts",
      errors: [{ messageId: "oneConceptPerFile" }, { messageId: "resultSource" }],
    },
  ],
});
