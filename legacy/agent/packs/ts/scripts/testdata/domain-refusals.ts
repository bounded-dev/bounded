// Domain contracts the domain-concept parser refuses, each with the reason it
// gives (ADR LEG-2026-059). Shared by the parser's tests and by contract-purity's
// parity test: every case the lint can see must fail the lint too, so
// lint-passing implies emittable. `lintBlind` names the few only the parser
// can judge, and why.

import { exampleConcept } from "./example-domain.ts";

export interface DomainRefusal {
  readonly label: string;
  readonly path: string;
  readonly source: string;
  /** What the parser's refusal says. */
  readonly parser: RegExp;
  /** Why the lint cannot see this one, when it cannot. */
  readonly lintBlind?: string;
}

export const REFUSAL_PATH = "contexts/pm/src/domain/projects/project-name.contract.ts";
const PATH = REFUSAL_PATH;

export function vo(instance: string, factory = "parse(raw: unknown): Result<ProjectName>;", imports = 'import type { Result } from "../shared/result.ts";'): string {
  return `${imports}\n\nexport interface ProjectName {\n  ${instance}\n}\n\nexport interface ProjectNameFactory {\n  ${factory}\n}\n`;
}

export const VO_MEMBERS = 'readonly __brand: "ProjectName";\n  readonly value: string;\n  equals(other: ProjectName): boolean;\n  toJSON(): string;';

