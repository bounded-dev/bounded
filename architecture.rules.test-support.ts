// The contract rules (AGENTS.md "Layout", ADR 2026-013): adapters implement
// contract ports (R1), every @implementedBy is true (R2), every domain concept
// is a triplet, four files for a value object (R3), every pack a package ships
// has a contract (R3b), and every feature has a contract its handler
// implements (R4). Each rule reads source text with the TypeScript parser and
// is a pure function of the files it is given, so it can be tested on small
// fixtures as well as run on the repository.
import * as ts from "typescript";

/** A source file: its path from the repository root, and its text. */
export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

const isTest = (path: string): boolean => /\.test(-support)?\.ts$/.test(path) || path.split("/").includes("fixtures");
const dirOf = (path: string): string => path.slice(0, path.lastIndexOf("/"));
const resolve = (from: string, spec: string): string => new URL(spec, `file:///${from}`).pathname.slice(1);
const parse = (file: SourceFile): ts.SourceFile => ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true);
const exported = (node: ts.Node): boolean => ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);

/** Where each imported name comes from: local name -> { spec, imported name }. */
function importedNames(source: ts.SourceFile): Map<string, { readonly spec: string; readonly name: string; readonly namespace: boolean }> {
  const out = new Map<string, { spec: string; name: string; namespace: boolean }>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const spec = statement.moduleSpecifier.text;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) out.set(bindings.name.text, { spec, name: "*", namespace: true });
    else for (const element of bindings.elements) out.set(element.name.text, { spec, name: (element.propertyName ?? element.name).text, namespace: false });
  }
  return out;
}

/** The names a class implements, each with where it was imported from (undefined when declared in the file). */
function implemented(source: ts.SourceFile, node: ts.ClassDeclaration): { readonly name: string; readonly from: string | undefined }[] {
  const imports = importedNames(source);
  const out: { name: string; from: string | undefined }[] = [];
  for (const clause of node.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ImplementsKeyword) continue;
    for (const type of clause.types) {
      const expression = type.expression;
      if (ts.isIdentifier(expression)) out.push({ name: imports.get(expression.text)?.name ?? expression.text, from: imports.get(expression.text)?.spec });
      else if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
        out.push({ name: expression.name.text, from: imports.get(expression.expression.text)?.spec });
      }
    }
  }
  return out;
}

/** The application barrel's contract exports: name -> contract file. */
export function barrelContracts(barrel: SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  for (const statement of parse(barrel).statements) {
    if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier === undefined || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const target = resolve(barrel.path, statement.moduleSpecifier.text);
    if (!target.endsWith(".contract.ts") || statement.exportClause === undefined || !ts.isNamedExports(statement.exportClause)) continue;
    for (const element of statement.exportClause.elements) out.set(element.name.text, target);
  }
  return out;
}

/** An adapter class and the contract ports it implements. */
interface AdapterClass {
  readonly path: string;
  readonly name: string;
  readonly ports: readonly { readonly name: string; readonly contract: string | undefined }[];
}

