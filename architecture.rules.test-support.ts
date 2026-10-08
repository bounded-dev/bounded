// The contract rules (AGENTS.md "Layout", ADRs 2026-013 and 2026-017): adapters
// implement contract ports and sit in the folder of the port they serve (R1),
// every @implementedBy names the adapter classes and each runs its port's
// suite, and in-memory doubles are test support no production code
// imports (R2), every domain concept
// is a triplet, four files for a value object (R3), every pack a package ships
// is laid out and bound in an overview file typed by its contract (R7), every feature has a contract its handler implements
// (R4), the files that route events assert no types (R5), and shape checks
// live where the shape is owned (R6). Each rule reads
// source text with the TypeScript parser and is a pure function of the files
// it is given, so it can be tested on small fixtures as well as run on the
// repository.
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

/** A type's name in kebab case: `GuardLog` → `guard-log`, `SystemClock` → `system-clock`. */
export const kebab = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();

/** An out adapter file's port folder and file name: `…/adapters/out/<folder>/<file>.ts` (undefined when it sits elsewhere). */
const placementOf = (path: string): { readonly folder: string; readonly file: string } | undefined => {
  const match = /\/adapters\/out\/(.+)\/([^/]+)\.ts$/.exec(path);
  return match === null ? undefined : { folder: match[1] ?? "", file: match[2] ?? "" };
};

/**
 * R1, placement: an out adapter class sits in `adapters/out/<port>/`, the
 * kebab-case name of a port of an application contract it implements; its
 * file is `<port>.ts` when it is the only file in that folder holding an
 * adapter class, and named for its class (`<class>.ts`, kebab case)
 * otherwise. Files that hold no adapter class are not constrained.
 */
export function adapterPlacementViolations(files: readonly SourceFile[], barrels: ReadonlyMap<string, ReadonlyMap<string, string>>): string[] {
  const out: string[] = [];
  const adapters = adapterClasses(files, barrels);
  const adapterFilesIn = (dir: string): number => new Set(adapters.filter((adapter) => dirOf(adapter.path) === dir).map((adapter) => adapter.path)).size;
  for (const adapter of adapters) {
    const ports = adapter.ports.filter(({ contract }) => isApplicationContract(contract)).map(({ name }) => kebab(name));
    if (ports.length === 0) continue;
    const placed = placementOf(adapter.path);
    const port = ports.find((name) => placed?.folder === name);
    if (placed === undefined || port === undefined) {
      out.push(`${adapter.path} — ${adapter.name} is an out adapter of ${ports.join(", ")}: it sits in ${ports.map((name) => `adapters/out/${name}/`).join(" or ")}`);
      continue;
    }
    const several = adapterFilesIn(dirOf(adapter.path)) > 1;
    const expected = several ? kebab(adapter.name) : port;
    if (placed.file !== expected) {
      out.push(
        several
          ? `${adapter.path} — adapters/out/${port}/ holds several adapters of the port, so each file is named for its class: ${dirOf(adapter.path)}/${expected}.ts`
          : `${adapter.path} — ${adapter.name} is the only adapter in adapters/out/${port}/, so its file is named for the port: ${dirOf(adapter.path)}/${expected}.ts`,
      );
    }
  }
  return out;
}

/** The adapter classes a contract's interface names in `@implementedBy`. */
function implementedBy(file: SourceFile): { readonly name: string; readonly classes: readonly string[] }[] {
  const out: { name: string; classes: string[] }[] = [];
  for (const statement of parse(file).statements) {
    if (!ts.isInterfaceDeclaration(statement)) continue;
    const tags = ts.getJSDocTags(statement).filter((tag) => tag.tagName.text === "implementedBy");
    const classes = tags.flatMap((tag) => (typeof tag.comment === "string" ? tag.comment : "").split(/\s+/).filter((name) => name !== ""));
    if (classes.length > 0) out.push({ name: statement.name.text, classes });
  }
  return out;
}

/**
 * A port's conformance suite: `<feature>.<name>.test-support.ts` beside its
 * contract, `<name>` the port's kebab-case name without a leading
 * `<feature>-` (`ComposePacksCatalog` of compose-packs → `compose-packs.catalog`).
 */
