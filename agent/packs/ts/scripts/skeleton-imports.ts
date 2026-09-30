// Shared skeleton-import predicate (r16): a src/** non-contract file that still
// imports from the red-phase shared errors module — the NotImplementedError a
// scaffolded skeleton throws — means an unimplemented export survived to this
// stage of the run.
//
// WHY IT MOVED UPSTREAM. r16's billing.ts stayed a throwing skeleton and
// green-gate passed 179/179 TWICE: its exports were imported by no test, so
// nothing ever executed the throw, and a suite that never runs a line cannot
// go red on it. Only `deliver` caught it — minutes later and at the very end —
// via exactly this scan. The predicate is not delivery's to own: an
// unimplemented export is not GREEN, whatever the suite says, so the same scan
// belongs in green-gate the moment the suite and typecheck come back clean.
//
// ONE PREDICATE, TWO CALLERS. green-gate blocks on it (route → builder) and
// deliver keeps its own call to the same function — defence in depth, and the
// two can never drift into two definitions of "an unimplemented export
// reached this stage".
//
// AST, NOT GREP. A mention of NotImplementedError in a comment or a string must
// not count; only a real import declaration does. Reuses the same ts-morph
// reading deliver already trusted.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, posix, relative, sep } from "node:path";
import { Node, Project } from "ts-morph";
import { expandSourceRoots } from "./surface-check.ts";

/** The red-phase shared errors module, project-relative. Scaffolded skeletons
 *  import NotImplementedError (and the `notImplemented` helper) from here. */
export const ERRORS_REL = "src/shared/errors.ts";

/** A src file that still imports from the red-phase errors module, and the
 *  names it imports (`NotImplementedError`, `notImplemented`, …). */
export interface SkeletonImporter {
  /** Project-relative posix path. */
  readonly file: string;
  /** The names imported from the shared errors module. */
  readonly names: readonly string[];
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/** All .ts and .tsx files under dir, project-relative posix paths, sorted.
 *
 *  `.tsx` counts because a component skeleton is a `.tsx` file (TN-26-006 A1)
 *  and r16's defect does not care which extension it wears: an unimplemented
 *  export whose throw no test ever executes is invisible to the suite, and this
 *  scan is the only thing that sees it. An extension the walk skips is a whole
 *  layer of a frontend that green-gate and delivery would wave through. */
export function tsFilesUnder(root: string, dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    if (!existsSync(d)) return;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!["node_modules", ".git", ".bounded"].includes(entry.name)) walk(join(d, entry.name));
      } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
        out.push(toPosix(relative(root, join(d, entry.name))));
      }
    }
  };
  walk(dir);
  return out.sort();
}

/** Does this module specifier, written in `fromRel`, resolve to the shared
 *  errors module? (Relative specifiers only — that is how it is ever imported.)
 *  `errorsModules` are the project-relative errors modules in play; the
 *  default is the flat layout's one. */
export function refersToErrors(fromRel: string, specifier: string, errorsModules: readonly string[] = [ERRORS_REL]): boolean {
  if (!specifier.startsWith(".")) return false;
  const resolved = posix.normalize(posix.join(posix.dirname(fromRel), specifier));
  const noExt = resolved.replace(/\.(js|ts)$/, "");
  return errorsModules.some((m) => noExt === m.replace(/\.ts$/, ""));
}

/**
 * The red-phase errors modules of a monorepo's source roots (ADR 2026-056):
 * each root's `shared/errors.ts` (the flat layout) and its
 * `domain/shared/errors.ts` (TN-26-012, where domain skeletons import
 * NotImplementedError from). Project-relative; whether they exist is not
 * asked — an import of a deleted one is still a skeleton import.
 */
export function errorsModulesFor(cwd: string, sourceRoots: readonly string[]): string[] {
  return expandSourceRoots(cwd, sourceRoots).flatMap((dir) => [`${dir}/shared/errors.ts`, `${dir}/domain/shared/errors.ts`]);
}

/** Names a file imports from the shared errors module ([] if none). AST, not
 *  grep: a mention in a comment or string must not count. */
export function errorsImportsOf(source: string, fileRel: string, errorsModules: readonly string[] = [ERRORS_REL]): string[] {
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
  const sf = project.createSourceFile(basename(fileRel), source, { overwrite: true });
  const names: string[] = [];
  for (const stmt of sf.getStatements()) {
    if (Node.isImportDeclaration(stmt) && refersToErrors(fileRel, stmt.getModuleSpecifierValue(), errorsModules)) {
      const clause = stmt.getImportClause();
      const bindings = clause?.getNamedBindings();
      if (bindings && Node.isNamedImports(bindings)) names.push(...bindings.getElements().map((e) => e.getName()));
      else if (bindings) names.push("* as " + bindings.getName());
      else names.push(clause?.getDefaultImport()?.getText() ?? "(side effect)");
    } else if (Node.isExportDeclaration(stmt)) {
      const spec = stmt.getModuleSpecifierValue();
      if (spec !== undefined && refersToErrors(fileRel, spec, errorsModules)) names.push("(re-export)");
    }
  }
  return names;
}

/**
 * Every src/** non-contract file that still imports from the red-phase shared
 * errors module — one entry per offending file, with the names it imports.
 *
 * Contracts are excluded because they are declaration-only (contract-purity
 * enforces it) and cannot import a value in the first place; the errors module
 * itself is excluded because it is the definition, not a consumer. Empty means
 * clean: no unimplemented skeleton reached this stage.
 */
export function findSkeletonImportsInSrc(cwd: string): SkeletonImporter[] {
  const out: SkeletonImporter[] = [];
  for (const rel of tsFilesUnder(cwd, join(cwd, "src"))) {
    if (rel === ERRORS_REL || rel.endsWith(".contract.ts")) continue;
    const names = errorsImportsOf(readFileSync(join(cwd, rel), "utf8"), rel);
    if (names.length > 0) out.push({ file: rel, names });
  }
  return out;
}

/**
 * The same scan over a monorepo's source roots (ADR 2026-056): every
 * non-contract file under them that still imports a red-phase errors module
 * (`errorsModulesFor`) — an unimplemented skeleton that reached this stage.
 * The errors modules themselves are excluded; they are the definition.
 */
export function findSkeletonImports(cwd: string, sourceRoots: readonly string[]): SkeletonImporter[] {
  const errorsModules = errorsModulesFor(cwd, sourceRoots);
  const out: SkeletonImporter[] = [];
  for (const dir of expandSourceRoots(cwd, sourceRoots)) {
    for (const rel of tsFilesUnder(cwd, join(cwd, dir))) {
      if (errorsModules.includes(rel) || rel.endsWith(".contract.ts")) continue;
      const names = errorsImportsOf(readFileSync(join(cwd, rel), "utf8"), rel, errorsModules);
      if (names.length > 0) out.push({ file: rel, names });
    }
  }
  return out;
}