function adapterClasses(files: readonly SourceFile[], barrels: ReadonlyMap<string, ReadonlyMap<string, string>>): AdapterClass[] {
  const out: AdapterClass[] = [];
  for (const file of files) {
    if (!/\/adapters\/out\//.test(file.path) || isTest(file.path)) continue;
    const source = parse(file);
    for (const statement of source.statements) {
      if (!ts.isClassDeclaration(statement) || statement.name === undefined || !exported(statement)) continue;
      const ports = implemented(source, statement).map(({ name, from }) => {
        if (from === undefined) return { name, contract: undefined };
        if (from.startsWith(".")) return { name, contract: resolve(file.path, from) };
        return { name, contract: barrels.get(from)?.get(name) };
      });
      out.push({ path: file.path, name: statement.name.text, ports });
    }
  }
  return out;
}

const isApplicationContract = (path: string | undefined): boolean => path !== undefined && /\/application\/.+\.contract\.ts$/.test(path);

/**
 * R1: every exported class under adapters/out implements a port declared in
 * an application contract (imported through a relative path or an
 * application barrel), and a file holding an adapter class exports nothing
 * else.
 */
export function adapterContractViolations(files: readonly SourceFile[], barrels: ReadonlyMap<string, ReadonlyMap<string, string>>): string[] {
  const out: string[] = [];
  for (const adapter of adapterClasses(files, barrels)) {
    if (!adapter.ports.some(({ contract }) => isApplicationContract(contract))) {
      out.push(`${adapter.path} — ${adapter.name} implements no port of an application contract: an out adapter implements a port its feature's contract declares`);
    }
  }
  for (const file of files) {
    if (!/\/adapters\/out\//.test(file.path) || isTest(file.path)) continue;
    const statements = parse(file).statements;
    const classes = statements.filter((statement) => ts.isClassDeclaration(statement) && exported(statement));
    const others = statements.filter((statement) => (ts.isFunctionDeclaration(statement) || ts.isVariableStatement(statement)) && exported(statement));
    if (classes.length > 0 && others.length > 0) out.push(`${file.path} — a file with an adapter class exports nothing else: move its helpers to a file of their own`);
  }
  return out;
}

/** The technologies a contract's interface names in `@implementedBy`. */
function implementedBy(file: SourceFile): { readonly name: string; readonly techs: readonly string[] }[] {
  const out: { name: string; techs: string[] }[] = [];
  for (const statement of parse(file).statements) {
    if (!ts.isInterfaceDeclaration(statement)) continue;
    const tags = ts.getJSDocTags(statement).filter((tag) => tag.tagName.text === "implementedBy");
    const techs = tags.flatMap((tag) => (typeof tag.comment === "string" ? tag.comment : "").split(/\s+/).filter((tech) => tech !== ""));
    if (techs.length > 0) out.push({ name: statement.name.text, techs });
  }
  return out;
}

/**
 * R2: for every interface an application contract tags `@implementedBy
 * <tech…>`, each tech has an adapter class under adapters/out/<tech>/
 * implementing it, and a conformance suite (a *.test-support.ts beside the
 * contract that names the port) is imported by a test beside that class.
 * `exempt` names ports excused, each with its reason.
 */
export function implementedByViolations(files: readonly SourceFile[], barrels: ReadonlyMap<string, ReadonlyMap<string, string>>, exempt: ReadonlyMap<string, string> = new Map()): string[] {
  const out: string[] = [];
  const adapters = adapterClasses(files, barrels);
  for (const contract of files.filter((file) => isApplicationContract(file.path))) {
    for (const { name, techs } of implementedBy(contract)) {
      if (exempt.has(name)) continue;
      const suites = files.filter((file) => file.path.endsWith(".test-support.ts") && dirOf(file.path) === dirOf(contract.path) && new RegExp(`\\b${name}\\b`).test(file.text)).map((file) => file.path);
      if (suites.length === 0) out.push(`${contract.path} — ${name} has no conformance suite: add a *.test-support.ts beside the contract that every adapter of it runs`);
      for (const tech of techs) {
        const classes = adapters.filter((adapter) => adapter.path.includes(`/adapters/out/${tech}/`) && adapter.ports.some((port) => port.name === name && port.contract === contract.path));
        if (classes.length === 0) {
          out.push(`${contract.path} — ${name} says it is implemented by ${tech}, but no class under adapters/out/${tech}/ implements it`);
          continue;
        }
        for (const adapter of classes) {
          const tested = files.some(
            (file) => file.path.endsWith(".test.ts") && dirOf(file.path) === dirOf(adapter.path) && [...importedNames(parse(file)).values()].some(({ spec }) => spec.startsWith(".") && suites.includes(resolve(file.path, spec))),
          );
          if (suites.length > 0 && !tested) out.push(`${adapter.path} — ${adapter.name} implements ${name}; a test beside it runs the port's conformance suite`);
        }
      }
    }
  }
  return out;
}

/** Whether a contract declares a value object: a branded interface with equals, and a factory with parse(raw: unknown). */
const declaresValueObject = (text: string): boolean => /readonly __brand/.test(text) && /\bequals\(/.test(text) && /parse\(raw: unknown\)/.test(text);

/**
 * R3: in the domain (and a pack's domain/ and pack/), every concept file
 * `<name>.ts` has `<name>.contract.ts` and `<name>.test.ts` beside it, every
 * contract has its implementation, and a value object's contract has
 * `<name>.laws.test.ts` too. `exempt` lists paths excused (barrels and the
 * shared kernel), each with its reason.
 */
export function conceptTripletViolations(paths: readonly string[], texts: ReadonlyMap<string, string>, exempt: ReadonlyMap<string, string> = new Map()): string[] {
  const out: string[] = [];
  const present = new Set(paths);
  const inScope = (path: string): boolean => /^contexts\/[^/]+\/src\/(domain|packs\/[^/]+\/(domain|pack))\//.test(path);
  for (const path of paths.filter(inScope)) {
    if (exempt.has(path) || isTest(path) || path.endsWith("/index.ts")) continue;
    if (path.endsWith(".contract.ts")) {
      const base = path.slice(0, -".contract.ts".length);
      if (!present.has(`${base}.ts`)) out.push(`${path} — a contract with no implementation: add ${base.split("/").at(-1)}.ts, or fold its types into the contract they belong to`);
      if (declaresValueObject(texts.get(path) ?? "") && !present.has(`${base}.laws.test.ts`)) out.push(`${path} — a value object's laws run in ${base.split("/").at(-1)}.laws.test.ts`);
      continue;
    }
    if (!path.endsWith(".ts")) continue;
    const base = path.slice(0, -".ts".length);
    for (const needed of [".contract.ts", ".test.ts"]) {
      if (!present.has(`${base}${needed}`)) out.push(`${path} — a domain concept is a contract, an implementation and a test: add ${base.split("/").at(-1)}${needed}`);
    }
  }
  return out;
}

/**
 * R3b: every pack a package ships (`export const x = definePack(…)` outside
 * tests) is typed by a contract beside it: the const's annotation names a
 * type imported from `./<file>.contract.ts`.
 */
export function packContractViolations(files: readonly SourceFile[]): string[] {
  const out: string[] = [];
  for (const file of files) {
    if (isTest(file.path) || !/^contexts\/[^/]+\/src\//.test(file.path)) continue;
    const source = parse(file);
    const imports = importedNames(source);
    const contract = `./${file.path.split("/").at(-1)?.replace(/\.ts$/, ".contract.ts")}`;
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement) || !exported(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        const initializer = declaration.initializer;
        if (initializer === undefined || !ts.isCallExpression(initializer) || !ts.isIdentifier(initializer.expression) || initializer.expression.text !== "definePack") continue;
        const name = ts.isIdentifier(declaration.name) ? declaration.name.text : "the pack";
        const type = declaration.type;
        const typeName = type !== undefined && ts.isTypeReferenceNode(type) ? (ts.isIdentifier(type.typeName) ? type.typeName.text : type.typeName.right.text) : undefined;
        const namespace = type !== undefined && ts.isTypeReferenceNode(type) && ts.isQualifiedName(type.typeName) && ts.isIdentifier(type.typeName.left) ? type.typeName.left.text : undefined;
        const from = namespace !== undefined ? imports.get(namespace)?.spec : typeName === undefined ? undefined : imports.get(typeName)?.spec;
        if (from !== contract) out.push(`${file.path} — ${name} is a pack this package ships: type it with the pack type its contract declares (${contract})`);
      }
    }
  }
  return out;
}

/**
 * R4: every application feature (`application/<area>/<feature>/`) has
 * `<feature>.contract.ts`, and its `<feature>.handler.ts` class implements an
 * interface from that contract.
 */
export function featureContractViolations(paths: readonly string[], texts: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  const features = new Set(paths.flatMap((path) => /^(contexts\/[^/]+\/src\/(?:packs\/[^/]+\/)?application\/[^/]+\/[^/]+)\/[^/]+\.ts$/.exec(path)?.[1] ?? []));
  for (const dir of features) {
    const feature = dir.split("/").at(-1) ?? "";
    const contract = `${dir}/${feature}.contract.ts`;
    if (!paths.includes(contract)) {
      out.push(`${dir} — a feature declares its ports in ${feature}.contract.ts`);
      continue;
    }
    const handler = `${dir}/${feature}.handler.ts`;
    const text = texts.get(handler);
    if (text === undefined) continue;
    const source = parse({ path: handler, text });
    const classes = source.statements.filter((statement): statement is ts.ClassDeclaration => ts.isClassDeclaration(statement));
    const fromContract = classes.some((node) => implemented(source, node).some(({ from }) => from !== undefined && resolve(handler, from) === contract));
    if (!fromContract) out.push(`${handler} — the handler implements its feature's in port from ${feature}.contract.ts`);
  }
  return out;
}