export function suitePathOf(contractPath: string, port: string): string {
  const feature = contractPath.split("/").at(-1)?.replace(/\.contract\.ts$/, "") ?? "";
  const name = kebab(port);
  return `${dirOf(contractPath)}/${feature}.${name.startsWith(`${feature}-`) ? name.slice(feature.length + 1) : name}.test-support.ts`;
}

/** Every module a file imports or re-exports from, dynamic imports with a literal specifier included. */
function importSpecs(file: SourceFile): string[] {
  const specs: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) specs.push(node.moduleSpecifier.text);
    const argument = ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : undefined;
    if (argument !== undefined && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) specs.push(argument.text);
    ts.forEachChild(node, visit);
  };
  visit(parse(file));
  return specs;
}

/** Whether a file imports `target` by relative path. */
const importsFile = (file: SourceFile, target: string): boolean => importSpecs(file).some((spec) => spec.startsWith(".") && resolve(file.path, spec) === target);

/**
 * R2: for every interface an application contract tags `@implementedBy
 * <Class…>`, each class is under `adapters/out/<port>/` and implements it;
 * every out adapter class implementing an application contract's port is
 * named in that port's tag; the port's conformance suite is exactly
 * `<feature>.<port>.test-support.ts` beside the contract (see suitePathOf),
 * and a test beside each adapter class runs it. `exempt` names ports
 * excused, each with its reason. An untagged port (the core names no
 * adapter, as for HostInstaller and ShellCommandReader) may be implemented
 * by an adapter in another context only when its suite exists beside the
 * contract and a test beside the adapter imports it through an export path
 * of the declaring package (one of `packages`, ADR 2026-020); in its own
 * context it is still refused, its tag not naming the adapter.
 */
export function implementedByViolations(
  files: readonly SourceFile[],
  barrels: ReadonlyMap<string, ReadonlyMap<string, string>>,
  exempt: ReadonlyMap<string, string> = new Map(),
  packages: readonly PackageExports[] = [],
): string[] {
  const out: string[] = [];
  const adapters = adapterClasses(files, barrels);
  const contextOf = (path: string): string | undefined => /^contexts\/[^/]+/.exec(path)?.[0];
  const tags = new Map<string, readonly string[]>();
  for (const contract of files.filter((file) => isApplicationContract(file.path))) {
    for (const { name, classes } of implementedBy(contract)) {
      tags.set(`${contract.path}#${name}`, classes);
      if (exempt.has(name)) continue;
      const suite = suitePathOf(contract.path, name);
      const hasSuite = files.some((file) => file.path === suite);
      if (!hasSuite) out.push(`${contract.path} — ${name} has no conformance suite: add ${suite.split("/").at(-1)} beside the contract, which every adapter of it runs`);
      for (const className of classes) {
        const adapter = adapters.find((candidate) => candidate.name === className && candidate.path.includes(`/adapters/out/${kebab(name)}/`) && candidate.ports.some((port) => port.name === name && port.contract === contract.path));
        if (adapter === undefined) {
          out.push(`${contract.path} — ${name} says it is implemented by ${className}, but no class ${className} under adapters/out/${kebab(name)}/ implements it`);
          continue;
        }
        const tested = files.some((file) => file.path.endsWith(".test.ts") && dirOf(file.path) === dirOf(adapter.path) && importsFile(file, suite));
        if (hasSuite && !tested) out.push(`${adapter.path} — ${adapter.name} implements ${name}; a test beside it runs the port's conformance suite`);
      }
    }
  }
  for (const adapter of adapters) {
    for (const port of adapter.ports) {
      if (port.contract === undefined || !isApplicationContract(port.contract) || exempt.has(port.name)) continue;
      const tag = tags.get(`${port.contract}#${port.name}`);
      const declaring = contextOf(port.contract);
      if (tag === undefined && declaring !== undefined && contextOf(adapter.path) !== declaring) {
        // An untagged port (the core names no adapter of it, as for HostInstaller) implemented in another context: its suite runs beside the adapter, through the declaring package's export path.
        out.push(...untaggedPortViolations(files, adapter, port.name, port.contract, packages.find((pkg) => pkg.dir === declaring)));
        continue;
      }
      if (!(tag ?? []).includes(adapter.name)) {
        out.push(`${adapter.path} — ${adapter.name} implements ${port.name}, but ${port.name}'s @implementedBy in ${port.contract} does not name it`);
      }
    }
  }
  return out;
}

