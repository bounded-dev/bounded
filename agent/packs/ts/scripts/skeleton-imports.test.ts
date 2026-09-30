import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { errorsImportsOf, errorsModulesFor, findSkeletonImports, findSkeletonImportsInSrc } from "./skeleton-imports.ts";
import { parseDomainConcept } from "./domain-concept.ts";
import { implementationSkeleton, NOT_IMPLEMENTED_MODULE_SOURCE } from "./domain-emitter.ts";
import { exampleConcept } from "./testdata/example-domain.ts";

// The shared predicate behind two callers (r16): green-gate blocks on it and
// deliver keeps its own call to it. A src/** non-contract file still importing
// from the red-phase errors module means an unimplemented export survived.

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

describe("findSkeletonImportsInSrc", () => {
  test("names a src file that imports NotImplementedError, with the names", () => {
    const dir = proj({
      "src/billing/billing.ts": [
        'import { NotImplementedError } from "../shared/errors.js";',
        "export function charge(): never { throw new NotImplementedError('charge'); }",
      ].join("\n"),
    });
    expect(findSkeletonImportsInSrc(dir)).toEqual([
      { file: "src/billing/billing.ts", names: ["NotImplementedError"] },
    ]);
  });

  test("an implemented tree (no errors-module import) is clean", () => {
    const dir = proj({ "src/billing/billing.ts": "export const rate = 5;\n" });
    expect(findSkeletonImportsInSrc(dir)).toEqual([]);
  });

  test("the errors module itself is not counted — it is the definition, not a consumer", () => {
    const dir = proj({ "src/shared/errors.ts": "export class NotImplementedError extends Error {}\n" });
    expect(findSkeletonImportsInSrc(dir)).toEqual([]);
  });

  test("a contract file is not counted — it is declaration-only and cannot import a value", () => {
    const dir = proj({
      // Nonsensical in practice (purity would refuse it), but the predicate must
      // never key on a *.contract.ts regardless.
      "src/billing/billing.contract.ts": 'import { NotImplementedError } from "../shared/errors.js";\n',
    });
    expect(findSkeletonImportsInSrc(dir)).toEqual([]);
  });

  test("a tests/** importer is not scanned — the predicate is about src/ only", () => {
    const dir = proj({
      "tests/billing.test.ts": 'import { NotImplementedError } from "../src/shared/errors.js";\nvoid NotImplementedError;\n',
    });
    expect(findSkeletonImportsInSrc(dir)).toEqual([]);
  });
});

describe("errorsImportsOf (AST, not grep)", () => {
  test("a mention in a comment or string does not count", () => {
    const src = [
      "// NotImplementedError is thrown by skeletons",
      'const s = "NotImplementedError";',
      "export const x = 1;",
    ].join("\n");
    expect(errorsImportsOf(src, "src/x.ts")).toEqual([]);
  });

  test("a real import from the shared errors module counts", () => {
    const src = 'import { NotImplementedError, notImplemented } from "./shared/errors.js";\n';
    expect(errorsImportsOf(src, "src/x.ts")).toEqual(["NotImplementedError", "notImplemented"]);
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
      "apps/web/src/shared/errors.ts": "export class NotImplementedError extends Error {}\n",
      "apps/web/src/server/main.ts": 'import { NotImplementedError } from "../shared/errors.ts";\nthrow new NotImplementedError();\n',
    });
    expect(findSkeletonImports(dir, ROOTS).map((i) => i.file)).toEqual(["apps/web/src/server/main.ts"]);
  });

  test("the errors modules are each root's shared/ and domain/shared/", () => {
    const dir = proj({ "contexts/a/src/x.ts": "", "contexts/b/src/x.ts": "" });
    expect(errorsModulesFor(dir, ["contexts/*/src"])).toEqual([
      "contexts/a/src/shared/errors.ts",
      "contexts/a/src/domain/shared/errors.ts",
      "contexts/b/src/shared/errors.ts",
      "contexts/b/src/domain/shared/errors.ts",
    ]);
  });
});