const VALUE_OBJECT_CASES: [string, string, string, RegExp][] = [
  ["a path outside the layout", "src/domain/project-name.contract.ts", vo(VO_MEMBERS), /contexts\/<context>\/src\/domain/],
  ["the retired declare class", PATH, 'export declare class ProjectName {\n  private readonly __brand: "ProjectName";\n  static parse(raw: unknown): ProjectName | undefined;\n}\n', /declares exactly/],
  ["a syntax error", PATH, vo(VO_MEMBERS).replace("}", ""), /does not parse/],
  ["a name that is not the file's", "contexts/pm/src/domain/projects/project-title.contract.ts", vo(VO_MEMBERS), /declares 'ProjectName'/],
  ["a third declaration", PATH, `${vo(VO_MEMBERS)}export type Alias = string;\n`, /declares exactly/],
  ["an unexported factory", PATH, vo(VO_MEMBERS).replace("export interface ProjectNameFactory", "interface ProjectNameFactory"), /declares exactly/],
  ["no factory", PATH, `import type { Result } from "../shared/result.ts";\nexport interface ProjectName {\n  ${VO_MEMBERS}\n}\n`, /no 'export interface ProjectNameFactory'/],
  ["a generic instance", PATH, vo(VO_MEMBERS).replace("interface ProjectName {", "interface ProjectName<T> {"), /generic or extends/],
  ["an extending instance", PATH, vo(VO_MEMBERS).replace("interface ProjectName {", "interface ProjectName extends Base {"), /generic or extends/],
  ["a value import", PATH, vo(VO_MEMBERS, undefined, 'import { Result } from "../shared/result.ts";'), /import type/],
  ["an implementation import", PATH, vo(VO_MEMBERS, undefined, 'import type { Result } from "../shared/result.ts";\nimport type { ProjectId } from "./project-id.ts";'), /imports only other domain contracts/],
  ["the domain barrel", PATH, vo(VO_MEMBERS, undefined, 'import type { Result } from "@example/pm/domain";'), /imports only other domain contracts/],
  ["an aliased import", PATH, vo(VO_MEMBERS, undefined, 'import type { Result as R } from "../shared/result.ts";'), /no alias/],
  ["a duplicate import", PATH, vo(VO_MEMBERS, undefined, 'import type { Result } from "../shared/result.ts";\nimport type { Result } from "../shared/result.ts";'), /imported twice/],
  ["the brand missing", PATH, vo('readonly value: string;\n  equals(other: ProjectName): boolean;\n  toJSON(): string;'), /first member must be 'readonly __brand: "ProjectName";'/],
  ["the brand mismatched", PATH, vo(VO_MEMBERS.replace('"ProjectName";', '"Name";')), /__brand/],
  ["a mutable field", PATH, vo(VO_MEMBERS.replace("readonly value", "value")), /must be readonly/],
  ["an optional method", PATH, vo(VO_MEMBERS.replace("toJSON()", "toJSON?()")), /is optional/],
  ["an overload", PATH, vo(`${VO_MEMBERS}\n  toJSON(): string;`), /declared twice/],
  ["an accessor", PATH, vo(`${VO_MEMBERS}\n  get upper(): string;`), /not a field or a method/],
  ["no equals", PATH, vo('readonly __brand: "ProjectName";\n  readonly value: string;\n  toJSON(): string;'), /equals\(other: ProjectName\): boolean/],
  ["no toJSON", PATH, vo('readonly __brand: "ProjectName";\n  readonly value: string;\n  equals(other: ProjectName): boolean;'), /toJSON\(\)/],
  ["toJSON of another type", PATH, vo(VO_MEMBERS.replace("toJSON(): string", "toJSON(): number")), /toJSON\(\): string/],
  ["two fields", PATH, vo(`${VO_MEMBERS}\n  readonly slug: string;`), /exactly one field/],
  ["a non-primitive value", PATH, vo(VO_MEMBERS.replace("readonly value: string", "readonly value: Date")), /exactly one field/],
  ["parse returning undefined", PATH, vo(VO_MEMBERS, "parse(raw: unknown): ProjectName | undefined;"), /parse\(raw: unknown\): Result<ProjectName>/],
  ["parse of a string", PATH, vo(VO_MEMBERS, "parse(raw: string): Result<ProjectName>;"), /parse\(raw: unknown\)/],
  ["parse with a renamed parameter", PATH, vo(VO_MEMBERS, "parse(input: unknown): Result<ProjectName>;"), /parse\(raw: unknown\)/],
  ["parse without Result imported", PATH, vo(VO_MEMBERS, undefined, ""), /import type \{ Result \}/],
  ["an optional parse parameter", PATH, vo(VO_MEMBERS, "parse(raw?: unknown): Result<ProjectName>;"), /plain 'name: Type'/],
  ["a generate that takes input", PATH, vo(VO_MEMBERS, "parse(raw: unknown): Result<ProjectName>;\n  generate(seed: string): ProjectName;"), /generate\(\): ProjectName/],
  ["an extra factory method", PATH, vo(VO_MEMBERS, "parse(raw: unknown): Result<ProjectName>;\n  of(a: string): ProjectName;"), /holds 'parse'/],
  ["a factory property", PATH, vo(VO_MEMBERS, "parse(raw: unknown): Result<ProjectName>;\n  readonly max: number;"), /a factory holds/],
];

