// Every context workspace of a design, read once: its domain concepts and its
// parsed features, both in the order the emitters print them. Emitters call
// `contextModels(facts)`; a WeakMap keeps the parse to once per facts object
// without giving up purity (the same facts always yield the same models).

import type { ProjectFacts, WorkspaceFacts } from "../../ts/pack.ts";
import type { FeatureContractModel } from "../../ts/scripts/feature-model.ts";
import { type ConceptEntry, readDomainConcept } from "./domain-index.ts";
import { ContractShapeError, parseFeatureContract } from "./feature-contract.ts";
import { readSharedContract, type SharedContract } from "./shared-contract.ts";

export interface ContextModel {
  readonly workspace: WorkspaceFacts;
  /** `contexts/<context>/src` */
  readonly root: string;
  readonly context: string;
  /** `<scope>/<context>`, e.g. `@example/project-management`. */
  readonly packageName: string;
  /** Sorted by area, then name. */
  readonly concepts: readonly ConceptEntry[];
  /** Sorted by area, then feature. */
  readonly features: readonly FeatureContractModel[];
  /** Port-level interfaces in application/shared/, sorted by path. */
  readonly shared: readonly SharedContract[];
  /** Every name the shared contracts export. */
  readonly sharedNames: ReadonlySet<string>;
}

const cache = new WeakMap<ProjectFacts, readonly ContextModel[]>();

const byAreaThen = <T>(key: (item: T) => [string, string]) => (a: T, b: T): number => {
  const [a1, a2] = key(a);
  const [b1, b2] = key(b);
  return a1 < b1 ? -1 : a1 > b1 ? 1 : a2 < b2 ? -1 : a2 > b2 ? 1 : 0;
};

/** The context workspaces of `facts`, sorted by directory. */
export function contextModels(facts: ProjectFacts): readonly ContextModel[] {
  const cached = cache.get(facts);
  if (cached !== undefined) return cached;
  const models = facts.workspaces
    .filter((w) => w.kind === "context")
    .map((workspace) => contextModel(workspace, facts))
    .sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
  cache.set(facts, models);
  return models;
}

function contextModel(workspace: WorkspaceFacts, facts: ProjectFacts): ContextModel {
  const root = workspace.sourceRoot;
  const context = workspace.name;
  if (root !== `contexts/${context}/src` || workspace.dir !== `contexts/${context}`) {
    throw new Error(`context workspace '${workspace.dir}' must sit at contexts/<context> with its source root at src (TN-26-012 §1)`);
  }
  const domain: { path: string; source: string }[] = [];
  const application: { path: string; source: string }[] = [];
  const sharedSources: { path: string; source: string }[] = [];
  for (const contract of workspace.contracts) {
    if (contract.path.startsWith(`${root}/domain/`)) domain.push(contract);
    else if (contract.path.startsWith(`${root}/application/shared/`)) sharedSources.push(contract);
    else if (contract.path.startsWith(`${root}/application/`)) application.push(contract);
    else {
      throw new ContractShapeError(contract.path, "contracts live in a context's domain/<area>/, application/<area>/<feature>/ or application/shared/ folders only");
    }
  }
  const concepts = domain.map((c) => readDomainConcept(c.path, c.source)).sort(byAreaThen((c) => [c.area, c.name]));
  const names = concepts.map((c) => c.name);
  const twice = names.find((n, i) => names.indexOf(n) !== i);
  if (twice !== undefined) throw new Error(`context '${context}' declares the domain concept ${twice} twice`);
  const kinds = new Map(concepts.map((c) => [c.name, c.kind] as const));
  const features = application
    .map((c) => parseFeatureContract(c.path, c.source, {
      scope: facts.scope,
      concepts: kinds,
      adapterTechnologies: facts.adapterTechnologies,
    }))
    .sort(byAreaThen((f) => [f.area, f.feature]));
  const shared = sharedSources.map((c) => readSharedContract(c.path, c.source, facts.scope))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  const ports = new Map<string, string>();
  for (const contract of shared) {
    for (const name of contract.names) {
      const other = ports.get(name) ?? (kinds.has(name) ? "the domain" : undefined);
      if (other !== undefined) throw new ContractShapeError(contract.path, `${name} is also declared by ${other}`);
      ports.set(name, contract.path);
    }
  }
  for (const feature of features) {
    for (const name of [feature.inPort.name, ...feature.outPorts.map((p) => p.name)]) {
      const other = ports.get(name);
      if (other !== undefined) {
        throw new ContractShapeError(feature.contractPath, `${name} is also declared by ${other}; port names are unique in a context's application barrel`);
      }
      ports.set(name, feature.contractPath);
    }
  }
  const sharedNames = new Set(shared.flatMap((c) => c.names));
  return { workspace, root, context, packageName: workspace.packageName, concepts, features, shared, sharedNames };
}

/** Area, then feature: the order of every per-feature list (TN-26-012 §6). */
export const featureOrder = byAreaThen<FeatureContractModel>((f) => [f.area, f.feature]);
