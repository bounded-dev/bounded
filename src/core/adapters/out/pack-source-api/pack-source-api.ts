// A pack's typed public API, read with the TypeScript compiler from the pack's own files (ADR
// 2026-029): its overview (`<name>.pack.ts`), its contract and its examples are the program's
// only root files, compiled with the compiler options of the package's tsconfig.json, found as
// tsc finds it. The overview's exported pack gives its name and TSDoc; the type it is declared
// with (its contract's) gives each point's value type and TSDoc, and each port's adapter
// interface. A point's wire type is a value object's `toJSON` result, or plain data's own type,
// and its JSON Schema comes from ts-json-schema-generator over the same program, from the
// declaration the checker resolved (or, for a type with no name, from where the contract writes
// it), never by looking a name up; a point whose values are code has none. TypeScript and the
// generator are the package's own devDependencies, loaded from it, and must share one copy of
// TypeScript; only TypeScript 5 is read.
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import type { PackSourceApi, PackSourceApiReading, PackSourceExample, PackSourcePoint, PackSourcePort, PackSourceRequest } from "bounded/application";
import type { Result } from "bounded/domain";
import type * as TypeScript from "typescript";
import { loadPackageLibrary } from "../package-library.ts";

type TS = typeof TypeScript;
/** What the catalogue build uses of ts-json-schema-generator: a schema from root nodes of a program it is given. */
interface SchemaGeneratorLibrary {
  readonly DEFAULT_CONFIG: Readonly<Record<string, unknown>>;
  createParser(program: TypeScript.Program, config: Readonly<Record<string, unknown>>): unknown;
  createFormatter(config: Readonly<Record<string, unknown>>): unknown;
  readonly SchemaGenerator: new (program: TypeScript.Program, parser: unknown, formatter: unknown, config: Readonly<Record<string, unknown>>) => { createSchemaFromNodes(nodes: readonly TypeScript.Node[]): unknown };
}

/** The TypeScript major this reader reads. */
const TYPESCRIPT_MAJOR = "5";
/** How deep a value type is searched for a function. */
const FUNCTION_SEARCH_DEPTH = 8;

const message = (thrown: unknown): string => (thrown instanceof Error ? thrown.message : String(thrown));
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);
/** A CommonJS library's exports, as `import()` gives them under Node and bun. */
const exportsOf = (module: unknown): unknown => (isRecord(module) && isRecord(module.default) ? module.default : module);

async function typescriptOf(packageDir: string): Promise<Result<{ readonly ts: TS; readonly path: string }>> {
  const loaded = await loadPackageLibrary(packageDir, "typescript");
  if (!loaded.ok) return loaded;
  const ts = exportsOf(loaded.value.module);
  if (!isRecord(ts) || typeof ts.createProgram !== "function" || typeof ts.version !== "string") return { ok: false, error: "typescript, as the package resolves it, is not the TypeScript compiler: reinstall it as a devDependency of the package to build its catalogue" };
  const major = ts.version.split(".")[0];
  if (major !== TYPESCRIPT_MAJOR) return { ok: false, error: `typescript ${ts.version} is installed, and the catalogue build reads TypeScript ${TYPESCRIPT_MAJOR}: install typescript@${TYPESCRIPT_MAJOR} as a devDependency of the package to build its catalogue` };
  return { ok: true, value: { ts: ts as unknown as TS, path: loaded.value.path } };
}

