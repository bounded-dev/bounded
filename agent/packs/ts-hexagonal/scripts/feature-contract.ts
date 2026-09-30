// The feature contract parser (TN-26-012 §3, §4): one
// `contexts/<context>/src/application/<area>/<feature>/<feature>.contract.ts`
// → a `FeatureContractModel`. Emitters in this pack and in the adapter packs
// read the model, never the source.
//
// It is deliberately strict. Every rule of TN-26-012 §3 and §4 is checked, and
// anything else is refused with the contract path and the fix: a generator
// that guessed at a shape it did not recognise would emit plausible code for
// a design nobody wrote.

import ts from "typescript";
import type {
  ConceptKind,
  FeatureContractModel,
  FeatureInputModel,
  FieldModel,
  InputFieldModel,
  MethodModel,
  OutPortModel,
  ParameterModel,
  ReturnModel,
  TypeRef,
} from "../../ts/scripts/feature-model.ts";
import { camelCase, featureKind, pascalCase, portRole } from "../../ts/scripts/naming.ts";
import type { AdapterTechnology } from "../../ts/pack.ts";
import { featureNameProblem, isAreaName, KEBAB, PASCAL } from "./grammar.ts";

/** A contract the parser refuses. The message names the path and the fix. */
export class ContractShapeError extends Error {
  readonly path: string;

  constructor(path: string, problem: string) {
    super(`${path}: ${problem} (TN-26-012 §3-§4)`);
    this.name = "ContractShapeError";
    this.path = path;
  }
}

export interface FeatureParseOptions {
  /** The package scope with its `@`, e.g. `@example`. */
  readonly scope: string;
  /** The context's domain concepts by interface name, when known. With it,
   *  every Command field must be a concept whose factory has `parse`, and
   *  every imported name must be a concept. */
  readonly concepts?: ReadonlyMap<string, ConceptKind>;
  /** The composed adapter technologies, when known. With them, tag ids must
   *  name composed technologies of the right direction. */
  readonly adapterTechnologies?: readonly AdapterTechnology[];
}

/** File roles the naming table already uses; an out port's role may not
 *  reuse one, or its adapter file would be mistaken for another kind. */
const RESERVED_ROLES = new Set([
  "command", "contract", "database", "handler", "index", "laws", "lambda", "mapper", "procedure", "router", "schema",
  "server", "store", "test", "tool",
]);

/** Names the generated command file binds itself; an Input field may not
 *  shadow one. */
const COMMAND_LOCALS = new Set(["input", "raw", "z"]);
const RESERVED_WORDS = new Set([
  "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else", "enum",
  "export", "extends", "false", "finally", "for", "function", "if", "implements", "import", "in", "instanceof",
  "interface", "let", "new", "null", "package", "private", "protected", "public", "return", "static", "super", "switch",
  "this", "throw", "true", "try", "typeof", "var", "void", "while", "with", "yield",
]);
/** Names strict-mode code may not bind: the command file's fields and a
 *  skeleton's parameters become bindings. */
const STRICT_ILLEGAL = new Set(["arguments", "eval"]);
/** Names every object already has. As a field or port method they shadow
 *  or break the prototype (`constructor`, `__proto__`), and `then` makes a
 *  port thenable, so awaiting it would call the method. */
const OBJECT_MEMBERS = new Set([
  "__brand", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__", "__proto__", "constructor",
  "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "prototype", "then", "toLocaleString", "toString", "valueOf",
]);

/** Why an identifier cannot be bound in the generated code, or undefined. */
function bindingProblem(name: string): string | undefined {
  if (RESERVED_WORDS.has(name)) return `'${name}' is a reserved word`;
  if (STRICT_ILLEGAL.has(name)) return `'${name}' cannot be bound in strict-mode code`;
  if (OBJECT_MEMBERS.has(name)) return `'${name}' is a member every object already has`;
  return undefined;
}

