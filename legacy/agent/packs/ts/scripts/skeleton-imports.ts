// Shared skeleton-import predicate (r16): a non-contract file under a source root that still
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

/** A source file that still imports from a red-phase errors module, and the
 *  names it imports (`NotImplementedError`, …). */
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

/** Does this module specifier, written in `fromRel`, resolve to one of the
 *  project-relative `errorsModules`? (Relative specifiers only — that is how
 *  one is ever imported.) */
export function refersToErrors(fromRel: string, specifier: string, errorsModules: readonly string[]): boolean {
  if (!specifier.startsWith(".")) return false;
  const resolved = posix.normalize(posix.join(posix.dirname(fromRel), specifier));
  const noExt = resolved.replace(/\.(js|ts)$/, "");
  return errorsModules.some((m) => noExt === m.replace(/\.ts$/, ""));
}

/**
 * The red-phase errors modules of a monorepo's source roots (ADR LEG-2026-056):
 * each root's `domain/shared/errors.ts` (TN-26-012 §5, where skeletons import
 * NotImplementedError from). Project-relative; whether they exist is not
 * asked — an import of a deleted one is still a skeleton import.
 */
export function errorsModulesFor(cwd: string, sourceRoots: readonly string[]): string[] {
  return expandSourceRoots(cwd, sourceRoots).map((dir) => `${dir}/domain/shared/errors.ts`);
}

/** Names a file imports from one of the errors modules ([] if none). AST, not
 *  grep: a mention in a comment or string must not count. */
export function errorsImportsOf(source: string, fileRel: string, errorsModules: readonly string[]): string[] {
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
 * The scan over a monorepo's source roots (ADR LEG-2026-056): every
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
