// The workspace generator (ADR 2026-061, TN-26-012 §1, §9, §10): which
// workspaces a design has, derived rather than written.
//
//   contexts   every `contexts/<name>/src` that holds a contract file
//   apps       the merged `workspaces:` maps of the ticket TNs, each value a
//              composed template kind, each key `<template root>/<name>`
//
// `deriveWorkspaces` is pure. `readProjectFacts` is its disk entry: it walks a
// project's source roots for contracts and assembles the `ProjectFacts` every
// emitter receives.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AdapterTechnology, ContractSource, EmitPhase, ProjectFacts, WorkspaceFacts, WorkspaceTemplate } from "../../ts/pack.ts";
import { KEBAB } from "./grammar.ts";

export const CONTEXT_KIND = "context";
const SCOPE = /^@[a-z0-9][a-z0-9-]*$/;
const CONTEXT_CONTRACT = /^contexts\/([^/]+)\/src\/.+\.contract\.ts$/;

export interface WorkspaceDesign {
  /** `@` plus the project's kebab-case name. */
  readonly scope: string;
  /** Every contract file of the design, any order. */
  readonly contracts: readonly ContractSource[];
  /** Workspace directory → template kind, merged from the TNs' `workspaces:` maps. */
  readonly apps: Readonly<Record<string, string>>;
  readonly templates: readonly WorkspaceTemplate[];
}

/** The design's workspaces, sorted by directory. Throws, naming the entry
 *  and the fix, on anything TN-26-012 does not allow. */
export function deriveWorkspaces(design: WorkspaceDesign): WorkspaceFacts[] {
  if (!SCOPE.test(design.scope)) throw new Error(`scope '${design.scope}' must be '@' plus a kebab-case name`);
  const context = design.templates.find((t) => t.kind === CONTEXT_KIND);
  const byDir = new Map<string, { kind: string; contracts: ContractSource[] }>();

  for (const contract of design.contracts) {
    const match = CONTEXT_CONTRACT.exec(contract.path);
    if (match === null) {
      throw new Error(`${contract.path}: contract files live under a context's source root, contexts/<context>/src (TN-26-012 §1)`);
    }
    const name = match[1]!;
    if (!KEBAB.test(name)) throw new Error(`${contract.path}: context '${name}' is not a kebab-case name`);
    if (context === undefined) throw new Error("no composed pack templates the 'context' workspace kind");
    const dir = `${context.root}/${name}`;
    const entry = byDir.get(dir) ?? { kind: CONTEXT_KIND, contracts: [] };
    entry.contracts.push(contract);
    byDir.set(dir, entry);
  }

  for (const [dir, kind] of Object.entries(design.apps)) {
    if (kind === CONTEXT_KIND) {
      throw new Error(`workspaces: '${dir}: context' is refused; contexts come from contract paths, not TN front matter`);
    }
    const template = design.templates.find((t) => t.kind === kind);
    if (template === undefined) throw new Error(`workspaces: '${dir}' asks for kind '${kind}', which no composed pack templates`);
    const segments = dir.split("/");
    if (segments.length !== 2 || segments[0] !== template.root || !KEBAB.test(segments[1]!)) {
      throw new Error(`workspaces: '${dir}' must be '${template.root}/<kebab-case name>' for kind '${kind}'`);
    }
    if (byDir.has(dir)) throw new Error(`workspaces: '${dir}' is declared twice or collides with a context`);
    byDir.set(dir, { kind, contracts: [] });
  }

  const out: WorkspaceFacts[] = [];
  const packages = new Map<string, string>();
  for (const [dir, { kind, contracts }] of [...byDir].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const name = dir.split("/")[1]!;
    const packageName = `${design.scope}/${name}`;
    const other = packages.get(packageName);
    if (other !== undefined) throw new Error(`workspaces '${other}' and '${dir}' would both be the package ${packageName}`);
    packages.set(packageName, dir);
    out.push({
      dir, name, kind, packageName,
      sourceRoot: `${dir}/src`,
      contracts: [...contracts].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    });
  }
  return out;
}

/** Every `*.contract.ts` under `contexts/*\/src`, as project-relative sources. */
export function readContracts(project: string): ContractSource[] {
  const out: ContractSource[] = [];
  const contexts = join(project, "contexts");
  if (!existsSync(contexts)) return out;
  const walk = (dir: string, relative: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      if (entry === "node_modules") continue;
      const full = join(dir, entry);
      const path = `${relative}/${entry}`;
      if (statSync(full).isDirectory()) walk(full, path);
      else if (entry.endsWith(".contract.ts")) out.push({ path, source: readFileSync(full, "utf8") });
    }
  };
  for (const name of readdirSync(contexts).sort()) {
    const src = join(contexts, name, "src");
    if (existsSync(src) && statSync(src).isDirectory()) walk(src, `contexts/${name}/src`);
  }
  return out;
}

export interface ProjectFactsInput {
  readonly scope: string;
  readonly phase: EmitPhase;
  readonly packs: readonly string[];
  readonly apps?: Readonly<Record<string, string>>;
  readonly adapterTechnologies: readonly AdapterTechnology[];
  readonly workspaceTemplates: readonly WorkspaceTemplate[];
}

/** The facts of a project on disk. */
export function readProjectFacts(project: string, input: ProjectFactsInput): ProjectFacts {
  return {
    scope: input.scope,
    phase: input.phase,
    packs: input.packs,
    workspaces: deriveWorkspaces({
      scope: input.scope,
      contracts: readContracts(project),
      apps: input.apps ?? {},
      templates: input.workspaceTemplates,
    }),
    adapterTechnologies: [...input.adapterTechnologies].sort((a, b) => (a.id < b.id ? -1 : 1)),
    workspaceTemplates: [...input.workspaceTemplates].sort((a, b) => (a.kind < b.kind ? -1 : 1)),
  };
}