const FEATURE_PATH =/^contexts\/([^/]+)\/src\/application\/([^/]+)\/([^/]+)\/([^/]+)\.contract\.ts$/;
const TAG_NAMES = ["exposedVia", "implementedBy"] as const;
type TagName = (typeof TAG_NAMES)[number];
const TAG_LINE = /^@(exposedVia|implementedBy)((?:\s+[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+)$/;

interface DocBlock {
  readonly summary?: string;
  readonly tags: ReadonlyMap<TagName, readonly string[]>;
}

export function parseFeatureContract(path: string, source: string, options: FeatureParseOptions): FeatureContractModel {
  const refuse = (problem: string): never => {
    throw new ContractShapeError(path, problem);
  };
  const where = FEATURE_PATH.exec(path);
  if (where === null) {
    return refuse("a feature contract lives at contexts/<context>/src/application/<area>/<feature>/<feature>.contract.ts");
  }
  const [, context, area, feature, stem] = where as unknown as [string, string, string, string, string];
  if (!KEBAB.test(context)) refuse(`context '${context}' is not kebab-case`);
  if (!isAreaName(area)) refuse(`area '${area}' must be a kebab-case plural business noun (e.g. 'notes', 'order-lines')`);
  const featureProblem = featureNameProblem(area, feature);
  if (featureProblem !== undefined) refuse(`feature ${featureProblem}`);
  if (stem !== feature) refuse(`the file must be named '${feature}.contract.ts' after its feature folder`);
  if (!/^@[a-z0-9][a-z0-9-]*$/.test(options.scope)) refuse(`scope '${options.scope}' is not '@' plus a kebab-case name`);

  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const syntax = (file as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (syntax.length > 0) {
    refuse(`does not parse: ${ts.flattenDiagnosticMessageText(syntax[0]!.messageText, " ")}`);
  }

  const inPortName = pascalCase(feature);
  const domainImport = `${options.scope}/${context}/domain`;
  const text = (node: ts.Node): string => node.getText(file).replace(/\s+/g, " ").trim();

  // --- statements: at most one import, then exported interfaces only ---------
  const imported = new Set<string>();
  const interfaces: ts.InterfaceDeclaration[] = [];
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (interfaces.length > 0) refuse("the import must come before every declaration");
      if (imported.size > 0) refuse(`a feature contract has exactly one import, from "${domainImport}"`);
      readImport(statement, domainImport, imported, refuse, text);
      continue;
    }
    if (ts.isInterfaceDeclaration(statement)) {
      const exported = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true;
      const other = statement.modifiers?.some((m) => m.kind !== ts.SyntaxKind.ExportKeyword) === true;
      if (!exported || other) refuse(`interface ${statement.name.text} must be declared 'export interface'`);
      if (statement.typeParameters !== undefined) refuse(`interface ${statement.name.text} may not be generic`);
      if (statement.heritageClauses !== undefined) refuse(`interface ${statement.name.text} may not extend anything`);
      if (!PASCAL.test(statement.name.text)) refuse(`interface ${statement.name.text} is not PascalCase`);
      interfaces.push(statement);
      continue;
    }
    refuse(`only one type import and exported interfaces are allowed; found '${text(statement).slice(0, 60)}'`);
  }
  const names = interfaces.map((i) => i.name.text);
  const duplicate = names.find((name, i) => names.indexOf(name) !== i);
  if (duplicate !== undefined) refuse(`interface ${duplicate} is declared twice`);
  const local = new Set(names);
  for (const name of imported) {
    if (local.has(name)) refuse(`'${name}' is both imported and declared`);
    if (name !== "Result" && options.concepts !== undefined && !options.concepts.has(name)) {
      refuse(`'${name}' is not a domain concept of context '${context}'`);
    }
  }

  // --- every type name used must be imported, local, or Promise --------------
  const used = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isTypeReferenceNode(node)) {
      if (!ts.isIdentifier(node.typeName)) refuse(`qualified type '${text(node.typeName)}' is not allowed`);
      const name = (node.typeName as ts.Identifier).text;
      if (name !== "Promise" && !imported.has(name) && !local.has(name)) {
        refuse(`type '${name}' is neither imported from "${domainImport}" nor declared here`);
      }
      used.add(name);
    }
    if (ts.isTypeQueryNode(node) || ts.isImportTypeNode(node) || ts.isIndexedAccessTypeNode(node) ||
        ts.isConditionalTypeNode(node) || ts.isMappedTypeNode(node) || ts.isTypeOperatorNode(node) ||
        ts.isFunctionTypeNode(node) || ts.isConstructorTypeNode(node) || ts.isTupleTypeNode(node)) {
      refuse(`type '${text(node)}' is too clever for a contract; use a domain concept, a primitive or an array of one`);
    }
    ts.forEachChild(node, visit);
  };
  for (const declaration of interfaces) visit(declaration);
  for (const name of imported) if (!used.has(name)) refuse(`'${name}' is imported but not used`);

  // --- tags: every mention of a semantic tag must be a well-formed one --------
  const docs = new Map(interfaces.map((i) => [i.name.text, readDoc(i, file, refuse)] as const));
  const recognised = [...docs.values()].reduce((n, d) => n + d.tags.size, 0);
  const mentioned = [...source.matchAll(/@(exposedvia|implementedby)\b/gi)].length;
  if (mentioned !== recognised) {
    refuse("@exposedVia / @implementedBy appear only as one tag line in the /** */ block directly above an interface");
  }

  // --- the declaration sequence ---------------------------------------------
  const hasInput = local.has(`${inPortName}Input`) || local.has(`${inPortName}Command`) ||
    local.has(`${inPortName}CommandFactory`);
  const head = hasInput
    ? [`${inPortName}Input`, `${inPortName}Command`, `${inPortName}CommandFactory`, inPortName]
    : [inPortName];
  head.forEach((expected, i) => {
    if (names[i] !== expected) {
      refuse(hasInput
        ? `declare ${head.join(", ")} first and in that order (Input, Command and CommandFactory are all present or all absent)`
        : `the in port '${inPortName}' must be the first interface`);
    }
  });
  for (const name of head.slice(0, -1)) {
    const tags = docs.get(name)!.tags;
    if (tags.size > 0) refuse(`${name} may not carry @exposedVia or @implementedBy`);
  }

  const byName = new Map(interfaces.map((i) => [i.name.text, i] as const));
  const typeRef = (node: ts.TypeNode): TypeRef => toTypeRef(node, imported, local, text);

  const input = hasInput
    ? readInput(inPortName, feature, byName, imported, options, refuse, text)
    : undefined;

  // --- in port -----------------------------------------------------------------
  const inPort = byName.get(inPortName)!;
  const inDoc = docs.get(inPortName)!;
  if (inDoc.tags.has("implementedBy")) refuse(`the in port ${inPortName} may carry @exposedVia only`);
  if (inPort.members.length !== 1) refuse(`the in port ${inPortName} has exactly one member, execute`);
  const execute = methodOf(inPort.members[0]!, inPortName, refuse, typeRef);
  if (execute.name !== "execute") refuse(`the in port ${inPortName} has exactly one member, execute`);
  let parameter: ParameterModel | undefined;
  if (hasInput) {
    const [only, ...rest] = execute.parameters;
    if (only === undefined || rest.length > 0 || only.name !== "command" || only.type.text !== `${inPortName}Command`) {
      refuse(`${inPortName}.execute takes exactly (command: ${inPortName}Command)`);
    }
    parameter = only;
  } else if (execute.parameters.length > 0) {
    refuse(`${inPortName}.execute takes no parameters when the feature has no Input`);
  }
  const returns = readReturn(execute.returns, imported, inPortName, refuse);

  const exposedVia = inDoc.tags.get("exposedVia") ?? [];
  checkTechnologies(exposedVia, "exposedVia", options, refuse);
  if (exposedVia.includes("mcp") && (inDoc.summary ?? "") === "") {
    refuse(`${inPortName} is exposed via mcp, so its /** */ block needs a summary line: it is the tool description`);
  }

  // --- out ports -----------------------------------------------------------------
  const outPorts: OutPortModel[] = [];
  const roles = new Map<string, string>();
  for (const declaration of interfaces.slice(head.length)) {
    const name = declaration.name.text;
    const doc = docs.get(name)!;
    if (doc.tags.has("exposedVia")) refuse(`out port ${name} may not carry @exposedVia; it belongs on the in port`);
    const isStore = name === `${inPortName}Store`;
    if (!isStore && name.endsWith("Store")) {
      refuse(`out port ${name}: the store port is named exactly ${inPortName}Store, and a feature has at most one`);
    }
    const role = portRole(name);
    if (!isStore && RESERVED_ROLES.has(role)) {
      refuse(`out port ${name}: its role '${role}' is already a file role in the naming table; name the capability`);
    }
    if (roles.has(role)) {
      refuse(`out ports ${roles.get(role)} and ${name} share the role '${role}', so their handler parameters would clash`);
    }
    roles.set(role, name);
    const implementedBy = doc.tags.get("implementedBy") ?? [];
    if (isStore && implementedBy.length > 0) {
      refuse(`${name} is the store: it is implemented once per storage technology, so it takes no @implementedBy`);
    }
    if (!isStore && implementedBy.length === 0) {
      refuse(`out port ${name} needs '@implementedBy <technology>' in the /** */ block directly above it`);
    }
    checkTechnologies(implementedBy, "implementedBy", options, refuse);
    if (declaration.members.length === 0) refuse(`out port ${name} declares no methods`);
    const methods = declaration.members.map((m) => methodOf(m, name, refuse, typeRef));
    const methodNames = methods.map((m) => m.name);
    const repeated = methodNames.find((m, i) => methodNames.indexOf(m) !== i);
    if (repeated !== undefined) refuse(`out port ${name} declares '${repeated}' twice; overloads are not allowed`);
    for (const method of methods) {
      if (method.returns.kind !== "promise") refuse(`${name}.${method.name} must return a Promise`);
    }
    outPorts.push({
      name, role, isStore, methods, implementedBy,
      ...(doc.summary === undefined ? {} : { doc: doc.summary }),
    });
  }

  return {
    context, area, feature,
    kind: featureKind(feature),
    contractPath: path,
    domainImport,
    domainTypes: [...imported].filter((n) => n !== "Result").sort(),
    ...(input === undefined ? {} : { input }),
    inPort: { name: inPortName, ...(parameter === undefined ? {} : { parameter }), returns },
    outPorts,
    exposedVia,
    ...(inDoc.summary === undefined ? {} : { doc: inDoc.summary }),
  };
}

