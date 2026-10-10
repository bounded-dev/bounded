import type { PackageCatalog, ReadmeSection, ReadmeText, Result } from "bounded/domain";

/** The brand only BuildPackageCatalogCommand itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const buildPackageCatalogCommandBrand: unique symbol;

// Wire input: what the `bounded catalog build` command sends.
export interface BuildPackageCatalogInput {
  /** The package's directory, holding its package.json: an absolute path. */
  readonly packageDir: string;
}

// Command: the input once checked.
export interface BuildPackageCatalogCommand {
  readonly __brand: "BuildPackageCatalogCommand";
  readonly [buildPackageCatalogCommandBrand]: true;
  readonly packageDir: string;
}

export interface BuildPackageCatalogCommandFactory {
  parse(raw: unknown): Result<BuildPackageCatalogCommand>;
}

/** A catalogue built and written: its package-relative path, and the catalogue. */
export interface BuiltPackageCatalog {
  readonly path: string;
  readonly catalog: PackageCatalog;
}

// In port: what this feature offers.
/**
 * Build a package's catalogue of its packs (ADR 2026-029): for each pack its
 * package.json lists in `bounded.packs`, in id order, load the one pack its
 * export path exports, describe it from the pack object, read its typed API
 * from its contract and TSDoc, its prose from its README and its examples,
 * then write `bounded.catalog.json` where `bounded.catalog` says. The first
 * refusal stops it, and nothing is written.
 */
export interface BuildPackageCatalog {
  execute(command: BuildPackageCatalogCommand): Promise<Result<BuiltPackageCatalog>>;
}

// Out ports: exactly what this feature needs.
/**
 * The package's files the build reads and writes, by package-relative path.
 * @implementedBy FileSystemPackageCatalogFiles
 */
export interface PackageCatalogFiles {
  /** The package's package.json, parsed as JSON and otherwise as written; refuses one that is missing or is not JSON, naming it. */
  readManifest(packageDir: string): Promise<Result<unknown>>;
  /** A file's text, or null when there is no such file. */
  readText(packageDir: string, path: string): Promise<Result<string | null>>;
  /** A pack's examples: `<packDir>/examples/*.config.ts`, by package-relative path, sorted; none when it has no examples/. */
  listExamples(packageDir: string, packDir: string): Promise<Result<readonly string[]>>;
  /** Writes `text` to a file inside the package, giving its package-relative path; refuses a path that leaves the package. */
  write(packageDir: string, path: string, text: string): Promise<Result<string>>;
}

/** One export of a module: its name and its value. */
export interface ModuleExport {
  readonly name: string;
  readonly value: unknown;
}

/**
 * The modules a package's export paths name, loaded as Node loads them.
 * @implementedBy NodePackModules
 */
export interface PackModules {
  /**
   * Every export of the module an export path of the package (`./prereqs`,
   * or `.` for the package root) names. Refuses an export path its package.json does not list, and one
   * whose entry has no `default`, `require` or `node` target, before
   * resolving it, so it refuses alike under every runtime.
   */
  load(packageDir: string, exportPath: string): Promise<Result<readonly ModuleExport[]>>;
}

/** What to read of a pack's sources: the package, the pack's source directory and its examples, all package-relative, and the name its export path exports the pack under. */
export interface PackSourceRequest {
  readonly packageDir: string;
  readonly packDir: string;
  /** The name the overview exports the pack under: the one the module loader found. */
  readonly exportName: string;
  readonly examplePaths: readonly string[];
}

/** A point as its pack's contract types it. */
export interface PackSourcePoint {
  /** Its key in the pack's points, `<group>.<member>` for a group's member. */
  readonly key: string;
  /** The type of the values readers get. */
  readonly valueType: string;
  /** The TSDoc the contract gives it. */
  readonly documentation: string;
  /** How a contribution is written: its wire type's text and that type's JSON Schema; null when the values are code. */
  readonly wire: { readonly type: string; readonly schema: Readonly<Record<string, unknown>> } | null;
}

/** A port as its pack's contract types it. */
export interface PackSourcePort {
  readonly key: string;
  /** The interface an adapter of the port implements. */
  readonly adapterType: string;
  /** That interface's TSDoc, without its tags. */
  readonly documentation: string;
  /** That interface's declaration, as written. */
  readonly declaration: string;
}

/** An example's TSDoc, from its default export; null when it has none. */
export interface PackSourceExample {
  readonly path: string;
  readonly documentation: string | null;
}

/** A pack's typed public API, as its overview and contract declare it. */
export interface PackSourceApiReading {
  /** The pack as its overview, `<name>.pack.ts`, exports it under the request's export name, and its TSDoc. */
  readonly overview: { readonly name: string; readonly documentation: string };
  readonly points: readonly PackSourcePoint[];
  readonly ports: readonly PackSourcePort[];
  /** The ports the pack's type declares in optionalPorts, which a host may provide (ADR 2026-026). */
  readonly optionalPorts: readonly PackSourcePort[];
  readonly examples: readonly PackSourceExample[];
}

/**
 * A pack's typed public API, read from its overview, its contract and the
 * TSDoc on them, and its examples' TSDoc.
 * @implementedBy TypeScriptPackSourceApi
 */
export interface PackSourceApi {
  read(request: PackSourceRequest): Promise<Result<PackSourceApiReading>>;
}

/** A Markdown document split at its headings of level one and two. */
export interface MarkdownDocument {
  /** The text of the level-one heading it opens with; null when it opens with none. */
  readonly title: string | null;
  /** What comes before the first section. */
  readonly introduction: ReadmeText;
  /** Each heading of level one or two after the title, with its body up to the next. */
  readonly sections: readonly (ReadmeSection & { readonly level: number })[];
}

/**
 * Markdown, split into sections by a Markdown reader: never a heading or
 * code span inside a fenced block.
 * @implementedBy MarkedMarkdownSections
 */
export interface MarkdownSections {
  /** The document's sections; `packageDir` is the package its reader is resolved from. */
  read(packageDir: string, markdown: string): Promise<Result<MarkdownDocument>>;
}
