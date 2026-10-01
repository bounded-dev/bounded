// Every emitter a composed project runs (ADR 2026-060), and the facts they
// run over, read from the project on disk.
//
// The ts pack's own domain emitter comes first, then every composed pack's
// `skeletonEmitters` contribution in composition order. A pack does not
// contribute to a socket it defines, so the domain emitter is prepended here
// rather than read from the socket. Every consumer that writes or checks
// emitted files (the design gate's scaffold step, the red gate's shadow and
// delivery's generated-file check) takes them from `emitProject`, so none can
// run the contributed emitters without the domain, and none can skip the
// checks on what an emitter produced. The manifest generator reads only entry
// files, which the domain emitter never marks, so it keeps reading the socket
// alone and a design still missing @accepts examples does not stop it.
//
// `projectFactsOf` is the gates' reading of a project: the composition, the
// project name (the scope), the workspaces the design derives (contexts from
// contract paths, apps from the TNs, ADR 2026-061) and each workspace's
// contract sources. It is the same derivation the manifest generator uses
// (project-package.ts), so the files a gate emits and the manifests it checks
// never disagree about which workspaces exist.

import { join } from "node:path";
import { pathGlobMatcher } from "../../../src/pack-contrib.ts";
import { readProjectPacks } from "../../../src/project-composition.ts";
import { composePacks } from "../../../src/socket-registry.ts";
import { INSTALLED_PACKS } from "../../installed.ts";
import { type EmitPhase, type Emitter, type EmittedFile, emittedFileProblem, type ProjectFacts, skeletonEmitters } from "../pack.ts";
import { domainEmitter } from "./domain-emitter.ts";
import { harnessRootOf } from "./project-config.ts";
import { contractFiles, layoutFor, projectWorkspaces, readProjectName, scopeOf } from "./project-package.ts";
import { readFileSync } from "node:fs";

export function projectEmitters(packs: readonly string[]): readonly Emitter[] {
  return [domainEmitter, ...composePacks(INSTALLED_PACKS, packs).read(skeletonEmitters)];
}

/** The harness packs directory the gates read pack data from. */
export function defaultPacksDir(): string {
  return join(harnessRootOf(), "packs");
}

/**
 * The facts of the project at `cwd` for `phase`. Throws, naming the file and
 * the fix, when the design cannot be read as workspaces (a contract outside
 * every workspace, an app kind no pack templates, an unreadable composition).
 */
export function projectFactsOf(cwd: string, phase: EmitPhase, packsDir = defaultPacksDir()): ProjectFacts {
  const packs = readProjectPacks(cwd);
  const layout = layoutFor(packs, packsDir);
  const scope = scopeOf(readProjectName(cwd));
  const workspaces = projectWorkspaces(cwd, layout, scope).map((w) => ({
    ...w,
    contracts: contractFiles(cwd, w.sourceRoot, layout.contractSuffixes)
      .map((path) => ({ path, source: readFileSync(join(cwd, path), "utf8") })),
  }));
  return {
    scope,
    phase,
    packs,
    workspaces,
    adapterTechnologies: [...layout.technologies].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    workspaceTemplates: [...layout.templates].sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0)),
  };
}

/** One emitted file and the emitter that produced it. */
export interface ProjectFile extends EmittedFile {
  readonly emitter: string;
}

/** Thrown when an emitter refuses the design or produces an unusable file.
 *  The message names the emitter and, where it can, the contract and the fix. */
export class EmitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmitError";
  }
}

/**
 * Every file the composed emitters produce for `facts`, sorted by path, each
 * checked before any consumer writes one: a safe path, a known mode, a final
 * newline (`emittedFileProblem`), no two emitters at one path, and every
 * `generated` file inside a composed `generatedFileGlobs` entry — a generated
 * file no glob protects would be writable by a role and then silently
 * overwritten (ADR 2026-058).
 */
export function emitProject(facts: ProjectFacts, generatedGlobs: readonly string[]): ProjectFile[] {
  const isGenerated = pathGlobMatcher(generatedGlobs);
  const byPath = new Map<string, ProjectFile>();
  for (const emitter of projectEmitters(facts.packs)) {
    let files: readonly EmittedFile[];
    try {
      files = emitter.emit(facts);
    } catch (error) {
      throw new EmitError(`emitter '${emitter.name}': ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const file of files) {
      const problem = emittedFileProblem(file, emitter.name);
      if (problem !== undefined) throw new EmitError(problem);
      const clash = byPath.get(file.path.toLowerCase());
      if (clash !== undefined) {
        throw new EmitError(`emitters '${clash.emitter}' and '${emitter.name}' both produce ${file.path}`);
      }
      if (file.mode === "generated" && !isGenerated(file.path)) {
        throw new EmitError(`emitter '${emitter.name}' produced ${file.path} as generated, but no composed generatedFileGlobs entry covers it`);
      }
      byPath.set(file.path.toLowerCase(), { ...file, emitter: emitter.name });
    }
  }
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
