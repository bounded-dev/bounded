import type { Result } from "../shared/result.ts";

/** The brand only PackageCatalog itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const packageCatalogBrand: unique symbol;

// The package catalogue, version 1 (ADR 2026-029): the contract every reader
// of `bounded.catalog.json` reads. Within a version, fields are only added,
// and readers ignore fields they do not know.

/**
 * A point's wire form: the name of the type a contribution may be written as
 * (a value object's `WireOf<Value>`, or plain data's own type) and that
 * type's compile-time shape as JSON Schema. Limits only the point's run-time
 * check enforces are in its documentation and the pack's README.
 */
export interface CataloguedWireJSON {
  readonly type: string;
  readonly schema: Readonly<Record<string, unknown>>;
}

/** One extension point a pack declares, by its key (`<group>.<member>` for a group's member). */
export interface CataloguedPointJSON {
  /** `<pack id>.<key>`. */
  readonly id: string;
  readonly key: string;
  /** The point's own description, from the pack object. */
  readonly description: string;
  /** The TSDoc its pack's contract gives the point. */
  readonly documentation: string;
  /** The type of the values readers get. */
  readonly valueType: string;
  /** How a contribution is written; null when the point's values are code (a function). */
  readonly wire: CataloguedWireJSON | null;
}

/** One port a pack needs a host to provide through openProject({ ports }). */
export interface CataloguedPortJSON {
  /** `<pack id>#<key>`. */
  readonly id: string;
  readonly key: string;
  /** The interface an adapter of the port implements. */
  readonly adapterType: string;
  /** That interface's TSDoc, without its tags. */
  readonly documentation: string;
  /** That interface's declaration, as its contract writes it. */
  readonly declaration: string;
}

/** A README section beyond the required ones, in the order the README gives it. */
export interface CataloguedSectionJSON {
  readonly heading: string;
  readonly markdown: string;
}

/** A pack's README, its required sections' bodies as Markdown. */
export interface CataloguedReadmeJSON {
  /** Its package-relative path. */
  readonly path: string;
  /** What comes between its title and its first section; empty when nothing does. */
  readonly introduction: string;
  readonly whatItIsFor: string;
  readonly ruleShape: string;
  readonly workflowsItFits: string;
  readonly whatItObserves: string;
  readonly whatItCannotSee: string;
  readonly ports: string;
  readonly examples: string;
  readonly otherSections: readonly CataloguedSectionJSON[];
}

/**
 * One of an example's scenarios as the catalogue carries it (ADR 2026-031):
 * the normal form the build wrote (an ExampleScenarioJSON, from
 * `<slug>.scenarios.ts`, parsed there in full), checked here only for a
 * non-empty list of steps and kept as given. A reader parses it with
 * `ExampleScenarios.parse({ scenarios })` and shows it with its
 * `markdown()`, the one rendering.
 */
export interface CataloguedScenarioJSON {
  readonly steps: readonly unknown[];
  readonly [field: string]: unknown;
}

/** An example: a complete project configuration the package's tests open, embedded verbatim, and its scenarios. */
export interface CataloguedExampleJSON {
  /** Its package-relative path, `<pack directory>/examples/<slug>.config.ts`. */
  readonly path: string;
  /** The first line of the TSDoc on its default export. */
  readonly title: string;
  /** The rest of that TSDoc, its purpose; empty when there is none. */
  readonly description: string;
  readonly source: string;
  /** What the example does: its scenarios, at least one, from `<slug>.scenarios.ts` beside it. */
  readonly scenarios: readonly CataloguedScenarioJSON[];
}

/** One pack an export path of the package exports. */
export interface CataloguedPackJSON {
  readonly id: string;
  /** What a project imports it from: `<package>/<export path>`. */
  readonly importPath: string;
  /** The name it is exported under there. */
  readonly exportName: string;
  /** The README title's text after `# <pack id>: `. */
  readonly summary: string;
  /** The TSDoc on the pack in its overview. */
  readonly documentation: string;
  /** The ids of the packs it depends on, in its dependsOn order. */
  readonly dependsOn: readonly string[];
  /** The ids of the points it contributes to, each once, in contribution order. */
  readonly contributesTo: readonly string[];
  readonly points: readonly CataloguedPointJSON[];
  readonly ports: readonly CataloguedPortJSON[];
  /** The ports a host may provide (ADR 2026-026), for output that decides no verdict and no record; present only when the pack has any. */
  readonly optionalPorts?: readonly CataloguedPortJSON[] | undefined;
  readonly readme: CataloguedReadmeJSON;
  readonly examples: readonly CataloguedExampleJSON[];
}

/** A package catalogue's wire form: what `bounded.catalog.json` holds. */
export interface PackageCatalogJSON {
  readonly catalogVersion: 1;
  readonly package: { readonly name: string; readonly version: string };
  readonly packs: readonly CataloguedPackJSON[];
}

/**
 * A package's catalogue of its packs (ADR 2026-029): which packs it exports,
 * what each declares and contributes to, the ports a host provides, its
 * README's prose and its examples. Every pack's id is rooted at the
 * package's name, and each id appears once.
 */
export interface PackageCatalog {
  readonly __brand: "PackageCatalog";
  readonly [packageCatalogBrand]: true;
  readonly catalogVersion: 1;
  readonly package: { readonly name: string; readonly version: string };
  readonly packs: readonly CataloguedPackJSON[];
  equals(other: PackageCatalog): boolean;
  toJSON(): PackageCatalogJSON;
}

export interface PackageCatalogFactory {
  /**
   * A frozen catalogue, or why the value is not one: a catalogVersion other
   * than the number 1; a package without a name or version; a pack id given
   * twice, or not rooted at the package's name; a README without one of its
   * required sections' text; a pack with no example; an example with no
   * scenarios, or a scenario with no steps. Fields it does not know are
   * dropped, but a scenario is kept as given. Never throws.
   */
  parse(raw: unknown): Result<PackageCatalog>;
}
