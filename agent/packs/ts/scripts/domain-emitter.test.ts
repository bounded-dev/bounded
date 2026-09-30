import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { ts } from "ts-morph";
import { emittedFileProblem, type ProjectFacts, type WorkspaceFacts } from "../pack.ts";
import { DomainConceptError, parseDomainConcept } from "./domain-concept.ts";
import { conceptTail, domainEmitter, emitDomain, implementationSkeleton, NOT_IMPLEMENTED_MODULE_SOURCE } from "./domain-emitter.ts";
import {
  DOCUMENTED_CONCEPTS as EXAMPLE_CONCEPTS,
  documentedConcept as exampleConcept,
  EXAMPLE_CONCEPTS as UNDOCUMENTED_CONCEPTS,
  EXAMPLE_RESULT,
  EXAMPLE_ROOT,
} from "./testdata/example-domain.ts";

// The domain emitter (ADR 2026-059/060): each domain concept contract → its
// `<Name>Impl` skeleton and its colocated laws. The skeleton is the worked
// example's implementation with every body replaced by a throw, and its tail
// is the example's, byte for byte.

const CONTEXT = "contexts/project-management";

function workspace(contracts: { path: string; source: string }[], extra: Partial<WorkspaceFacts> = {}): WorkspaceFacts {
  return {
    dir: CONTEXT,
    name: "project-management",
    kind: "context",
    packageName: "@example/project-management",
    sourceRoot: `${CONTEXT}/src`,
    contracts,
    ...extra,
  };
}

function facts(workspaces: WorkspaceFacts[]): ProjectFacts {
  return { scope: "@example", phase: "red", packs: ["ts"], workspaces, adapterTechnologies: [], workspaceTemplates: [] };
}

const EXAMPLE_CONTRACTS = EXAMPLE_CONCEPTS.map((c) => ({ path: c.contractPath, source: c.contract }));

function skeletonOf(stem: string): string {
  const c = exampleConcept(stem);
  return implementationSkeleton(parseDomainConcept(c.contractPath, c.contract));
}

// --- the skeleton ---------------------------------------------------------------

describe("skeletons", () => {
  test("an identifier", () => {
    expect(skeletonOf("note-id")).toBe(`import { NotImplementedError } from "../shared/errors.ts";
import type { Result } from "../shared/result.ts";
import type * as Contract from "./note-id.contract.ts";

class NoteIdImpl implements Contract.NoteId {
  declare readonly __brand: "NoteId";
  private constructor(readonly value: string) {}

  static generate(): NoteId {
    throw new NotImplementedError("NoteId.generate");
  }

  static parse(raw: unknown): Result<NoteId> {
    throw new NotImplementedError("NoteId.parse");
  }

  equals(other: NoteId): boolean {
    throw new NotImplementedError("NoteId.equals");
  }

  toJSON(): string {
    throw new NotImplementedError("NoteId.toJSON");
  }
}

export type NoteId = Contract.NoteId;
export const NoteId: Contract.NoteIdFactory = NoteIdImpl;
`);
  });

  test("an entity: a public constructor over the fields, one per line", () => {
    expect(skeletonOf("note")).toBe(`import type { ProjectId } from "../projects/project-id.contract.ts";
import { NotImplementedError } from "../shared/errors.ts";
import type * as Contract from "./note.contract.ts";
import type { NoteId } from "./note-id.contract.ts";
import type { NoteText } from "./note-text.contract.ts";

class NoteImpl implements Contract.Note {
  declare readonly __brand: "Note";
  constructor(
    readonly id: NoteId,
    readonly projectId: ProjectId,
    readonly text: NoteText,
  ) {}

  equals(other: Note): boolean {
    throw new NotImplementedError("Note.equals");
  }

  toJSON(): { readonly id: string; readonly projectId: string; readonly text: string } {
    throw new NotImplementedError("Note.toJSON");
  }
}

export type Note = Contract.Note;
export const Note: Contract.NoteFactory = NoteImpl;
`);
  });

  test("the tail helper is the example's two lines", () => {
    expect(conceptTail("ProjectName")).toBe(
      "export type ProjectName = Contract.ProjectName;\nexport const ProjectName: Contract.ProjectNameFactory = ProjectNameImpl;\n",
    );
  });

  /** The example file's shape with bodies, comments and implementation-only
   *  statements (the zod import and schema) removed: imports, class head,
   *  brand, constructor, member signatures, tail. */
  function shape(text: string): string[] {
    const sf = ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true);
    const out: string[] = [];
    for (const stmt of sf.statements) {
      if (ts.isImportDeclaration(stmt)) {
        const spec = (stmt.moduleSpecifier as ts.StringLiteral).text;
        if (spec !== "zod" && spec !== "../shared/errors.ts") out.push(stmt.getText(sf));
      } else if (ts.isClassDeclaration(stmt)) {
        out.push(text.slice(stmt.getStart(sf), stmt.members.pos).trim());
        for (const m of stmt.members) {
          const body = (m as { body?: ts.Node }).body;
          const signature = ts.isConstructorDeclaration(m) || body === undefined
            ? m.getText(sf)
            : text.slice(m.getStart(sf), body.getStart(sf)).trim();
          out.push(signature.replace(/\s+/g, " "));
        }
      } else if (ts.isTypeAliasDeclaration(stmt) || (ts.isVariableStatement(stmt) && stmt.modifiers !== undefined)) {
        out.push(stmt.getText(sf));
      }
    }
    return out;
  }

  test.each(EXAMPLE_CONCEPTS.map((c) => [c.contractPath, c] as const))(
    "%s: the skeleton is the example implementation modulo bodies, and its tail is byte-identical",
    (_path, concept) => {
      const skeleton = implementationSkeleton(parseDomainConcept(concept.contractPath, concept.contract));
      expect(shape(skeleton)).toEqual(shape(concept.implementation));
      const lastTwo = (text: string): string => text.trimEnd().split("\n").slice(-2).join("\n");
      expect(lastTwo(skeleton)).toBe(lastTwo(concept.implementation));
      expect(skeleton.endsWith(`${lastTwo(concept.implementation)}\n`)).toBe(true);
    },
  );

  test("members beyond equals/toJSON are skeletoned too, in declaration order", () => {
    const c = exampleConcept("project-name");
    const source = c.contract.replace("  toJSON(): string;\n", "  toJSON(): string;\n  initials(): ProjectName;\n");
    const skeleton = implementationSkeleton(parseDomainConcept(c.contractPath, source));
    expect(skeleton).toContain('  initials(): ProjectName {\n    throw new NotImplementedError("ProjectName.initials");\n  }\n}');
  });
});

