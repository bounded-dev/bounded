import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { checkProjectSurfaces, compareSurfaces, implementationOf, manifestSourceRoots } from "./surface-check.ts";
import type { SurfaceViolation } from "./surface-check.ts";
import { parseDomainConcept } from "./domain-concept.ts";
import { implementationSkeleton } from "./domain-emitter.ts";
import { EXAMPLE_CONCEPTS, exampleConcept } from "./testdata/example-domain.ts";

// The delivered surface check (ADR LEG-2026-059, TN-26-012 §5): a concept's
// implementation exports only its tail; a feature's handler file exports only
// `<InPort>Handler implements <InPort>`, public in `execute` alone.

// --- concepts -----------------------------------------------------------------------

describe("concept contracts (ADR LEG-2026-059)", () => {
  const surfaceOf = (stem: string, impl?: string): SurfaceViolation[] => {
    const c = exampleConcept(stem);
    return compareSurfaces(c.contract, c.contractPath, impl ?? c.implementation, c.contractPath.replace(".contract.ts", ".ts"));
  };

  test.each(EXAMPLE_CONCEPTS.map((c) => [c.contractPath, c] as const))("%s: the example implementation matches", (_p, c) => {
    expect(compareSurfaces(c.contract, c.contractPath, c.implementation, c.contractPath.replace(".contract.ts", ".ts"))).toEqual([]);
  });

  test("an emitted skeleton matches too", () => {
    for (const c of EXAMPLE_CONCEPTS) {
      const skeleton = implementationSkeleton(parseDomainConcept(c.contractPath, c.contract));
      expect(compareSurfaces(c.contract, c.contractPath, skeleton, c.contractPath.replace(".contract.ts", ".ts"))).toEqual([]);
    }
  });

  test("an edited tail is a violation that prints the tail to restore", () => {
    const edited = exampleConcept("note-id").implementation.replace(
      "export const NoteId: Contract.NoteIdFactory = NoteIdImpl;",
      "export const NoteId = NoteIdImpl;",
    );
    const found = surfaceOf("note-id", edited);
    expect(found.map((v) => v.kind)).toEqual(["concept-tail"]);
    expect(found[0]!.message).toContain("export const NoteId: Contract.NoteIdFactory = NoteIdImpl;");
  });

  test("surface exported beside the tail is undeclared", () => {
    const extra = exampleConcept("note-text").implementation.replace("const schema = z.string()", "export const schema = z.string()");
    expect(surfaceOf("note-text", extra).map((v) => [v.kind, v.exportName])).toEqual([["undeclared-export", "schema"]]);
  });

  test("an exported Impl class is undeclared surface", () => {
    const leaked = exampleConcept("project").implementation.replace("class ProjectImpl", "export class ProjectImpl");
    expect(surfaceOf("project", leaked).map((v) => v.exportName)).toEqual(["ProjectImpl"]);
  });
});

// --- features ------------------------------------------------------------------------

const FEATURE_CONTRACT = `import type { Note, NoteText, Result } from "@example/notes/domain";

export interface CreateNoteInput {
  readonly text: string;
}

export interface CreateNoteCommand {
  readonly __brand: "CreateNoteCommand";
  readonly text: NoteText;
}

export interface CreateNoteCommandFactory {
  parse(raw: unknown): Result<CreateNoteCommand>;
}

export interface CreateNote {
  execute(command: CreateNoteCommand): Promise<Note>;
}

export interface CreateNoteStore {
  save(note: Note): Promise<void>;
}
`;

const HANDLER = `import { Note, NoteId } from "@example/notes/domain";
import type { CreateNote, CreateNoteCommand, CreateNoteStore } from "./create-note.contract.ts";

export class CreateNoteHandler implements CreateNote {
  constructor(private readonly store: CreateNoteStore) {}

  async execute(command: CreateNoteCommand): Promise<Note> {
    const note = new Note(NoteId.generate(), command.text);
    await this.store.save(note);
    return note;
  }
}
`;

