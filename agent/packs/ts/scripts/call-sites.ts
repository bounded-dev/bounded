// What a set of test sources calls, by AST walk: the evidence the test
// obligations read (test-obligations.ts). No pack registry is imported here,
// so a pack's own obligations can use it without an import cycle.

import { Node, Project } from "ts-morph";
import type { ObligationSource } from "../pack.ts";

/** What a set of test sources calls. */
export interface CallSites {
  /** `Name.member` for every call `Name.member(…)` on an identifier. */
  readonly qualified: ReadonlySet<string>;
  /** `member` for every call `<anything>.member(…)`. */
  readonly methods: ReadonlySet<string>;
  /** `Name` for every `new Name(…)`. */
  readonly constructed: ReadonlySet<string>;
  /** Module specifiers imported (`./create-note.store.test-support.ts`). */
  readonly imports: ReadonlySet<string>;
}

/** The call sites of the given sources, by AST walk. */
export function callSites(sources: readonly ObligationSource[]): CallSites {
  const qualified = new Set<string>();
  const methods = new Set<string>();
  const constructed = new Set<string>();
  const imports = new Set<string>();
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
  for (const { path, source } of sources) {
    const sf = project.createSourceFile(`/sites/${path.replace(/[^\w.-]+/g, "_")}${path.endsWith(".tsx") ? "" : ".ts"}`, source, { overwrite: true });
    for (const declaration of sf.getImportDeclarations()) imports.add(declaration.getModuleSpecifierValue());
    sf.forEachDescendant((node) => {
      if (Node.isNewExpression(node)) {
        const callee = node.getExpression();
        if (Node.isIdentifier(callee)) constructed.add(callee.getText());
      } else if (Node.isCallExpression(node)) {
        const callee = node.getExpression();
        if (Node.isPropertyAccessExpression(callee)) {
          methods.add(callee.getName());
          const base = callee.getExpression();
          if (Node.isIdentifier(base)) qualified.add(`${base.getText()}.${callee.getName()}`);
        }
      }
    });
  }
  return { qualified, methods, constructed, imports };
}

/** The sources whose path is one of `paths`. */
export function sourcesAt(sources: readonly ObligationSource[], paths: Iterable<string>): ObligationSource[] {
  const wanted = new Set(paths);
  return sources.filter((s) => wanted.has(s.path));
}