/** The version of the typescript `from` resolves, read from its package.json; undefined when it cannot be read. */
function typescriptVersionFrom(from: string): string | undefined {
  try {
    const manifest: unknown = JSON.parse(readFileSync(createRequire(from).resolve("typescript/package.json"), "utf8"));
    return isRecord(manifest) && typeof manifest.version === "string" ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

/** The real path of a file, or the path as given when it cannot be resolved. */
function realPathOf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** ts-json-schema-generator as the package resolves it, refused unless it resolves the same copy of typescript as the package: it reads the program the build compiles. */
async function schemaGeneratorOf(packageDir: string, typescript: { readonly ts: TS; readonly path: string }): Promise<Result<SchemaGeneratorLibrary>> {
  const loaded = await loadPackageLibrary(packageDir, "ts-json-schema-generator");
  if (!loaded.ok) return loaded;
  let generatorTypescript: string | undefined;
  try {
    generatorTypescript = createRequire(loaded.value.path).resolve("typescript");
  } catch {
    generatorTypescript = undefined;
  }
  if (generatorTypescript === undefined || realPathOf(generatorTypescript) !== realPathOf(typescript.path)) {
    const theirs = generatorTypescript === undefined ? "no typescript" : `typescript ${typescriptVersionFrom(loaded.value.path) ?? "of an unknown version"} (${generatorTypescript})`;
    return {
      ok: false,
      error: `ts-json-schema-generator, as the package resolves it, uses ${theirs}, not the package's typescript ${typescript.ts.version} (${typescript.path}): install them so they share one copy of typescript, since the generator reads the program the catalogue build compiles`,
    };
  }
  const library = exportsOf(loaded.value.module);
  if (!isRecord(library) || typeof library.createParser !== "function" || typeof library.createFormatter !== "function" || typeof library.SchemaGenerator !== "function" || !isRecord(library.DEFAULT_CONFIG)) {
    return { ok: false, error: "ts-json-schema-generator, as the package resolves it, has no createParser, createFormatter, SchemaGenerator and DEFAULT_CONFIG: install version 2 as a devDependency of the package to build its catalogue" };
  }
  return { ok: true, value: library as unknown as SchemaGeneratorLibrary };
}

/** The compiler options of the package's tsconfig.json, found as tsc finds it: in the package's directory or the nearest above it. */
function compilerOptionsOf(ts: TS, packageDir: string): Result<TypeScript.CompilerOptions> {
  const path = ts.findConfigFile(packageDir, ts.sys.fileExists, "tsconfig.json");
  if (path === undefined) return { ok: false, error: `no tsconfig.json was found in ${packageDir} or above it: add a tsconfig.json to the package, so its pack's types are read with its compiler options` };
  let unrecoverable: string | undefined;
  const parsed = ts.getParsedCommandLineOfConfigFile(path, undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      unrecoverable = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    },
  });
  if (parsed === undefined || unrecoverable !== undefined) return { ok: false, error: `${path} cannot be read (${unrecoverable ?? "it is not a tsconfig"}): fix it, so the pack's types are read with the package's compiler options` };
  return { ok: true, value: parsed.options };
}

/** The text of the last TSDoc on `node`, without its tags; undefined when it has none. */
function tsDocOf(ts: TS, node: TypeScript.Node): string | undefined {
  const docs = ts.getJSDocCommentsAndTags(node).filter((doc): doc is TypeScript.JSDoc => ts.isJSDoc(doc));
  const doc = docs.at(-1);
  return doc === undefined ? undefined : (ts.getTextOfJSDocComment(doc.comment) ?? "").trim();
}

/** The return type of the optional phantom function `name` (`__value?: (value: V) => V`), which a point or port key carries to keep its type: V. */
function phantomOf(checker: TypeScript.TypeChecker, type: TypeScript.Type, name: string): TypeScript.Type | undefined {
  const property = type.getProperty(name);
  if (property === undefined) return undefined;
  return checker.getNonNullableType(checker.getTypeOfSymbol(property)).getCallSignatures()[0]?.getReturnType();
}

/** Whether a type is, or holds, a function: a point whose values are code. */
function holdsFunction(ts: TS, checker: TypeScript.TypeChecker, type: TypeScript.Type, depth = 0): boolean {
  if (depth > FUNCTION_SEARCH_DEPTH) return false;
  if (type.isUnionOrIntersection()) return type.types.some((member) => holdsFunction(ts, checker, member, depth + 1));
  // Only an object type can be or hold a function: a primitive's methods are its apparent type's, not its own.
  if ((type.flags & ts.TypeFlags.Object) === 0) return false;
  if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) return true;
  if (checker.isArrayType(type) || checker.isTupleType(type)) return checker.getTypeArguments(type as TypeScript.TypeReference).some((element) => holdsFunction(ts, checker, element, depth + 1));
  return checker.getPropertiesOfType(type).some((property) => holdsFunction(ts, checker, checker.getTypeOfSymbol(property), depth + 1));
}