const FEATURE_PATH = "contexts/notes/src/application/notes/create-note/create-note.contract.ts";
const HANDLER_PATH = "contexts/notes/src/application/notes/create-note/create-note.handler.ts";
const handlerSurface = (handler: string): SurfaceViolation[] => compareSurfaces(FEATURE_CONTRACT, FEATURE_PATH, handler, HANDLER_PATH);

describe("feature contracts: the handler file (TN-26-012 §5)", () => {
  test("a handler implementing the in port, public only in execute, passes", () => {
    expect(handlerSurface(HANDLER)).toEqual([]);
  });

  test("a public constructor parameter property is undeclared surface", () => {
    for (const modifier of ["readonly", "public"]) {
      const found = handlerSurface(HANDLER.replace("private readonly store", `${modifier} store`));
      expect(found.map((v) => v.kind), modifier).toEqual(["undeclared-member"]);
      expect(found[0]!.message).toContain("CreateNoteHandler.store: public member");
    }
    expect(handlerSurface(HANDLER.replace("private readonly store", "protected store"))).toEqual([]);
  });

  test("the in port decides first: a branded Command with its factory does not make the file a concept", () => {
    expect(implementationOf(FEATURE_CONTRACT, FEATURE_PATH)).toBe(HANDLER_PATH);
  });

  test("a second export from the handler file is undeclared surface", () => {
    const found = handlerSurface(`${HANDLER}\nexport function helper(): number {\n  return 1;\n}\n`);
    expect(found.map((v) => [v.kind, v.exportName])).toEqual([["undeclared-export", "helper"]]);
  });

  test("a public member other than execute is undeclared surface; private ones are free", () => {
    const extra = HANDLER.replace("  async execute(", "  count = 0;\n\n  private cache = 0;\n\n  describe(): string {\n    return \"x\";\n  }\n\n  async execute(");
    expect(handlerSurface(extra).map((v) => [v.kind, v.message.split(":")[0]])).toEqual([
      ["undeclared-member", "CreateNoteHandler.count"],
      ["undeclared-member", "CreateNoteHandler.describe"],
    ]);
  });

  test("a static execute is not the in port's execute", () => {
    const found = handlerSurface(HANDLER.replace("async execute(", "static async run(): Promise<void> {}\n\n  async execute("));
    expect(found.map((v) => v.kind)).toEqual(["undeclared-member"]);
  });

  test("a handler without `implements` is refused — the compiler would not hold it to the port", () => {
    const found = handlerSurface(HANDLER.replace(" implements CreateNote", ""));
    expect(found.map((v) => v.kind)).toEqual(["handler-shape"]);
    expect(found[0]!.message).toContain("implements CreateNote");
  });

  test("a missing or renamed handler class is refused", () => {
    const found = handlerSurface(HANDLER.replace("export class CreateNoteHandler", "export class NoteMaker"));
    expect(found.map((v) => [v.kind, v.exportName])).toEqual([["undeclared-export", "NoteMaker"], ["handler-shape", "CreateNoteHandler"]]);
  });

  test("a types-only contract has no pair", () => {
    const shared = "export interface Clock {\n  now(): Promise<Date>;\n}\n";
    expect(implementationOf(shared, "contexts/notes/src/application/shared/clock.contract.ts")).toBeUndefined();
    expect(compareSurfaces(shared, "clock.contract.ts", "export const anything = 1;\n", "clock.ts")).toEqual([]);
  });
});

// --- the project walk -------------------------------------------------------------------