/**
 * R2 for an untagged port implemented in another context: the port's suite
 * (suitePathOf) exists beside its contract, and a test beside the adapter
 * imports it through an export path of the declaring package, `declaring`.
 */
function untaggedPortViolations(files: readonly SourceFile[], adapter: AdapterClass, port: string, contract: string, declaring: PackageExports | undefined): string[] {
  const suite = suitePathOf(contract, port);
  if (!files.some((file) => file.path === suite)) return [`${contract} — ${port} has no conformance suite: add ${suite.split("/").at(-1)} beside the contract, which every adapter of it runs`];
  const exported = declaring === undefined ? [] : Object.entries(declaring.exports).filter(([, target]) => `${declaring.dir}/${target.replace(/^\.\//, "")}` === suite).map(([path]) => `${declaring.name}/${path.slice(2)}`);
  const tested = files.some((file) => file.path.endsWith(".test.ts") && dirOf(file.path) === dirOf(adapter.path) && importSpecs(file).some((spec) => exported.includes(spec)));
  if (tested) return [];
  const through = exported.length === 0 ? `an export path of ${declaring?.name ?? "its package"}, which has none for it yet` : exported.join(" or ");
  return [`${adapter.path} — ${adapter.name} implements ${port}, an untagged port of another context; a test beside it runs the port's conformance suite through ${through}`];
}

/** A package's name, directory and export paths, each mapped to the source file it serves. */
export interface PackageExports {
  readonly name: string;
  readonly dir: string;
  readonly exports: Readonly<Record<string, string>>;
}

/**
 * R2, test doubles: an in-memory test double (`<feature>.in-memory-<name>.test-support.ts`)
 * sits in an application feature's directory (the core's or a pack's), and a
 * test in that directory runs it through the port's suite
 * (`<feature>.<name>.test-support.ts`), importing both. No production file
 * (anything under contexts/<context>/src or apps/<app>/src but tests, test
 * support and fixtures) imports test support, by relative path or through a
 * package's export path, resolved to its target: test support that is
 * published for other packages' tests goes through `exports`, which this
 * does not touch, and is still never imported by production code.
 */