// --- the emitter ------------------------------------------------------------------

describe("domainEmitter", () => {
  test("emits a skeleton and a laws file per concept, sorted by path", () => {
    const files = domainEmitter.emit(facts([workspace(EXAMPLE_CONTRACTS)]));
    expect(files.map((f) => [f.path, f.mode])).toEqual([
      [`${EXAMPLE_ROOT}/notes/note-id.laws.test.ts`, "generated"],
      [`${EXAMPLE_ROOT}/notes/note-id.ts`, "skeleton"],
      [`${EXAMPLE_ROOT}/notes/note-text.laws.test.ts`, "generated"],
      [`${EXAMPLE_ROOT}/notes/note-text.ts`, "skeleton"],
      [`${EXAMPLE_ROOT}/notes/note.laws.test.ts`, "generated"],
      [`${EXAMPLE_ROOT}/notes/note.ts`, "skeleton"],
      [`${EXAMPLE_ROOT}/projects/project-id.laws.test.ts`, "generated"],
      [`${EXAMPLE_ROOT}/projects/project-id.ts`, "skeleton"],
      [`${EXAMPLE_ROOT}/projects/project-name.laws.test.ts`, "generated"],
      [`${EXAMPLE_ROOT}/projects/project-name.ts`, "skeleton"],
      [`${EXAMPLE_ROOT}/projects/project.laws.test.ts`, "generated"],
      [`${EXAMPLE_ROOT}/projects/project.ts`, "skeleton"],
    ]);
    for (const file of files) expect(emittedFileProblem(file, domainEmitter.name)).toBeUndefined();
  });

  test("is pure: same facts, same bytes, whatever the contract order", () => {
    const a = domainEmitter.emit(facts([workspace(EXAMPLE_CONTRACTS)]));
    const b = domainEmitter.emit(facts([workspace([...EXAMPLE_CONTRACTS].reverse())]));
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  test("the phase does not change domain output", () => {
    const red = domainEmitter.emit(facts([workspace(EXAMPLE_CONTRACTS)]));
    const deliver = domainEmitter.emit({ ...facts([workspace(EXAMPLE_CONTRACTS)]), phase: "deliver" });
    expect(deliver).toEqual(red);
  });

  test("ignores everything that is not a domain concept contract of the workspace", () => {
    const feature = {
      path: `${CONTEXT}/src/application/notes/create-note/create-note.contract.ts`,
      source: "export interface CreateNote { execute(): Promise<void>; }\n",
    };
    const app = workspace([{ path: "apps/web/src/domain/notes/note.contract.ts", source: "garbage" }], {
      dir: "apps/web",
      name: "web",
      kind: "web",
      sourceRoot: "apps/web/src",
    });
    expect(domainEmitter.emit(facts([workspace([feature]), app]))).toEqual([]);
  });

  test("covers every context workspace", () => {
    const other = workspace(
      [{ path: "contexts/billing/src/domain/invoices/invoice-id.contract.ts", source: exampleConcept("note-id").contract.replaceAll("NoteId", "InvoiceId") }],
      { dir: "contexts/billing", name: "billing", sourceRoot: "contexts/billing/src" },
    );
    const paths = domainEmitter.emit(facts([workspace(EXAMPLE_CONTRACTS), other])).map((f) => f.path);
    expect(paths).toContain("contexts/billing/src/domain/invoices/invoice-id.ts");
    expect(paths).toHaveLength(14);
  });

  test("refuses a bad contract with its path and the fix", () => {
    const bad = { path: `${EXAMPLE_ROOT}/notes/note-text.contract.ts`, source: exampleConcept("note-text").contract.replace("Result<NoteText>", "NoteText | undefined") };
    expect(() => domainEmitter.emit(facts([workspace([bad])]))).toThrow(DomainConceptError);
    expect(() => domainEmitter.emit(facts([workspace([bad])]))).toThrow(/note-text\.contract\.ts: .*Result<NoteText>/);
  });

  test("never emits a skipped law: an undocumented value object is refused, naming its contract", () => {
    const bare = UNDOCUMENTED_CONCEPTS.map((c) => ({ path: c.contractPath, source: c.contract }));
    expect(() => domainEmitter.emit(facts([workspace(bare)]))).toThrow(/note-text\.contract\.ts: NoteText needs two @accepts examples/);
    for (const file of domainEmitter.emit(facts([workspace(EXAMPLE_CONTRACTS)]))) expect(file.content).not.toContain("test.skip");
  });

  test("refuses one concept name declared twice in a context", () => {
    const twin = { path: `${EXAMPLE_ROOT}/projects/note-id.contract.ts`, source: exampleConcept("note-id").contract };
    expect(() => emitDomain(workspace([...EXAMPLE_CONTRACTS, twin]))).toThrow(/'NoteId' is also declared by/);
  });

  test("refuses an entity holding an entity", () => {
    const note = exampleConcept("note");
    const holding = note.contract
      .replace('import type { ProjectId } from "../projects/project-id.contract.ts";', 'import type { Project } from "../projects/project.contract.ts";')
      .replaceAll("projectId: ProjectId", "projectId: Project");
    const contracts = EXAMPLE_CONTRACTS.map((c) => (c.path === note.contractPath ? { ...c, source: holding } : c));
    expect(() => emitDomain(workspace(contracts))).toThrow(/holds the entity 'Project'/);
  });

  test("the not-implemented module is TN-26-012's", () => {
    expect(NOT_IMPLEMENTED_MODULE_SOURCE).toContain("export class NotImplementedError extends Error {");
    expect(NOT_IMPLEMENTED_MODULE_SOURCE).toContain("constructor(member: string)");
    expect(NOT_IMPLEMENTED_MODULE_SOURCE.endsWith("\n")).toBe(true);
  });
});

// --- compile and run with the real toolchain ----------------------------------------
//
// The emitted files are only evidence if they compile and behave: the skeleton
// project typechecks under `bunx tsc`, its laws fail only with
// NotImplementedError (a valid red), and with the example's implementations in
// place the same laws pass (a green). Needs `bun` on PATH; skipped with the
// reason logged otherwise.

const HARNESS_MODULES = join(import.meta.dirname, "..", "..", "..", "node_modules");
const HAS_BUN = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;
if (!HAS_BUN) console.warn("domain-emitter.test: bun is not on PATH — skipping the compile-and-run checks");

const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A throwaway context holding the contracts, the generated shared modules
 *  and the emitted files, with the harness's node_modules for zod and tsc. */
function fixtureProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "domain-emitter-"));
  tmpDirs.push(dir);
  const write = (rel: string, text: string): void => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  const contracts = EXAMPLE_CONTRACTS;
  for (const c of contracts) write(c.path, c.source);
  write(`${EXAMPLE_ROOT}/shared/result.ts`, EXAMPLE_RESULT);
  write(`${EXAMPLE_ROOT}/shared/errors.ts`, NOT_IMPLEMENTED_MODULE_SOURCE);
  for (const file of domainEmitter.emit(facts([workspace(contracts)]))) write(file.path, file.content);
  // `bun:test` types without installing @types/bun: the laws use only the
  // jest-compatible subset, which vitest's types describe.
  write("bun-test.d.ts", 'declare module "bun:test" {\n  export { describe, expect, test } from "vitest";\n}\n');
  write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        lib: ["ESNext", "DOM"],
        target: "ESNext",
        module: "Preserve",
        moduleDetection: "force",
        moduleResolution: "bundler",
        allowImportingTsExtensions: true,
        verbatimModuleSyntax: true,
        noEmit: true,
        strict: true,
        skipLibCheck: true,
        noUncheckedIndexedAccess: true,
        noImplicitOverride: true,
        types: [],
      },
      include: ["contexts/*/src", "bun-test.d.ts"],
    }),
  );
  symlinkSync(HARNESS_MODULES, join(dir, "node_modules"), "dir");
  return dir;
}

