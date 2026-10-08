// What the Drizzle emitters need from a context's feature contracts: each
// feature's store out port (TN-26-012 §3, §5), its methods as written, and
// where the types those methods name come from.
//
// Two sources produce the same model. `readStoreFeatures` reads the contract
// files itself, strictly, and is what the pack runs today.
// `storeFeatureFromModel` derives it from ts-hexagonal's parsed
// `FeatureContractModel`, so switching the emitters onto the shared parser
// is a one-line change in pack.ts once that parser lands.
import { Node, Project, SyntaxKind, type TypeNode } from "ts-morph";
import type { WorkspaceFacts } from "../../ts/pack.ts";
import type { FeatureContractModel, TypeRef } from "../../ts/scripts/feature-model.ts";
import { pascalCase } from "../../ts/scripts/naming.ts";

export interface StoreParameter {
  readonly name: string;
  /** Source text, whitespace-normalised. */
  readonly type: string;
}

export interface StoreMethod {
  readonly name: string;
  readonly parameters: readonly StoreParameter[];
  /** Source text of the return type, `Promise<…>`. */
  readonly returns: string;
}

/** One feature's store out port, as the store skeleton prints it. */
export interface StoreFeature {
  readonly context: string;
  readonly area: string;
  readonly feature: string;
  readonly contractPath: string;
  /** `<InPort>Store`, e.g. `CreateNoteStore`. */
  readonly port: string;
  /** In declaration order. */
  readonly methods: readonly StoreMethod[];
  /** Names the methods use from `<package>/domain`, sorted. */
  readonly domainTypes: readonly string[];
  /** Other names the methods use from the feature's own contract (exported
   *  by `<package>/application`), sorted; the port itself is not listed. */
  readonly applicationTypes: readonly string[];
}

/** Type names every TypeScript program has; a store may use them unimported. */
const GLOBAL_TYPES = new Set([
  "Array", "Date", "Map", "Omit", "Partial", "Pick", "Promise", "Readonly", "ReadonlyArray", "ReadonlyMap",
  "ReadonlySet", "Record", "Required", "Set",
]);

const FEATURE_CONTRACT = /^application\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/([a-z0-9-]+)\.contract\.ts$/;

const normalise = (text: string): string => text.replace(/\s+/g, " ").replace(/<\s+/g, "<").replace(/\s+>/g, ">").trim();

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The store out ports declared by a context workspace's feature contracts,
 * sorted by area, then feature. Features without a store are skipped. Throws,
 * naming the contract and the fix, on anything the skeleton could not print
 * faithfully.
 */