export function testDoubleViolations(files: readonly SourceFile[], packages: readonly PackageExports[]): string[] {
  const out: string[] = [];
  for (const double of files.filter((file) => /\.in-memory-[^/]+\.test-support\.ts$/.test(file.path))) {
    // A feature is application/<area>/<feature>/ in a context, application/<feature>/ in a shipped pack.
    const placed = /^(contexts\/[^/]+\/src\/(?:application\/[^/]+|packs\/[^/]+\/application)\/([^/]+))\/\2\.in-memory-([^/]+)\.test-support\.ts$/.exec(double.path);
    if (placed === null) {
      out.push(`${double.path} — an in-memory test double sits in its port's feature directory, as <feature>.in-memory-<port>.test-support.ts`);
      continue;
    }
    const [, dir = "", feature = "", name = ""] = placed;
    const suite = `${dir}/${feature}.${name}.test-support.ts`;
    const run = files.some((file) => file.path.endsWith(".test.ts") && dirOf(file.path) === dir && importsFile(file, double.path) && importsFile(file, suite));
    if (!run) out.push(`${double.path} — a test beside it runs this double through its port's conformance suite, ${feature}.${name}.test-support.ts`);
  }
  for (const file of files) {
    if (isTest(file.path) || !/^(contexts|apps)\/[^/]+\/src\//.test(file.path)) continue;
    for (const spec of new Set(importSpecs(file))) {
      const exported = packages.find((pkg) => spec.startsWith(`${pkg.name}/`));
      const target = spec.startsWith(".") ? resolve(file.path, spec) : exported === undefined ? undefined : `${exported.dir}/${(exported.exports[`./${spec.slice(exported.name.length + 1)}`] ?? "").replace(/^\.\//, "")}`;
      // Without an extension, or with .js, a specifier still resolves to the .test-support.ts file (moduleResolution bundler).
      if (target !== undefined && /\.test-support(\.[jt]s)?$/.test(target)) out.push(`${file.path} imports "${spec}" — production code never imports test support`);
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
  const inScope = (path: string): boolean => /^contexts\/[^/]+\/src\/(domain\/|packs\/[^/]+\/(domain\/|[^/]+\.(pack|contract)\.ts$))/.test(path);
  for (const path of paths.filter(inScope)) {
    if (exempt.has(path) || isTest(path) || path.endsWith("/index.ts")) continue;
    if (path.endsWith(".pack.ts")) {
      // A pack's overview: its contract and its test sit beside it.
      const base = path.slice(0, -".pack.ts".length);
      for (const needed of [".contract.ts", ".pack.test.ts"]) {
        if (!present.has(`${base}${needed}`)) out.push(`${path} — a pack is its overview, its contract and its test: add ${base.split("/").at(-1)}${needed}`);
      }
      continue;
    }
    if (path.endsWith(".contract.ts")) {
      const base = path.slice(0, -".contract.ts".length);
      if (!present.has(`${base}.ts`) && !present.has(`${base}.pack.ts`)) out.push(`${path} — a contract with no implementation: add ${base.split("/").at(-1)}.ts, or fold its types into the contract they belong to`);
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

/**
 * R5: each file named in `allowed` contains exactly that many type assertions
 * (`x as T`, `<T>x`, `x!`, or a ts-ignore, ts-expect-error or
 * ts-nocheck directive), so routing is typed by the compiler, not claimed.
 * A guard against mistakes: an assertion hidden in a helper imported from
 * another file is not seen.
 */
export function assertionViolations(files: readonly SourceFile[], allowed: ReadonlyMap<string, number>): string[] {
  const out: string[] = [];
  for (const [path, limit] of allowed) {
    const file = files.find((candidate) => candidate.path === path);
    if (file === undefined) {
      out.push(`${path} — named by the assertion rule but missing`);
      continue;
    }
    const lines: number[] = [];
    const source = parse(file);
    const visit = (node: ts.Node): void => {
      if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) {
        if (!(ts.isAsExpression(node) && ts.isTypeReferenceNode(node.type) && node.type.getText(source) === "const")) lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    // A directive that silences the compiler claims as much as an assertion does.
    for (const [i, text] of file.text.split("\n").entries()) if (/@ts-(ignore|expect-error|nocheck)/.test(text)) lines.push(i + 1);
    lines.sort((a, b) => a - b);
    if (lines.length !== limit) out.push(`${path} — ${lines.length} type assertions (as, <T>x, !, @ts-ignore) at line ${lines.join(", ") || "none"}; it may have ${limit}`);
  }
  return out;
}

/**
 * R6: in domain and application code (the core's and packs'), a shape check
 * (`Array.isArray(…)`, `typeof … === "object"`, `… instanceof …`) appears
 * only where a shape is owned: a file with a class that has a static `parse`
 * or a private constructor (its factory), or a `parse` function, or a
 * command file. Any other file is named in `allowed`, with its reason.
 * Reading what was thrown (`instanceof Error`) is not a shape check.
 */
export function shapeCheckViolations(files: readonly SourceFile[], allowed: ReadonlyMap<string, string> = new Map()): string[] {
  const out: string[] = [];
  for (const file of files) {
    if (isTest(file.path) || allowed.has(file.path) || file.path.endsWith(".command.ts")) continue;
    if (!/^contexts\/[^/]+\/src\/(?:packs\/[^/]+\/)?(?:domain|application)\//.test(file.path) && !/^contexts\/[^/]+\/src\/packs\/[^/]+\/[^/]+\.ts$/.test(file.path)) continue;
    const source = parse(file);
    let owner = false;
    const lines: number[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === "parse") owner = true;
      if (ts.isClassDeclaration(node)) {
        owner ||= node.members.some(
          (member) =>
            (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === "parse" && (ts.getModifiers(member) ?? []).some((m) => m.kind === ts.SyntaxKind.StaticKeyword)) ||
            (ts.isConstructorDeclaration(member) && (ts.getModifiers(member) ?? []).some((m) => m.kind === ts.SyntaxKind.PrivateKeyword)),
        );
      }
      const isArrayCheck = ts.isCallExpression(node) && node.expression.getText(source) === "Array.isArray";
      const isObjectCheck =
        ts.isBinaryExpression(node) &&
        [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(node.operatorToken.kind) &&
        [node.left, node.right].some((side) => ts.isTypeOfExpression(side)) &&
        [node.left, node.right].some((side) => ts.isStringLiteral(side) && side.text === "object");
      // Reading what was thrown (`instanceof Error`) is not a shape check.
      const isInstanceCheck = ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && node.right.getText(source) !== "Error";
      if (isArrayCheck || isObjectCheck || isInstanceCheck) lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (lines.length > 0 && !owner) out.push(`${file.path}:${lines.join(",")} — a shape check belongs in the parse or factory of the class that owns the shape (AGENTS.md, ADR 2026-013)`);
  }
  return out;
}

/**
 * Brands stay module-private: a contract declares `export declare const
 * <name>Brand: unique symbol` for its class to carry, and no barrel exports
 * it, or re-exports a contract wholesale, so code outside the package cannot
 * write the brand into a look-alike (ADR 2026-012).
 */
export function brandExportViolations(files: readonly SourceFile[]): string[] {
  const out: string[] = [];
  for (const file of files) {
    if (isTest(file.path) || !file.path.endsWith("/index.ts")) continue;
    for (const statement of parse(file).statements) {
      if (!ts.isExportDeclaration(statement)) continue;
      const names = statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause) ? statement.exportClause.elements.map((element) => element.name.text) : undefined;
      if (names === undefined) out.push(`${file.path} — a barrel names what it exports, so it never passes on a brand`);
      else for (const name of names.filter((name) => name.endsWith("Brand"))) out.push(`${file.path} — ${name} is a brand: it stays in its contract, never in a barrel`);
    }
  }
  return out;
}

/** The sections of definePack, in the only order an overview may give them. */
const SECTIONS = ["id", "dependsOn", "points", "contributes", "ports"];
const PACK_DIR = /^(contexts\/[^/]+\/src\/packs\/([^/]+))\/(.+)$/;

/**
 * R7, layout: a shipped pack's directory holds exactly its overview
 * (`<name>.pack.ts`), its contract (`<name>.contract.ts`), its index, the
 * overview's test and an optional README, and only the folders `domain/`,
 * `application/` and `adapters/`.
 */
export function packLayoutViolations(paths: readonly string[]): string[] {
  const out: string[] = [];
  const dirs = new Map<string, string>();
  for (const path of paths) {
    const match = PACK_DIR.exec(path);
    if (match === null) continue;
    const [, dir = "", name = "", rest = ""] = match;
    dirs.set(dir, name);
    const allowed = rest.includes("/") ? ["domain", "application", "adapters"].includes(rest.split("/")[0] ?? "") : [`${name}.pack.ts`, `${name}.contract.ts`, `${name}.pack.test.ts`, "index.ts", "README.md"].includes(rest);
    if (!allowed) out.push(`${path} — a pack's directory holds its overview, contract, index and their test at its root, and everything else in domain/, application/ or adapters/`);
  }
  for (const [dir, name] of dirs) {
    for (const needed of [`${name}.pack.ts`, `${name}.contract.ts`, "index.ts"]) if (!paths.includes(`${dir}/${needed}`)) out.push(`${dir} — a shipped pack has ${needed}`);
  }
  return out;
}

/**
 * R7, overview: a pack is defined only in an overview file (`<name>.pack.ts`),
 * which holds imports and one `export const <x>: <Type> = definePack({…})`,
 * `<Type>` from `./<name>.contract.ts`; its sections are a subsequence of id,
 * dependsOn, points, contributes, ports; and every value is built from
 * imported names, property access, calls and array or object literals: no
 * functions, conditionals, operators or literal text. A shipped pack's
 * overview imports only its own domain/ and application/, its contract and
 * the core's domain export.
 */
export function packOverviewViolations(files: readonly SourceFile[], domainExport = "bounded/domain"): string[] {
  const out: string[] = [];
  for (const file of files) {
    if (isTest(file.path) || !/^contexts\/[^/]+\/src\//.test(file.path)) continue;
    const source = parse(file);
    const overview = file.path.endsWith(".pack.ts");
    if (!overview) {
      const calls: number[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "definePack") calls.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
        ts.forEachChild(node, visit);
      };
      visit(source);
      if (calls.length > 0) out.push(`${file.path}:${calls.join(",")} — a pack is defined in its overview file, <name>.pack.ts`);
      continue;
    }
    const base = file.path.split("/").at(-1)?.slice(0, -".pack.ts".length) ?? "";
    const contract = `./${base}.contract.ts`;
    const shipped = PACK_DIR.test(file.path);
    const at = (node: ts.Node) => `${file.path}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
    const imports = importedNames(source);
    const consts = source.statements.filter((statement): statement is ts.VariableStatement => ts.isVariableStatement(statement));
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement)) {
        const spec = ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : "";
        const allowed = spec === contract || spec.startsWith("./domain/") || spec.startsWith("./application/") || spec === domainExport || (!shipped && spec.startsWith("."));
        if (!allowed) out.push(`${at(statement)} — an overview imports only its domain/, application/, its contract and ${domainExport}, never "${spec}"`);
      } else if (!ts.isVariableStatement(statement)) out.push(`${at(statement)} — an overview holds imports and its pack, nothing else`);
    }
    const declaration = consts.length === 1 && exported(consts[0] as ts.VariableStatement) ? consts[0]?.declarationList.declarations[0] : undefined;
    const call = declaration?.initializer;
    if (declaration === undefined || call === undefined || !ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== "definePack" || call.arguments.length !== 1 || !ts.isObjectLiteralExpression(call.arguments[0] as ts.Expression)) {
      out.push(`${file.path} — an overview exports one pack, as const <x>: <Type> = definePack({ … })`);
      continue;
    }
    const type = declaration.type;
    const typeName = type !== undefined && ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) ? type.typeName.text : undefined;
    if (typeName === undefined || imports.get(typeName)?.spec !== contract) out.push(`${file.path} — the pack is typed with the pack type its contract declares (${contract})`);
    const spec = call.arguments[0] as ts.ObjectLiteralExpression;
    const keys = spec.properties.map((property) => (property.name !== undefined && ts.isIdentifier(property.name) ? property.name.text : "?"));
    const order = keys.map((key) => SECTIONS.indexOf(key));
    if (order.some((index, i) => index < 0 || (i > 0 && index <= (order[i - 1] ?? -1)))) out.push(`${file.path} — an overview's sections are id, dependsOn, points, contributes, ports, in that order (it gives ${keys.join(", ")})`);
    const binding = (node: ts.Node): boolean =>
      ts.isIdentifier(node) ||
      (ts.isPropertyAccessExpression(node) && binding(node.expression)) ||
      (ts.isElementAccessExpression(node) && binding(node.expression) && binding(node.argumentExpression)) ||
      (ts.isCallExpression(node) && binding(node.expression) && node.arguments.every(binding)) ||
      (ts.isArrayLiteralExpression(node) && node.elements.every(binding)) ||
      (ts.isObjectLiteralExpression(node) && node.properties.every((property) => (ts.isPropertyAssignment(property) && binding(property.initializer)) || ts.isShorthandPropertyAssignment(property)));
    for (const property of spec.properties) {
      if (!ts.isPropertyAssignment(property) || !binding(property.initializer)) out.push(`${at(property)} — an overview binds imported names only: no functions, conditionals, operators or literal text`);
    }
  }
  return out;
}