function implement(dir: string): void {
  for (const c of EXAMPLE_CONCEPTS) writeFileSync(join(dir, c.contractPath.replace(".contract.ts", ".ts")), c.implementation);
}

// CI sets BOUNDED_REQUIRE_BUN=1 (.github/workflows/check.yml pins Bun), so
// there a missing bun fails instead of skipping the compile-and-run checks.
test("bun is present wherever the environment requires it", () => {
  if (process.env["BOUNDED_REQUIRE_BUN"] === "1") expect(HAS_BUN, "BOUNDED_REQUIRE_BUN=1 but bun is not on PATH").toBe(true);
});

describe.skipIf(!HAS_BUN)("the emitted domain compiles and runs", () => {
  test("the skeleton project typechecks under bunx tsc", () => {
    const dir = fixtureProject();
    const tsc = spawnSync("bunx", ["tsc", "-p", "tsconfig.json"], { cwd: dir, encoding: "utf8" });
    expect(tsc.stdout + tsc.stderr).toBe("");
    expect(tsc.status).toBe(0);
  }, 60_000);

  test("against the skeletons every law fails, and only with NotImplementedError (a valid red)", () => {
    const dir = fixtureProject();
    const run = spawnSync("bun", ["test"], { cwd: dir, encoding: "utf8" });
    const output = run.stdout + run.stderr;
    expect(run.status).not.toBe(0);
    expect(output).toMatch(/\b0 pass\b/);
    const failures = output.split("\n").filter((l) => /^\(fail\)/.test(l)).length;
    const notImplemented = output.split("\n").filter((l) => /NotImplementedError: Not implemented: /.test(l)).length;
    expect(failures).toBeGreaterThan(0);
    expect(notImplemented).toBe(failures);
  }, 60_000);

  test("with the example's implementations the laws pass and the project typechecks", () => {
    const dir = fixtureProject();
    implement(dir);
    const run = spawnSync("bun", ["test"], { cwd: dir, encoding: "utf8" });
    expect(run.stdout + run.stderr).toMatch(/\b0 fail\b/);
    expect(run.status).toBe(0);
    const tsc = spawnSync("bunx", ["tsc", "-p", "tsconfig.json"], { cwd: dir, encoding: "utf8" });
    expect(tsc.stdout + tsc.stderr).toBe("");
    expect(tsc.status).toBe(0);
  }, 60_000);

  test("the documented example emits no skipped law", () => {
    const dir = fixtureProject();
    implement(dir);
    const run = spawnSync("bun", ["test"], { cwd: dir, encoding: "utf8" });
    const output = run.stdout + run.stderr;
    expect(output).toMatch(/\b0 fail\b/);
    expect(output).not.toMatch(/\bskip\b/);
    expect(run.status).toBe(0);
  }, 60_000);

  test("a wrong implementation is caught by the laws", () => {
    const dir = fixtureProject();
    implement(dir);
    // equals by reference: a law the example gets right and a slip does not.
    const project = EXAMPLE_CONCEPTS.find((c) => c.contractPath.endsWith("/project.contract.ts"))!;
    writeFileSync(
      join(dir, project.contractPath.replace(".contract.ts", ".ts")),
      project.implementation.replace("return this.id.equals(other.id);", "return this === other;"),
    );
    const run = spawnSync("bun", ["test"], { cwd: dir, encoding: "utf8" });
    expect(run.stdout + run.stderr).toMatch(/Project — entity laws \(generated\) > equals compares by identity/);
    expect(run.status).not.toBe(0);
  }, 60_000);
});