export function readStoreFeatures(workspace: WorkspaceFacts): StoreFeature[] {
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
  const domainModule = `${workspace.packageName}/domain`;
  const out: StoreFeature[] = [];
  for (const contract of workspace.contracts) {
    if (!contract.path.startsWith(`${workspace.sourceRoot}/`)) continue;
    const match = FEATURE_CONTRACT.exec(contract.path.slice(workspace.sourceRoot.length + 1));
    if (!match) continue;
    const [, area, feature, stem] = match as unknown as [string, string, string, string];
    const where = contract.path;
    if (stem !== feature) throw new Error(`${where}: a feature contract is named after its folder, ${feature}.contract.ts`);
    const port = `${pascalCase(feature)}Store`;
    const file = project.createSourceFile(`/${where}`, contract.source, { overwrite: true });
    const stores = file.getInterfaces().filter((i) => i.getName().endsWith("Store"));
    const wrong = stores.find((i) => i.getName() !== port);
    if (wrong !== undefined) {
      throw new Error(`${where}: out port '${wrong.getName()}' ends in Store but is not this feature's store; ` +
        `the one store port is named exactly '${port}', and other out ports must not end in Store`);
    }
    const store = stores[0];
    if (store === undefined) continue;
    if (stores.length > 1) throw new Error(`${where}: '${port}' is declared twice`);
    if (store.getTypeParameters().length > 0 || store.getExtends().length > 0) {
      throw new Error(`${where}: '${port}' must be a plain interface with no type parameters or extends clause`);
    }

    const domainNames = new Set<string>();
    for (const declaration of file.getImportDeclarations()) {
      if (declaration.getModuleSpecifierValue() !== domainModule) continue;
      for (const named of declaration.getNamedImports()) {
        if (named.getAliasNode() !== undefined) throw new Error(`${where}: import '${named.getName()}' without an alias`);
        domainNames.add(named.getName());
      }
    }
    const localNames = new Set([
      ...file.getInterfaces().map((i) => i.getName()),
      ...file.getTypeAliases().map((t) => t.getName()),
    ]);

    const domainTypes = new Set<string>();
    const applicationTypes = new Set<string>();
    const methods: StoreMethod[] = [];
    const use = (node: TypeNode, member: string): void => {
      const references = [node, ...node.getDescendants()].filter(Node.isTypeReference);
      for (const reference of references) {
        const nameNode = reference.getTypeName();
        if (!Node.isIdentifier(nameNode)) {
          throw new Error(`${where}: ${port}.${member} uses the qualified type '${nameNode.getText()}'; import the type by name`);
        }
        const name = nameNode.getText();
        if (domainNames.has(name)) domainTypes.add(name);
        else if (localNames.has(name)) { if (name !== port) applicationTypes.add(name); }
        else if (!GLOBAL_TYPES.has(name)) {
          throw new Error(`${where}: ${port}.${member} uses '${name}', which is neither imported from ${domainModule} ` +
            "nor declared in the contract");
        }
      }
      if (node.getDescendantsOfKind(SyntaxKind.TypeQuery).length > 0 || node.getDescendantsOfKind(SyntaxKind.ImportType).length > 0) {
        throw new Error(`${where}: ${port}.${member} must name its types, not derive them with typeof or import()`);
      }
    };
    const seen = new Set<string>();
    for (const member of store.getMembers()) {
      if (!Node.isMethodSignature(member)) {
        throw new Error(`${where}: '${port}' may declare only methods; '${normalise(member.getText())}' is not one`);
      }
      const name = member.getName();
      if (!/^[a-z][A-Za-z0-9]*$/.test(name)) throw new Error(`${where}: ${port} method '${name}' must be a camelCase name`);
      if (seen.has(name)) throw new Error(`${where}: ${port}.${name} is overloaded; a store method has one signature`);
      seen.add(name);
      if (member.getTypeParameters().length > 0 || member.hasQuestionToken()) {
        throw new Error(`${where}: ${port}.${name} must be a required method with no type parameters`);
      }
      const parameters: StoreParameter[] = member.getParameters().map((parameter) => {
        const typeNode = parameter.getTypeNode();
        if (typeNode === undefined || parameter.isOptional() || parameter.isRestParameter() ||
            !Node.isIdentifier(parameter.getNameNode())) {
          throw new Error(`${where}: ${port}.${name} parameter '${parameter.getText()}' must be a named, typed, required parameter`);
        }
        use(typeNode, name);
        return { name: parameter.getName(), type: normalise(typeNode.getText()) };
      });
      const returnNode = member.getReturnTypeNode();
      if (returnNode === undefined || !Node.isTypeReference(returnNode) || returnNode.getTypeName().getText() !== "Promise") {
        throw new Error(`${where}: ${port}.${name} must return a Promise`);
      }
      use(returnNode, name);
      methods.push({ name, parameters, returns: normalise(returnNode.getText()) });
    }
    if (methods.length === 0) throw new Error(`${where}: '${port}' declares no methods`);
    out.push({
      context: workspace.name, area, feature, contractPath: where, port, methods,
      domainTypes: [...domainTypes].sort(byName),
      applicationTypes: [...applicationTypes].sort(byName),
    });
  }
  return out.sort((a, b) => byName(a.area, b.area) || byName(a.feature, b.feature));
}

/** The same model from ts-hexagonal's parsed feature, or undefined when the
 *  feature has no store. Throws on a type the model could not resolve. */
export function storeFeatureFromModel(model: FeatureContractModel): StoreFeature | undefined {
  const store = model.outPorts.find((port) => port.isStore);
  if (store === undefined) return undefined;
  const domainTypes = new Set<string>();
  const applicationTypes = new Set<string>();
  const collect = (ref: TypeRef, member: string): void => {
    switch (ref.kind) {
      case "primitive": case "void": return;
      case "concept": domainTypes.add(ref.name); return;
      case "local": if (ref.name !== store.name) applicationTypes.add(ref.name); return;
      case "array": collect(ref.element, member); return;
      case "promise": collect(ref.value, member); return;
      case "result": domainTypes.add("Result"); collect(ref.value, member); return;
      case "object": for (const field of ref.fields) collect(field.type, member); return;
      case "other":
        throw new Error(`${model.contractPath}: ${store.name}.${member} uses '${ref.text}', which the store skeleton cannot import`);
    }
  };
  const methods = store.methods.map((method) => {
    for (const parameter of method.parameters) collect(parameter.type, method.name);
    if (method.returns.kind !== "promise") throw new Error(`${model.contractPath}: ${store.name}.${method.name} must return a Promise`);
    collect(method.returns, method.name);
    return {
      name: method.name,
      parameters: method.parameters.map((p) => ({ name: p.name, type: normalise(p.type.text) })),
      returns: normalise(method.returns.text),
    };
  });
  return {
    context: model.context, area: model.area, feature: model.feature, contractPath: model.contractPath,
    port: store.name, methods,
    domainTypes: [...domainTypes].sort(byName),
    applicationTypes: [...applicationTypes].sort(byName),
  };
}