const entity = exampleConcept("project");
const ENTITY_CASES: [string, string, RegExp][] = [
  ["construct params out of order", entity.contract.replace("new (id: ProjectId, name: ProjectName)", "new (name: ProjectName, id: ProjectId)"), /must take Project's fields in declaration order/],
  ["a construct param missing", entity.contract.replace("new (id: ProjectId, name: ProjectName)", "new (id: ProjectId)"), /fields in declaration order/],
  ["a construct returning another type", entity.contract.replace("): Project;\n}", "): ProjectId;\n}"), /construct signature must return 'Project'/],
  ["two constructors", entity.contract.replace("new (id: ProjectId, name: ProjectName): Project;", "new (id: ProjectId, name: ProjectName): Project;\n  new (id: ProjectId, name: ProjectName): Project;"), /exactly one 'new/],
  ["a parse beside the constructor", entity.contract.replace("new (id: ProjectId, name: ProjectName): Project;", "new (id: ProjectId, name: ProjectName): Project;\n  parse(raw: unknown): Project;"), /exactly one 'new/],
  ["identity not first", entity.contract.replace("readonly id: ProjectId;\n  readonly name: ProjectName;", "readonly name: ProjectName;\n  readonly id: ProjectId;").replace("new (id: ProjectId, name: ProjectName)", "new (name: ProjectName, id: ProjectId)"), /first field must be its identity/],
  ["a primitive field", entity.contract.replace("readonly name: ProjectName;", "readonly name: string;").replace("name: ProjectName)", "name: string)"), /imported value objects and identifiers only/],
  ["a field of an unimported type", entity.contract.replace("readonly name: ProjectName;", "readonly name: Title;").replace("name: ProjectName)", "name: Title)"), /imported value objects and identifiers only/],
  ["toJSON missing a field", entity.contract.replace("toJSON(): { readonly id: string; readonly name: string };", "toJSON(): { readonly id: string };"), /one readonly primitive per field/],
  ["toJSON with a concept", entity.contract.replace("toJSON(): { readonly id: string; readonly name: string };", "toJSON(): { readonly id: ProjectId; readonly name: string };"), /one readonly primitive per field/],
];

/** The independent review's repros: shapes the lint once let through. */
const REVIEW_CASES: [string, string, string, RegExp][] = [
  ["a local Result shadowing the shared one", PATH, vo(VO_MEMBERS, undefined, "type Result<T> = T | undefined;"), /declares exactly/],
  ["an extending factory", PATH, vo(VO_MEMBERS).replace("interface ProjectNameFactory {", "interface ProjectNameFactory extends Extra {"), /generic or extends/],
  ["an optional equals", PATH, vo(VO_MEMBERS.replace("equals(", "equals?(")), /is optional/],
  ["a generic method", PATH, vo(VO_MEMBERS.replace("equals(other", "equals<T>(other")), /is generic/],
  ["a method with no return type", PATH, vo(`${VO_MEMBERS}\n  initials();`), /no return type/],
  ["a rest parameter", PATH, vo(`${VO_MEMBERS}\n  join(...parts: ProjectName[]): ProjectName;`), /plain 'name: Type'/],
  ["an import() type", PATH, vo(`${VO_MEMBERS}\n  owner(): import("../projects/project-id.ts").ProjectId;`), /import\(/],
  ["an extra exported type", PATH, `${vo(VO_MEMBERS)}export type Shade = "a" | "b";\n`, /declares exactly/],
  [
    "an Input/Command pair in the domain",
    "contexts/pm/src/domain/notes/foo.contract.ts",
    'import type { Result } from "../shared/result.ts";\nexport interface FooInput { readonly x: string }\nexport interface FooCommand { readonly __brand: "FooCommand"; readonly x: string }\nexport interface FooCommandFactory { parse(raw: unknown): Result<FooCommand>; }\n',
    /declares 'FooInput'/,
  ],
  [
    "an entity with a create method instead of new",
    "contexts/pm/src/domain/notes/note.contract.ts",
    'import type { NoteId } from "./note-id.contract.ts";\nexport interface Note {\n  readonly __brand: "Note";\n  readonly id: NoteId;\n  equals(other: Note): boolean;\n  toJSON(): { readonly id: string };\n}\nexport interface NoteFactory {\n  create(id: NoteId): Note;\n}\n',
    /holds 'parse'|parse\(raw: unknown\)/,
  ],
  ["an import of the concept's own name", PATH, vo(VO_MEMBERS, undefined, 'import type { Result } from "../shared/result.ts";\nimport type { ProjectName } from "./project-name.contract.ts";'), /imports 'ProjectName'/],
];

const BLIND: Readonly<Record<string, string>> = {
  "a path outside the layout": "the layout is a path rule: the emitter only reads contracts at contexts/<ctx>/src/domain/<area>/, and a file elsewhere is simply not a domain concept to the lint",
};

export const DOMAIN_REFUSALS: readonly DomainRefusal[] = [
  ...VALUE_OBJECT_CASES.map(([label, path, source, parser]) => ({ label, path, source, parser, ...(BLIND[label] === undefined ? {} : { lintBlind: BLIND[label] }) })),
  ...ENTITY_CASES.map(([label, source, parser]) => ({ label: `entity: ${label}`, path: entity.contractPath, source, parser })),
  ...REVIEW_CASES.map(([label, path, source, parser]) => ({ label, path, source, parser })),
];