function readImport(
  node: ts.ImportDeclaration,
  domainImport: string,
  imported: Set<string>,
  refuse: (problem: string) => never,
  text: (node: ts.Node) => string,
): void {
  const specifier = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : "";
  const clause = node.importClause;
  const shape = `import type { … } from "${domainImport}"`;
  if (specifier !== domainImport) refuse(`imports "${specifier}"; the only import allowed is ${shape}`);
  if (clause === undefined || !clause.isTypeOnly || clause.name !== undefined || clause.namedBindings === undefined ||
      !ts.isNamedImports(clause.namedBindings) || node.attributes !== undefined) {
    refuse(`the import must be exactly ${shape}`);
  }
  const elements = (clause!.namedBindings as ts.NamedImports).elements;
  if (elements.length === 0) refuse(`the import names nothing; drop it`);
  const names = elements.map((element) => {
    if (element.propertyName !== undefined || element.isTypeOnly) refuse(`'${text(element)}': no aliases or inline 'type' in ${shape}`);
    return element.name.text;
  });
  const sorted = [...names].sort();
  if (names.join() !== sorted.join()) refuse(`sort the imported names: { ${sorted.join(", ")} }`);
  for (const name of names) {
    if (imported.has(name)) refuse(`'${name}' is imported twice`);
    imported.add(name);
  }
}

