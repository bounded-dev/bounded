// A pack's typed public API, read with the TypeScript compiler from the pack's own files (ADR
// 2026-026): its overview (`<name>.pack.ts`), its contract and its examples are the program's
// only root files, compiled with the compiler options of the package's tsconfig.json, found as
// tsc finds it. The overview's exported pack gives its name and TSDoc; the type it is declared
// with (its contract's) gives each point's value type and TSDoc, and each port's adapter
// interface. A point's wire type is a value object's `toJSON` result, or plain data's own type,
// and its JSON Schema comes from ts-json-schema-generator over the same program; a point whose
// values are code has none. TypeScript and the generator are the package's own devDependencies,
// loaded from it; only TypeScript 5 is read.
import { isAbsolute, join } from "node:path";
import type { PackSourceApi, PackSourceApiReading, PackSourceExample, PackSourcePoint, PackSourcePort, PackSourceRequest } from "bounded/application";
import type { Result } from "bounded/domain";
import type * as TypeScript from "typescript";
import { loadPackageLibrary } from "../package-library.ts";

type TS = typeof TypeScript;
/** What the catalogue build uses of ts-json-schema-generator. */
interface SchemaGeneratorLibrary {
  createGenerator(config: Readonly<Record<string, unknown>>): { createSchema(type: string): unknown };
}

/** The TypeScript major this reader reads. */
const TYPESCRIPT_MAJOR = "5";
/** How deep a value type is searched for a function. */
const FUNCTION_SEARCH_DEPTH = 8;

const message = (thrown: unknown): string => (thrown instanceof Error ? thrown.message : String(thrown));
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);
/** A CommonJS library's exports, as `import()` gives them under Node and bun. */
const exportsOf = (module: unknown): unknown => (isRecord(module) && isRecord(module.default) ? module.default : module);

async function typescriptOf(packageDir: string): Promise<Result<TS>> {
  const loaded = await loadPackageLibrary(packageDir, "typescript");
  if (!loaded.ok) return loaded;
  const ts = exportsOf(loaded.value);
  if (!isRecord(ts) || typeof ts.createProgram !== "function" || typeof ts.version !== "string") return { ok: false, error: "typescript, as the package resolves it, is not the TypeScript compiler: reinstall it as a devDependency of the package to build its catalogue" };
  const major = ts.version.split(".")[0];
  if (major !== TYPESCRIPT_MAJOR) return { ok: false, error: `typescript ${ts.version} is installed, and the catalogue build reads TypeScript ${TYPESCRIPT_MAJOR}: install typescript@${TYPESCRIPT_MAJOR} as a devDependency of the package to build its catalogue` };
  return { ok: true, value: ts as unknown as TS };
}

async function schemaGeneratorOf(packageDir: string): Promise<Result<SchemaGeneratorLibrary>> {
  const loaded = await loadPackageLibrary(packageDir, "ts-json-schema-generator");
  if (!loaded.ok) return loaded;
  const library = exportsOf(loaded.value);
  if (!isRecord(library) || typeof library.createGenerator !== "function") return { ok: false, error: "ts-json-schema-generator, as the package resolves it, has no createGenerator: reinstall it as a devDependency of the package to build its catalogue" };
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

  /** The overview's exported pack: its name, its TSDoc and the type it is declared with. */
  overview(path: string, shown: string): Result<{ readonly name: string; readonly documentation: string; readonly type: TypeScript.Type }> {
    const { ts } = this;
    const source = this.program.getSourceFile(path);
    if (source === undefined) return { ok: false, error: `its overview, ${shown}, cannot be read: a pack is defined in <its directory>/<its name>.pack.ts` };
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement) || !(ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
      const declaration = statement.declarationList.declarations[0];
      if (declaration === undefined || !ts.isIdentifier(declaration.name)) continue;
      return { ok: true, value: { name: declaration.name.text, documentation: tsDocOf(ts, statement) ?? "", type: this.checker.getTypeAtLocation(declaration.name) } };
    }
    return { ok: false, error: `its overview, ${shown}, exports no pack: it holds \`export const <name>: <Type> = definePack({ … })\`` };
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
    const wireName = declaredNameOf(wireType);
    const wireText = checker.typeToString(wireType, undefined, ts.TypeFormatFlags.NoTruncation);
    if (wireName === undefined) return { ok: false, error: `the point '${key}' is written as ${wireText}, a type with no name: declare it as an exported interface or type alias, so its JSON Schema can be generated` };
    try {
      const generator = this.generator.createGenerator({ tsProgram: this.program, skipTypeCheck: true, functions: "fail", expose: "export", topRef: true, jsDoc: "extended", additionalProperties: false });
      const schema = generator.createSchema(wireName);
      if (!isRecord(schema)) return { ok: false, error: `the point '${key}''s wire type ${wireName} gave no JSON Schema` };
      return { ok: true, value: { ...base, wire: { type: wireName, schema } } };
    } catch (thrown) {
      return { ok: false, error: `the point '${key}''s wire type ${wireName} cannot be described as JSON Schema (${message(thrown)}): write it as plain JSON data, which the schema generator describes` };
    }
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
    const ts = await typescriptOf(packageDir);
    if (!ts.ok) return ts;
    const generator = await schemaGeneratorOf(packageDir);
    if (!generator.ok) return generator;
    const options = compilerOptionsOf(ts.value, packageDir);
    if (!options.ok) return options;
    const name = packDir.split("/").at(-1) ?? "";
    const overviewPath = `${packDir}/${name}.pack.ts`;
    const contractPath = `${packDir}/${name}.contract.ts`;
    // The pack's own files are the program's only roots: the tsconfig gives compiler options, never files.
    const roots = [overviewPath, contractPath, ...examplePaths].map((path) => join(packageDir, path));
    let program: PackProgram;
    try {
      program = new PackProgram(ts.value, ts.value.createProgram(roots, { ...options.value, noEmit: true }), generator.value);
    } catch (thrown) {
      return { ok: false, error: `the pack's sources in ${packDir} cannot be compiled: ${message(thrown)}` };
    }
    const overview = program.overview(join(packageDir, overviewPath), overviewPath);
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