/** The name a type is declared under (an interface, class, enum or type alias), or undefined for an anonymous or primitive type. */
function declaredNameOf(type: TypeScript.Type): string | undefined {
  const symbol = type.aliasSymbol ?? type.getSymbol();
  const name = symbol?.getName();
  return name === undefined || name.startsWith("__") ? undefined : name;
}

class PackProgram {
  private readonly checker: TypeScript.TypeChecker;

  constructor(
    private readonly ts: TS,
    private readonly program: TypeScript.Program,
    private readonly generator: SchemaGeneratorLibrary,
  ) {
    this.checker = program.getTypeChecker();
  }

  /**
   * The pack the export path exports under `exportName`: through the pack's index, when it has
   * one, the export the checker resolves (a renamed re-export followed to its declaration), which
   * must be an `export const` of the overview; else the overview's `export const` of that name.
   * Its name in the overview, its TSDoc and the type it is declared with.
   */
  overview(path: string, shown: string, exportName: string, indexPath: string | undefined): Result<{ readonly name: string; readonly documentation: string; readonly type: TypeScript.Type }> {
    const { ts, checker } = this;
    const source = this.program.getSourceFile(path);
    if (source === undefined) return { ok: false, error: `its overview, ${shown}, cannot be read: a pack is defined in <its directory>/<its name>.pack.ts` };
    const index = indexPath === undefined ? undefined : this.program.getSourceFile(indexPath);
    const indexSymbol = index === undefined ? undefined : checker.getSymbolAtLocation(index);
    if (indexSymbol !== undefined) {
      const exported = checker.getExportsOfModule(indexSymbol).find((symbol) => symbol.getName() === exportName);
      const target = exported !== undefined && (exported.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(exported) : exported;
      const declaration = target?.getDeclarations()?.find((node): node is TypeScript.VariableDeclaration => ts.isVariableDeclaration(node));
      if (declaration === undefined || declaration.getSourceFile() !== source || !ts.isIdentifier(declaration.name)) {
        return { ok: false, error: `its index does not export \`${exportName}\` as an \`export const\` of its overview, ${shown}: define the pack there, as \`export const <name>: <Type> = definePack({ … })\`, and export it from the index` };
      }
      const statement = declaration.parent.parent;
      return { ok: true, value: { name: declaration.name.text, documentation: tsDocOf(ts, statement) ?? "", type: checker.getTypeAtLocation(declaration.name) } };
    }
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement) || !(ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.name.text !== exportName) continue;
        return { ok: true, value: { name: exportName, documentation: tsDocOf(ts, statement) ?? "", type: this.checker.getTypeAtLocation(declaration.name) } };
      }
    }
    return { ok: false, error: `its overview, ${shown}, does not export \`${exportName}\`, the name its export path exports the pack under: define the pack there, as \`export const ${exportName}: <Type> = definePack({ … })\`` };
  }

  /** The points the pack's type declares, a group's members as `<group>.<member>`, each with its value type, TSDoc and wire type. */
  points(packType: TypeScript.Type): Result<PackSourcePoint[]> {
    const pointsSymbol = packType.getProperty("points");
    if (pointsSymbol === undefined) return { ok: true, value: [] };
    const points: PackSourcePoint[] = [];
    for (const property of this.checker.getPropertiesOfType(this.checker.getTypeOfSymbol(pointsSymbol))) {
      const type = this.checker.getTypeOfSymbol(property);
      const members = phantomOf(this.checker, type, "__value") === undefined ? this.checker.getPropertiesOfType(type).map((member) => ({ key: `${property.getName()}.${member.getName()}`, symbol: member })) : [{ key: property.getName(), symbol: property }];
      for (const { key, symbol } of members) {
        const point = this.point(key, symbol);
        if (!point.ok) return point;
        points.push(point.value);
      }
    }
    return { ok: true, value: points };
  }

  private point(key: string, symbol: TypeScript.Symbol): Result<PackSourcePoint> {
    const { checker, ts } = this;
    const valueType = phantomOf(checker, checker.getTypeOfSymbol(symbol), "__value");
    if (valueType === undefined) return { ok: false, error: `its contract's points have '${key}', which is not an ExtensionPoint: declare each point as ExtensionPoint<Value, PackId>` };
    const documentation = ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim();
    const valueText = checker.typeToString(valueType, undefined, ts.TypeFormatFlags.NoTruncation);
    const base = { key, valueType: valueText, documentation };
    // A value object is written as its wire form, what its toJSON gives; plain data as itself.
    const toJSON = valueType.getProperty("__brand") === undefined ? undefined : valueType.getProperty("toJSON");
    const wireType = toJSON === undefined ? valueType : checker.getTypeOfSymbol(toJSON).getCallSignatures()[0]?.getReturnType();
    if (wireType === undefined) return { ok: false, error: `the point '${key}' takes ${valueText}, whose toJSON gives nothing: a value object's toJSON gives its wire form` };
    if (holdsFunction(ts, checker, wireType)) return { ok: true, value: { ...base, wire: null } };
    const wireText = checker.typeToString(wireType, undefined, ts.TypeFormatFlags.NoTruncation);
    const node = this.wireNode(symbol, wireType, toJSON);
    if (node === undefined) return { ok: false, error: `the point '${key}' is written as ${wireText}, and where that type is written cannot be found: declare the point as ExtensionPoint<Value, PackId> in the pack's contract` };
    // Fail closed: a type written in place must be the wire type itself, never a wrapper alias's argument (Wrapped<string> for ExtensionPoint<string[], …>).
    if (ts.isTypeNode(node) && checker.getTypeFromTypeNode(node) !== wireType) {
      return { ok: false, error: `the point '${key}' is declared so that its wire type, ${wireText}, is not written where it is declared (${node.getText()} is): declare it as ExtensionPoint<Value, PackId> directly in the pack's contract` };
    }
    try {
      // A declaration is referenced from the top, as definitions/<its name>; a type written in place is described inline.
      const config = { ...this.generator.DEFAULT_CONFIG, tsProgram: this.program, skipTypeCheck: true, functions: "fail", expose: "export", topRef: !ts.isTypeNode(node), jsDoc: "extended", additionalProperties: false };
      const generator = new this.generator.SchemaGenerator(this.program, this.generator.createParser(this.program, config), this.generator.createFormatter(config), config);
      const schema = generator.createSchemaFromNodes([node]);
      if (!isRecord(schema)) return { ok: false, error: `the point '${key}''s wire type ${wireText} gave no JSON Schema` };
      return { ok: true, value: { ...base, wire: { type: wireText, schema } } };
    } catch (thrown) {
      return { ok: false, error: `the point '${key}''s wire type ${wireText} cannot be described as JSON Schema (${message(thrown)}): write it as plain JSON data, which the schema generator describes` };
    }
  }

  /**
   * The node the wire type's schema is generated from: the declaration the checker resolved
   * the type to, when it is declared under a name; else where it is written, the toJSON
   * method's return type for a value object, or the point's `ExtensionPoint<Value, …>` type
   * argument for plain data. Undefined when there is none.
   */
  private wireNode(point: TypeScript.Symbol, wireType: TypeScript.Type, toJSON: TypeScript.Symbol | undefined): TypeScript.Node | undefined {
    const { ts } = this;
    // An instantiated generic (readonly string[], Readonly<NoteJSON>, Record<string, string>) is described where it is written, never as its generic declaration.
    const reference = (wireType.flags & ts.TypeFlags.Object) !== 0 && ((wireType as TypeScript.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0 ? (wireType as TypeScript.TypeReference) : undefined;
    const instantiated = (wireType.aliasTypeArguments?.length ?? 0) > 0 || (reference !== undefined && this.checker.getTypeArguments(reference).length > 0);
    const named = instantiated || declaredNameOf(wireType) === undefined ? undefined : (wireType.aliasSymbol ?? wireType.getSymbol());
    const declaration = named?.getDeclarations()?.find((node) => ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node) || ts.isClassDeclaration(node));
    if (declaration !== undefined) return declaration;
    if (toJSON !== undefined) {
      const method = toJSON.getDeclarations()?.find((node) => ts.isMethodSignature(node) || ts.isMethodDeclaration(node));
      return method !== undefined && (ts.isMethodSignature(method) || ts.isMethodDeclaration(method)) ? method.type : undefined;
    }
    const property = point.getDeclarations()?.find((node) => ts.isPropertySignature(node) || ts.isPropertyDeclaration(node));
    const written = property !== undefined && (ts.isPropertySignature(property) || ts.isPropertyDeclaration(property)) ? property.type : undefined;
    return written !== undefined && ts.isTypeReferenceNode(written) ? written.typeArguments?.[0] : undefined;
  }

  /** The ports the pack's type declares, each with its adapter interface, that interface's TSDoc and its declaration. */
  ports(packType: TypeScript.Type): Result<PackSourcePort[]> {
    const { checker, ts } = this;
    const portsSymbol = packType.getProperty("ports");
    if (portsSymbol === undefined) return { ok: true, value: [] };
    const ports: PackSourcePort[] = [];
    for (const property of checker.getPropertiesOfType(checker.getTypeOfSymbol(portsSymbol))) {
      const key = property.getName();
      const adapter = phantomOf(checker, checker.getTypeOfSymbol(property), "__adapter");
      const adapterSymbol = adapter?.aliasSymbol ?? adapter?.getSymbol();
      const declaration = adapterSymbol?.getDeclarations()?.[0];
      if (adapter === undefined || adapterSymbol === undefined || declaration === undefined) return { ok: false, error: `its contract's port '${key}' is not a PortKey of a declared interface: declare it as PortKey<Adapter, PackId>` };
      const text = declaration.getText(declaration.getSourceFile()).replace(/^(export\s+)?(declare\s+)?/, "");
      ports.push({ key, adapterType: adapterSymbol.getName(), documentation: ts.displayPartsToString(adapterSymbol.getDocumentationComment(checker)).trim(), declaration: text });
    }
    return { ok: true, value: ports };
  }

  /** The TSDoc on an example's default export. */
  example(path: string, absolute: string): PackSourceExample {
    const { ts } = this;
    const source = this.program.getSourceFile(absolute);
    const exported = source?.statements.find((statement): statement is TypeScript.ExportAssignment => ts.isExportAssignment(statement) && statement.isExportEquals !== true);
    const documentation = exported === undefined ? undefined : tsDocOf(ts, exported);
    return { path, documentation: documentation === undefined || documentation === "" ? null : documentation };
  }
}