function readDoc(declaration: ts.InterfaceDeclaration, file: ts.SourceFile, refuse: (problem: string) => never): DocBlock {
  const source = file.getFullText();
  const ranges = ts.getLeadingCommentRanges(source, declaration.getFullStart()) ?? [];
  const blocks = ranges.filter((r) => r.kind === ts.SyntaxKind.MultiLineCommentTrivia && source.startsWith("/**", r.pos));
  const name = declaration.name.text;
  if (blocks.length === 0) return { tags: new Map() };
  if (blocks.length > 1 || ranges.at(-1) !== blocks[0]) {
    refuse(`${name}: its /** */ block must sit directly above it, with no other comment in between`);
  }
  const block = source.slice(blocks[0]!.pos + 3, blocks[0]!.end - 2);
  const summary: string[] = [];
  const tags = new Map<TagName, string[]>();
  let inTags = false;
  for (const raw of block.split("\n")) {
    const line = raw.replace(/^\s*\*?/, "").trim();
    if (/^@/.test(line)) inTags = true;
    if (/^@(exposedvia|implementedby)\b/i.test(line)) {
      const tag = TAG_LINE.exec(line);
      if (tag === null) refuse(`${name}: '${line}' is not a valid tag line; write '@exposedVia <tech> …' with kebab-case ids`);
      const kind = tag![1] as TagName;
      if (tags.has(kind)) refuse(`${name}: at most one @${kind} tag`);
      const ids = tag![2]!.trim().split(/\s+/);
      const twice = ids.find((id, i) => ids.indexOf(id) !== i);
      if (twice !== undefined) refuse(`${name}: @${kind} names '${twice}' twice`);
      tags.set(kind, ids);
      continue;
    }
    if (!inTags && line !== "") summary.push(line);
  }
  const joined = summary.join(" ").trim();
  return { ...(joined === "" ? {} : { summary: joined }), tags };
}