describe("checkProjectSurfaces", () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  function monorepo(files: Record<string, string>, manifest: unknown = { name: "fixture", workspaces: ["contexts/*", "apps/*"] }): string {
    const root = mkdtempSync(join(tmpdir(), "surface-roots-"));
    dirs.push(root);
    const all: Record<string, string> = { ...(manifest === null ? {} : { "package.json": JSON.stringify(manifest) }), ...files };
    for (const [rel, source] of Object.entries(all)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), source, "utf8");
    }
    return root;
  }

  const concepts = (): Record<string, string> =>
    Object.fromEntries(EXAMPLE_CONCEPTS.flatMap((c) => [[c.contractPath, c.contract], [c.contractPath.replace(".contract.ts", ".ts"), c.implementation]]));

  test("a clean project exits 0, counting concept and feature pairs", () => {
    const run = checkProjectSurfaces(monorepo({ ...concepts(), [FEATURE_PATH]: FEATURE_CONTRACT, [HANDLER_PATH]: HANDLER }));
    expect(run.lines).toEqual(["surface-check: OK (7 contract pairs)"]);
    expect(run.code).toBe(0);
  });

  test("a violation exits 1 with one greppable line per violation and a total", () => {
    const run = checkProjectSurfaces(monorepo({ [FEATURE_PATH]: FEATURE_CONTRACT, [HANDLER_PATH]: `${HANDLER}export const leaked = 1;\n` }));
    expect(run.code).toBe(1);
    expect(run.lines[0]).toMatch(new RegExp(`^surface-check: FAIL ${HANDLER_PATH} — leaked:`));
    expect(run.lines.at(-1)).toBe("surface-check: 1 violation across 1 contract pair");
    expect(run.violations).toHaveLength(1);
  });

  test("a contract whose implementation file is missing is misuse (exit 2), naming the file", () => {
    const run = checkProjectSurfaces(monorepo({ [FEATURE_PATH]: FEATURE_CONTRACT }));
    expect(run.code).toBe(2);
    expect(run.lines).toEqual([`surface-check: ERROR — ${FEATURE_PATH} has no implementation ${HANDLER_PATH}; the design gate writes its skeleton`]);
  });

  test("types-only contracts are walked but never paired", () => {
    const run = checkProjectSurfaces(monorepo({ "contexts/notes/src/application/shared/clock.contract.ts": "export interface Clock {\n  now(): Promise<Date>;\n}\n" }));
    expect(run).toMatchObject({ code: 0, lines: ["surface-check: OK (0 contract pairs)"] });
  });

  test("no contracts at all is misuse (exit 2) — silence is not success", () => {
    const run = checkProjectSurfaces(monorepo({}));
    expect(run.code).toBe(2);
    expect(run.lines[0]).toMatch(/no contexts\/\*\/src\/\*\*\/\*\.contract\.ts, apps\/\*\/src\/\*\*\/\*\.contract\.ts found/);
  });

  test("walks only the roots it is given", () => {
    const root = monorepo({ ...concepts(), "elsewhere/x.contract.ts": FEATURE_CONTRACT });
    expect(checkProjectSurfaces(root, ["contexts/*/src"]).code).toBe(0);
    expect(checkProjectSurfaces(root, ["apps/*/src"]).code).toBe(2);
  });

  test("the default roots come from the manifest's workspaces, else src", () => {
    expect(manifestSourceRoots(monorepo({}))).toEqual(["contexts/*/src", "apps/*/src"]);
    expect(manifestSourceRoots(monorepo({}, { name: "flat" }))).toEqual(["src"]);
    expect(manifestSourceRoots(monorepo({}, null))).toEqual(["src"]);
    expect(manifestSourceRoots(monorepo({}, { workspaces: ["packages/**", "libs/*"] }))).toEqual(["libs/*/src"]);
  });

  test("a dependency or dot directory under a root is never walked", () => {
    const root = monorepo({
      ...concepts(),
      "contexts/project-management/src/node_modules/x/x.contract.ts": FEATURE_CONTRACT,
      "contexts/project-management/src/.cache/y.contract.ts": FEATURE_CONTRACT,
    });
    expect(checkProjectSurfaces(root).code).toBe(0);
  });
});