export class TypeScriptPackSourceApi implements PackSourceApi {
  async read(request: PackSourceRequest): Promise<Result<PackSourceApiReading>> {
    const { packageDir, packDir, examplePaths } = request;
    if (!isAbsolute(packageDir)) return { ok: false, error: `${packageDir} is not an absolute path` };
    const typescript = await typescriptOf(packageDir);
    if (!typescript.ok) return typescript;
    const { ts } = typescript.value;
    const generator = await schemaGeneratorOf(packageDir, typescript.value);
    if (!generator.ok) return generator;
    const options = compilerOptionsOf(ts, packageDir);
    if (!options.ok) return options;
    const name = packDir.split("/").at(-1) ?? "";
    const overviewPath = `${packDir}/${name}.pack.ts`;
    const contractPath = `${packDir}/${name}.contract.ts`;
    // The pack's own files are the program's only roots: the tsconfig gives compiler options, never files.
    const indexPath = join(packageDir, packDir, "index.ts");
    const hasIndex = ts.sys.fileExists(indexPath);
    const roots = [overviewPath, contractPath, ...examplePaths].map((path) => join(packageDir, path)).concat(hasIndex ? [indexPath] : []);
    let program: PackProgram;
    try {
      program = new PackProgram(ts, ts.createProgram(roots, { ...options.value, noEmit: true }), generator.value);
    } catch (thrown) {
      return { ok: false, error: `the pack's sources in ${packDir} cannot be compiled: ${message(thrown)}` };
    }
    const overview = program.overview(join(packageDir, overviewPath), overviewPath, request.exportName, hasIndex ? indexPath : undefined);
    if (!overview.ok) return overview;
    const points = program.points(overview.value.type);
    if (!points.ok) return points;
    const ports = program.ports(overview.value.type);
    if (!ports.ok) return ports;
    return {
      ok: true,
      value: {
        overview: { name: overview.value.name, documentation: overview.value.documentation },
        points: points.value,
        ports: ports.value,
        examples: examplePaths.map((path) => program.example(path, join(packageDir, path))),
      },
    };
  }
}