function checkTechnologies(
  ids: readonly string[],
  tag: TagName,
  options: FeatureParseOptions,
  refuse: (problem: string) => never,
): void {
  if (options.adapterTechnologies === undefined) return;
  for (const id of ids) {
    const technology = options.adapterTechnologies.find((t) => t.id === id);
    if (technology === undefined) refuse(`@${tag} names '${id}', which no composed pack contributes as an adapter technology`);
    if (tag === "exposedVia" && technology!.direction !== "in") refuse(`@exposedVia names '${id}', which is not an in adapter`);
    if (tag === "implementedBy" && (technology!.direction !== "out" || technology!.storage)) {
      refuse(`@implementedBy names '${id}', which is not a non-storage out adapter`);
    }
  }
}

function readInput(
  inPortName: string,
  feature: string,
  byName: ReadonlyMap<string, ts.InterfaceDeclaration>,
  imported: ReadonlySet<string>,
  options: FeatureParseOptions,
  refuse: (problem: string) => never,
  text: (node: ts.Node) => string,
): FeatureInputModel {
  const inputName = `${inPortName}Input`;
  const commandName = `${inPortName}Command`;
  const factoryName = `${inPortName}CommandFactory`;
  const properties = (name: string): ts.PropertySignature[] => byName.get(name)!.members.map((member) => {
    if (!ts.isPropertySignature(member) || !ts.isIdentifier(member.name) || member.type === undefined) {
      return refuse(`${name} holds only 'readonly <field>: <type>' properties`);
    }
    const readonly = member.modifiers?.some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword) === true;
    if (!readonly || member.questionToken !== undefined) {
      refuse(`${name}.${member.name.text} must be readonly and required (optional fields are refused for now)`);
    }
    return member;
  });

  const wire = properties(inputName);
  if (wire.length === 0) refuse(`${inputName} declares no fields; a feature without input has no Input, Command or CommandFactory`);
  const wireTypes = wire.map((field) => {
    const type = field.type!.kind;
    if (type === ts.SyntaxKind.StringKeyword) return "string" as const;
    if (type === ts.SyntaxKind.NumberKeyword) return "number" as const;
    if (type === ts.SyntaxKind.BooleanKeyword) return "boolean" as const;
    return refuse(`${inputName}.${(field.name as ts.Identifier).text} must be string, number or boolean (arrays are refused for now)`);
  });

  const command = properties(commandName);
  const [brand, ...fields] = command;
  if (brand === undefined || (brand.name as ts.Identifier).text !== "__brand" ||
      text(brand.type!) !== `"${commandName}"`) {
    refuse(`${commandName} starts with 'readonly __brand: "${commandName}"'`);
  }
  const wireNames = wire.map((f) => (f.name as ts.Identifier).text);
  const repeatedField = wireNames.find((n, i) => wireNames.indexOf(n) !== i);
  if (repeatedField !== undefined) refuse(`${inputName} declares the field '${repeatedField}' twice`);
  for (const name of wireNames) {
    const problem = bindingProblem(name);
    if (problem !== undefined) refuse(`${inputName}.${name}: ${problem}; rename the field`);
    if (!/^[a-z][A-Za-z0-9]*$/.test(name) || COMMAND_LOCALS.has(name)) {
      refuse(`${inputName}.${name}: field names are camelCase identifiers other than ${[...COMMAND_LOCALS].join(", ")}`);
    }
  }
  const commandFieldNames = fields.map((f) => (f.name as ts.Identifier).text);
  const repeatedCommand = commandFieldNames.find((n, i) => commandFieldNames.indexOf(n) !== i);
  if (repeatedCommand !== undefined) refuse(`${commandName} declares the field '${repeatedCommand}' twice`);
  const commandNames = fields.map((f) => (f.name as ts.Identifier).text);
  if (wireNames.join() !== commandNames.join()) {
    refuse(`${commandName} must declare the fields of ${inputName} in the same order: ${wireNames.join(", ")}`);
  }
  const inputFields: InputFieldModel[] = fields.map((field, i) => {
    const type = field.type!;
    const fieldName = commandNames[i]!;
    if (!ts.isTypeReferenceNode(type) || !ts.isIdentifier(type.typeName) || type.typeArguments !== undefined ||
        !imported.has(type.typeName.text) || type.typeName.text === "Result") {
      return refuse(`${commandName}.${fieldName} must be typed by a domain value object imported from the domain barrel`);
    }
    const concept = type.typeName.text;
    const kind = options.concepts?.get(concept);
    if (options.concepts !== undefined && kind !== "value-object" && kind !== "identifier") {
      refuse(`${commandName}.${fieldName}: '${concept}' is not a value object or identifier (its factory needs parse)`);
    }
    return { name: fieldName, wireType: wireTypes[i]!, concept };
  });

  const factory = byName.get(factoryName)!;
  const parse = factory.members[0];
  const expected = `parse(raw: unknown): Result<${commandName}>;`;
  if (factory.members.length !== 1 || parse === undefined || !ts.isMethodSignature(parse) ||
      text(parse).replace(/;?$/, ";") !== expected) {
    refuse(`${factoryName} is exactly { ${expected} }`);
  }
  if (!imported.has("Result")) refuse(`import Result from the domain barrel for ${factoryName}`);
  return {
    inputName,
    commandName,
    commandFactoryName: factoryName,
    schemaName: `${camelCase(feature)}Schema`,
    fields: inputFields,
  };
}

