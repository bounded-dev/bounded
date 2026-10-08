import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { errorsImportsOf, errorsModulesFor, findSkeletonImports } from "./skeleton-imports.ts";
import { parseDomainConcept } from "./domain-concept.ts";
import { implementationSkeleton, NOT_IMPLEMENTED_MODULE_SOURCE } from "./domain-emitter.ts";
import { exampleConcept } from "./testdata/example-domain.ts";

// The shared predicate behind two callers (r16): green-gate blocks on it and
// deliver keeps its own call to it. A non-contract file under a source root
// still importing a red-phase errors module means an unimplemented export
// survived.

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function proj(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "skeleton-imports-"));
  dirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return dir;
}

describe("errorsImportsOf (AST, not grep)", () => {
  test("a mention in a comment or string does not count", () => {
    const src = [
      "// NotImplementedError is thrown by skeletons",
      'const s = "NotImplementedError";',
      "export const x = 1;",
    ].join("\n");
    expect(errorsImportsOf(src, "contexts/a/src/domain/x.ts", ["contexts/a/src/domain/shared/errors.ts"])).toEqual([]);
  });

  test("a real import from the shared errors module counts", () => {
    const src = 'import { NotImplementedError, notImplemented } from "./shared/errors.ts";\n';
    expect(errorsImportsOf(src, "contexts/a/src/domain/x.ts", ["contexts/a/src/domain/shared/errors.ts"])).toEqual(["NotImplementedError", "notImplemented"]);
  });

  test("an import of a module that is not an errors module does not count", () => {
    const src = 'import { NotImplementedError } from "./shared/errors.ts";\n';
    expect(errorsImportsOf(src, "contexts/a/src/x.ts", ["contexts/a/src/domain/shared/errors.ts"])).toEqual([]);
  });
});

// ADR 2026-056/060: in the monorepo a domain skeleton imports
// NotImplementedError from its context's `domain/shared/errors.ts`, and the
// scan walks every source root.
describe("findSkeletonImports over source roots", () => {
  const ROOTS = ["contexts/*/src", "apps/*/src"];
  const noteId = exampleConcept("note-id");
  const skeleton = implementationSkeleton(parseDomainConcept(noteId.contractPath, noteId.contract));
  const errors = "contexts/project-management/src/domain/shared/errors.ts";

  test("names a domain skeleton that still imports the errors module", () => {
    const dir = proj({
      [errors]: NOT_IMPLEMENTED_MODULE_SOURCE,
      [noteId.contractPath]: noteId.contract,
      [noteId.contractPath.replace(".contract.ts", ".ts")]: skeleton,
      "contexts/project-management/src/domain/notes/note-text.ts": exampleConcept("note-text").implementation,
    });
    expect(findSkeletonImports(dir, ROOTS)).toEqual([
      { file: noteId.contractPath.replace(".contract.ts", ".ts"), names: ["NotImplementedError"] },
    ]);
  });

  test("an implemented tree is clean, and the errors module is not its own importer", () => {
    const dir = proj({
      [errors]: NOT_IMPLEMENTED_MODULE_SOURCE,
      [noteId.contractPath.replace(".contract.ts", ".ts")]: noteId.implementation,
    });
    expect(findSkeletonImports(dir, ROOTS)).toEqual([]);
  });

  test("files under every root are scanned, apps included", () => {
    const dir = proj({
      "apps/web/src/domain/shared/errors.ts": "export class NotImplementedError extends Error {}\n",
      "apps/web/src/server/main.ts": 'import { NotImplementedError } from "../domain/shared/errors.ts";\nthrow new NotImplementedError();\n',
    });
    expect(findSkeletonImports(dir, ROOTS).map((i) => i.file)).toEqual(["apps/web/src/server/main.ts"]);
  });

  test("the errors modules are each root's domain/shared/errors.ts", () => {
    const dir = proj({ "contexts/a/src/x.ts": "", "contexts/b/src/x.ts": "" });
    expect(errorsModulesFor(dir, ["contexts/*/src"])).toEqual([
      "contexts/a/src/domain/shared/errors.ts",
      "contexts/b/src/domain/shared/errors.ts",
    ]);
  });
});
