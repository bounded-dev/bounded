// The parsed shape of a design contract, as every skeleton emitter sees it
// (TN-26-012, ADR LEG-2026-060). TYPES ONLY: the domain parser belongs to the ts
// pack's contract scaffolder, the feature parser to ts-hexagonal. Emitters in
// other packs code against these interfaces, never against a parser's
// internals, so a parser can change without touching an emitter.
//
// Every path is project-relative with `/` separators. Every list is in
// declaration order in the contract file unless it says otherwise, because
// declaration order is meaningful: it fixes constructor parameter order.

/** A type as written in a contract, resolved as far as an emitter needs.
 *  `text` is always the source text, whitespace-normalised, so an emitter
 *  can print a type it does not otherwise understand. */
export type TypeRef =
  | { readonly kind: "primitive"; readonly text: string; readonly name: "string" | "number" | "boolean" }
  | { readonly kind: "void"; readonly text: "void" }
  /** A domain concept, by its interface name (`ProjectId`). */
  | { readonly kind: "concept"; readonly text: string; readonly name: string }
  /** A name declared in the same contract file (`CreateNoteCommand`). */
  | { readonly kind: "local"; readonly text: string; readonly name: string }
  | { readonly kind: "array"; readonly text: string; readonly element: TypeRef }
  | { readonly kind: "promise"; readonly text: string; readonly value: TypeRef }
  /** `Result<T>` from the domain's shared result module. */
  | { readonly kind: "result"; readonly text: string; readonly value: TypeRef }
  /** An object literal type, e.g. an entity's `toJSON()` return. */
  | { readonly kind: "object"; readonly text: string; readonly fields: readonly FieldModel[] }
  /** Anything else, kept verbatim. Emitters that need structure refuse it. */
  | { readonly kind: "other"; readonly text: string };

export interface FieldModel {
  readonly name: string;
  readonly type: TypeRef;
  /** Declared `readonly`. Contract lint requires it for concept fields. */
  readonly readonly: boolean;
}

export interface ParameterModel {
  readonly name: string;
  readonly type: TypeRef;
}

export interface MethodModel {
  readonly name: string;
  readonly parameters: readonly ParameterModel[];
  readonly returns: TypeRef;
}

// --- domain ------------------------------------------------------------------

/**
 * value-object: factory has `parse` and no `generate` or construct signature.
 * identifier:   a value object whose factory also has `generate()`.
 * entity:       factory has a construct signature `new (...)`.
 */
export type ConceptKind = "value-object" | "identifier" | "entity";

/** One member of the `<Name>Factory` interface (the static side). */
export type FactoryMember =
  | { readonly kind: "construct"; readonly parameters: readonly ParameterModel[] }
  | ({ readonly kind: "method" } & MethodModel);

/** A contract-file import: always `import type`, from another contract or
 *  the shared result module. */
export interface ContractImport {
  readonly specifier: string;
  readonly names: readonly string[];
}

/** One domain concept: `<area>/<concept>.contract.ts` in a context's domain. */
export interface DomainConceptModel {
  readonly kind: ConceptKind;
  /** The interface name, e.g. `NoteId`. The factory is `<name>Factory`, the
   *  unexported implementation class `<name>Impl`. */
  readonly name: string;
  /** The kebab-case file stem, e.g. `note-id`. */
  readonly stem: string;
  /** The context directory name, e.g. `project-management`. */
  readonly context: string;
  /** The plural business area, e.g. `notes`. */
  readonly area: string;
  /** `contexts/<context>/src/domain/<area>/<stem>.contract.ts` */
  readonly contractPath: string;
  /** `contexts/<context>/src/domain/<area>/<stem>.ts` */
  readonly implementationPath: string;
  /** The JSDoc summary on the instance interface, if any. */
  readonly doc?: string;
  /** Readonly properties of the instance interface except `__brand`
   *  (a value object's `value`; an entity's identity and value objects). */
  readonly fields: readonly FieldModel[];
  /** Methods of the instance interface (`equals`, `toJSON`, behaviour). */
  readonly instanceMethods: readonly MethodModel[];
  /** Members of `<name>Factory` (`parse`, `generate`, `new (...)`). */
  readonly factoryMembers: readonly FactoryMember[];
  readonly imports: readonly ContractImport[];
}