function methodOf(
  member: ts.TypeElement,
  owner: string,
  refuse: (problem: string) => never,
  typeRef: (node: ts.TypeNode) => TypeRef,
): MethodModel {
  if (!ts.isMethodSignature(member) || !ts.isIdentifier(member.name) || member.questionToken !== undefined ||
      member.typeParameters !== undefined || member.type === undefined) {
    return refuse(`${owner} may hold only plain methods with an explicit return type`);
  }
  const name = member.name.text;
  if (OBJECT_MEMBERS.has(name)) refuse(`${owner}.${name}: '${name}' is a member every object already has; name the method for what it does`);
  const parameters = member.parameters.map((p): ParameterModel => {
    if (!ts.isIdentifier(p.name) || p.questionToken !== undefined || p.dotDotDotToken !== undefined ||
        p.initializer !== undefined || p.type === undefined) {
      return refuse(`${owner}.${name}: parameters are plain 'name: Type' (no optional, rest or destructured ones)`);
    }
    // A parameter becomes a binding in the skeleton: reserved and
    // strict-mode-illegal names cannot be one.
    if (RESERVED_WORDS.has(p.name.text) || STRICT_ILLEGAL.has(p.name.text)) {
      refuse(`${owner}.${name}: parameter ${bindingProblem(p.name.text)}; rename it`);
    }
    return { name: p.name.text, type: typeRef(p.type) };
  });
  const names = parameters.map((p) => p.name);
  if (new Set(names).size !== names.length) refuse(`${owner}.${name} repeats a parameter name`);
  return { name, parameters, returns: typeRef(member.type) };
}

function toTypeRef(
  node: ts.TypeNode,
  imported: ReadonlySet<string>,
  local: ReadonlySet<string>,
  text: (node: ts.Node) => string,
): TypeRef {
  const self = text(node);
  const recurse = (inner: ts.TypeNode): TypeRef => toTypeRef(inner, imported, local, text);
  switch (node.kind) {
    case ts.SyntaxKind.StringKeyword: return { kind: "primitive", text: self, name: "string" };
    case ts.SyntaxKind.NumberKeyword: return { kind: "primitive", text: self, name: "number" };
    case ts.SyntaxKind.BooleanKeyword: return { kind: "primitive", text: self, name: "boolean" };
    case ts.SyntaxKind.VoidKeyword: return { kind: "void", text: "void" };
    default: break;
  }
  if (ts.isArrayTypeNode(node)) return { kind: "array", text: self, element: recurse(node.elementType) };
  if (ts.isTypeLiteralNode(node)) {
    const fields: FieldModel[] = [];
    for (const member of node.members) {
      if (!ts.isPropertySignature(member) || !ts.isIdentifier(member.name) || member.type === undefined) {
        return { kind: "other", text: self };
      }
      fields.push({
        name: member.name.text,
        type: recurse(member.type),
        readonly: member.modifiers?.some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword) === true,
      });
    }
    return { kind: "object", text: self, fields };
  }
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
    const name = node.typeName.text;
    const args = node.typeArguments ?? [];
    if (name === "Promise" && args.length === 1) return { kind: "promise", text: self, value: recurse(args[0]!) };
    if (name === "Result" && args.length === 1 && imported.has("Result")) {
      return { kind: "result", text: self, value: recurse(args[0]!) };
    }
    if (args.length === 0 && imported.has(name) && name !== "Result") return { kind: "concept", text: self, name };
    if (args.length === 0 && local.has(name)) return { kind: "local", text: self, name };
  }
  return { kind: "other", text: self };
}

function readReturn(
  returns: TypeRef,
  imported: ReadonlySet<string>,
  inPortName: string,
  refuse: (problem: string) => never,
): ReturnModel {
  const shape = `${inPortName}.execute returns Promise<R> or Promise<Result<R>>, where R is void, a domain concept or an array of one`;
  if (returns.kind !== "promise") return refuse(shape);
  let value = returns.value;
  const result = value.kind === "result";
  if (value.kind === "result") value = value.value;
  if (value.kind === "void") return { text: returns.text, result, shape: "void" };
  if (value.kind === "concept" && imported.has(value.name)) {
    return { text: returns.text, result, shape: "value", concept: value.name };
  }
  if (value.kind === "array" && value.element.kind === "concept") {
    return { text: returns.text, result, shape: "array", concept: value.element.name };
  }
  return refuse(shape);
}