// --- application ---------------------------------------------------------------

/** One Input field and the Command field it is validated into. Input and
 *  Command declare the same field names in the same order (TN-26-012). */
export interface InputFieldModel {
  readonly name: string;
  /** The Input field's wire type; only these three are accepted. */
  readonly wireType: "string" | "number" | "boolean";
  /** The value object the Command holds, whose `parse` validates the field. */
  readonly concept: string;
}

/** Present exactly when the feature takes input. */
export interface FeatureInputModel {
  /** `<Feature>Input` */
  readonly inputName: string;
  /** `<Feature>Command` */
  readonly commandName: string;
  /** `<Feature>CommandFactory` */
  readonly commandFactoryName: string;
  /** `<feature>Schema`, exported by the generated command file. */
  readonly schemaName: string;
  readonly fields: readonly InputFieldModel[];
}

/** What `execute` resolves to, reduced to the cases in-adapters map. */
export interface ReturnModel {
  /** Source text of the whole return type, e.g. `Promise<Result<Note>>`. */
  readonly text: string;
  /** Wrapped in `Result<…>`: the feature has an expected business failure. */
  readonly result: boolean;
  /** `void`, one concept, or an array of one concept. */
  readonly shape: "void" | "value" | "array";
  /** The concept name for `value` and `array`; absent for `void`. */
  readonly concept?: string;
}

export interface InPortModel {
  /** The feature name in PascalCase, e.g. `CreateNote`. */
  readonly name: string;
  /** `execute(command: <Feature>Command)`; absent when `execute()` takes none. */
  readonly parameter?: ParameterModel;
  readonly returns: ReturnModel;
}

export interface OutPortModel {
  /** e.g. `CreateNoteStore`, `ProjectExporter`. */
  readonly name: string;
  /** Last word of the name, lowercased: the adapter file role suffix and the
   *  handler constructor parameter name (`store`, `exporter`). */
  readonly role: string;
  /** Named exactly `<Feature>Store`: implemented once per composed storage
   *  technology. Every other out port names its technologies with
   *  `@implementedBy`. */
  readonly isStore: boolean;
  readonly methods: readonly MethodModel[];
  /** Adapter technology ids from `@implementedBy`; empty for a store. */
  readonly implementedBy: readonly string[];
  readonly doc?: string;
}

/** One feature: `<area>/<feature>/<feature>.contract.ts` in a context's
 *  application layer. */
export interface FeatureContractModel {
  readonly context: string;
  readonly area: string;
  /** Verb-first kebab-case, e.g. `create-note`. */
  readonly feature: string;
  /** By the feature's verb (see `featureKind` in naming.ts). */
  readonly kind: "command" | "query";
  /** `contexts/<context>/src/application/<area>/<feature>/<feature>.contract.ts` */
  readonly contractPath: string;
  /** The module the contract imports domain types from:
   *  `@<scope>/<context>/domain` (ADR LEG-2026-059, Q3). */
  readonly domainImport: string;
  /** Domain concept names the contract imports, sorted; `Result` excluded. */
  readonly domainTypes: readonly string[];
  readonly input?: FeatureInputModel;
  readonly inPort: InPortModel;
  /** In declaration order: this is the handler constructor's order. */
  readonly outPorts: readonly OutPortModel[];
  /** Adapter technology ids from `@exposedVia` on the in port; empty when
   *  the tag is absent. */
  readonly exposedVia: readonly string[];
  /** The JSDoc summary on the in port: the MCP tool description. */
  readonly doc?: string;
}
