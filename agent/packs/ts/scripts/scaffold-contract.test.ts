import { writeProjectPacks } from "../../../src/project-composition.ts";
import { existsSync, mkdtempSync as createTempDir, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import ts from "typescript";
import { readGuardLog } from "../../../src/guard-log.ts";
import {
  ERRORS_MODULE_SOURCE,
  ScaffoldError,
  errorsModuleFor,
  isGeneratedArtifact,
  scaffoldContract,
  runScaffold,
  skeletonExtensionFor as extensionFor,
  skeletonPathFor as pathFor,
  skeletonSiblingPaths,
  shippedSupportSource,
  supportModuleNames,
} from "./scaffold-contract.ts";
import { serviceRuntimeSupport } from "../../ts-service/service-runtime-support.ts";
import { implementationSkeleton, NOT_IMPLEMENTED_MODULE_SOURCE } from "./domain-emitter.ts";
import { parseDomainConcept } from "./domain-concept.ts";
import { EXAMPLE_CONCEPTS, exampleConcept } from "./testdata/example-domain.ts";
import { stripConformance } from "./deliver.ts";

const TESTDATA = join(import.meta.dirname, "testdata");
const fixture = (name: string) => readFileSync(join(TESTDATA, name), "utf8");
const contractOf = (name: string) => fixture(`${name}.contract.ts`);
const goldenOf = (name: string) => fixture(`${name}.golden.ts`);

const PAIRS = ["functions", "queue", "types", "values"] as const;

// --- golden files ------------------------------------------------------------

// The path passed for each fixture reflects its assumed project layout
// (the errors-module specifier is derived from it): queue lives one level
// down because its contract imports '../shared/money.js'.
const LAYOUT: Record<(typeof PAIRS)[number], string> = {
  functions: "functions.contract.ts",
  queue: "queue/queue.contract.ts",
  types: "types.contract.ts",
  values: "values.contract.ts",
};

describe("golden files", () => {
  for (const name of PAIRS) {
    test(`${name}.contract.ts → skeleton matches ${name}.golden.ts`, () => {
      expect(scaffoldContract(contractOf(name), LAYOUT[name])).toBe(goldenOf(name));
    });
  }
});

// --- output compiles against the contract (strict, NodeNext) -----------------

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function writeTmp(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "scaffold-test-"));
  tmpDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

function typecheck(files: Record<string, string>): string[] {
  const dir = writeTmp(files);
  // NodeNext + verbatimModuleSyntax is what a target project actually runs
  // (agent/scripts/dogfood-reset); without `"type": "module"` every ESM import
  // in a generated file is an error there but not here.
  writeFileSync(join(dir, "package.json"), `{"name":"scaffold-fixture","type":"module"}\n`);
  const program = ts.createProgram(
    Object.keys(files).map((f) => join(dir, f)),
    {
      verbatimModuleSyntax: true,
      // Contracts import each other by their real `.ts` name (ADR 2026-059).
      allowImportingTsExtensions: true,
      // Very strict, per the harness TS philosophy: inference-first,
      // no implicit anything. noUnusedParameters stays off deliberately —
      // a throwing skeleton's parameters are unused by design.
      strict: true,
      noUnusedLocals: true,
      noImplicitReturns: true,
      noImplicitOverride: true,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      skipLibCheck: true,
      types: [],
    },
  );
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => `${d.file?.fileName ?? "<global>"}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
}

// A contract imports another contract directly (ADR 2026-059), so the queue
// fixture needs only Money's contract beside it.
const MONEY_CONTRACT = "export interface Money {\n  cents: number;\n  currency: string;\n}\n";

// Every skeleton project has the template's shared errors module.
const SHARED = { "shared/errors.ts": ERRORS_MODULE_SOURCE };

describe("skeletons compile against their contracts", () => {
  test("functions", () => {
    expect(
      typecheck({
        "functions.contract.ts": contractOf("functions"),
        "functions.ts": goldenOf("functions"),
        ...SHARED,
      }),
    ).toEqual([]);
  });

  test("class (with cross-contract type import)", () => {
    expect(
      typecheck({
        "queue/queue.contract.ts": contractOf("queue"),
        "queue/queue.ts": goldenOf("queue"),
        "shared/money.contract.ts": MONEY_CONTRACT,
        ...SHARED,
      }),
    ).toEqual([]);
  });

  test("types-only contract", () => {
    expect(
      typecheck({
        "types.contract.ts": contractOf("types"),
        "types.ts": goldenOf("types"),
        ...SHARED,
      }),
    ).toEqual([]);
  });

  test("declare const values", () => {
    expect(
      typecheck({
        "values.contract.ts": contractOf("values"),
        "values.ts": goldenOf("values"),
        ...SHARED,
      }),
    ).toEqual([]);
  });

  test("a skeleton missing a contract value export fails to compile (conformance block works)", () => {
    const broken = goldenOf("functions").replace(
      'const __conformance: Pick<typeof __Contract, "createOrder" | "find" | "identity"> = { createOrder, find, identity };',
      'const __conformance: Pick<typeof __Contract, "createOrder" | "find" | "identity"> = { createOrder, find };',
    );
    const diags = typecheck({
      "functions.contract.ts": contractOf("functions"),
      "functions.ts": broken,
      ...SHARED,
    });
    expect(diags.length).toBeGreaterThan(0);
    expect(diags.join("\n")).toMatch(/identity/);
  });
});

// ---------------------------------------------------------------------------
// MIXED CONTRACT CONFORMANCE (dogfood r18)
// ---------------------------------------------------------------------------
//
// The __conformance check excludes nominal value-object classes from its object
// literal (ADR 2026-015: a nominal class cannot be checked by a typeof
// comparison; surface-check verifies classes semantically instead). The bug: the
// annotation was `typeof __Contract` — the type of the WHOLE contract namespace,
// classes included — so the object was missing those classes and TypeScript
// raised TS2740 ("… is missing the following properties … BuildingId, …"). It
// only bit when ONE contract file mixed a nominal class WITH non-class value
// exports; a class-only or function-only contract never triggered it, which is
// why every prior fixture passed. r18: kimi's cockpit.contract.ts (9 classes + 4
// functions/consts) produced `src/cockpit/cockpit.ts(240): TS2740`.
//
// The fix: annotate `Pick<typeof __Contract, <the exact object-key names>>`, so
// the check asserts precisely the scaffoldable non-class value exports and
// demands nothing the object omits. Classes stay out of both the object and the
// annotation, still covered by surface-check.

// Nominal value-object classes (private __brand ⇒ nominal) mixed with a
// non-class function AND a non-class const, all in one file — the shape r18 hit.
// Two classes so the missing-properties error is the plural form the bug named
// ("… is missing the following properties … BuildingId, MeterId"). The non-class
// exports deliberately do NOT reference the value objects: that is the real r18
// case (an operation referencing a same-file value object hits the SEPARATE
// ADR-2026-023 dual-identity mechanism — the runtime class and the contract's
// ambient class are two `__brand` declarations — which surfaces as a different
// error and is not what the conformance annotation controls).
const MIXED_CONTRACT = `/** BuildingId: a branded identifier. */
export declare class BuildingId {
  private readonly __brand: "BuildingId";
  private constructor();
  readonly value: string;
  static parse(raw: unknown): BuildingId | undefined;
}

/** MeterId: a branded identifier. */
export declare class MeterId {
  private readonly __brand: "MeterId";
  private constructor();
  readonly value: string;
  static parse(raw: unknown): MeterId | undefined;
}

export declare function summarize(count: number): string;
export declare const DEFAULT_LIMIT: number;
`;

// A class-only contract: the one nominal value object and nothing else. No
// scaffoldable non-class value export ⇒ no __conformance block at all.
const CLASS_ONLY_CONTRACT = `/** MeterId: a branded identifier. */
export declare class MeterId {
  private readonly __brand: "MeterId";
  private constructor();
  readonly value: string;
  static parse(raw: unknown): MeterId | undefined;
}
`;

describe("mixed contract conformance (nominal class + non-class value exports)", () => {
  // REPRODUCE (the spec). The bug was the annotation, so pin it as one: take the
  // real generator's skeleton and put the OLD whole-namespace annotation back.
  // It must fail exactly as r18 did — missing the value-object classes the object
  // deliberately omits — which is why the object needs a narrower annotation.
  test("the old `typeof __Contract` annotation fails, missing the nominal classes", () => {
    const oldForm = scaffoldContract(MIXED_CONTRACT, "cockpit.contract.ts").replace(
      /const __conformance: Pick<typeof __Contract, [^>]*> =/,
      "const __conformance: typeof __Contract =",
    );
    const diags = typecheck({
      "cockpit.contract.ts": MIXED_CONTRACT,
      "cockpit.ts": oldForm,
      ...SHARED,
    }).join("\n");
    expect(diags).toMatch(/missing the following properties from type 'typeof/);
    expect(diags).toMatch(/BuildingId/);
    expect(diags).toMatch(/MeterId/);
  });

  // THE r18 SPEC, stated positively: with the real (Pick) annotation the
  // scaffolded skeleton assembles and typechecks clean, everything throwing.
  test("a mixed contract scaffolds to a COMPILING skeleton", () => {
    expect(
      typecheck({
        "cockpit.contract.ts": MIXED_CONTRACT,
        "cockpit.ts": scaffoldContract(MIXED_CONTRACT, "cockpit.contract.ts"),
        ...SHARED,
      }),
    ).toEqual([]);
  });

  // The conformance block names EXACTLY the non-class value exports — the same
  // names in the Pick union and in the object literal — and no class appears in
  // either. This is what keeps the annotation from drifting from the object.
  test("the Pick union and the object list exactly the non-class value exports", () => {
    const skeleton = scaffoldContract(MIXED_CONTRACT, "cockpit.contract.ts");
    expect(skeleton).toContain(
      'const __conformance: Pick<typeof __Contract, "summarize" | "DEFAULT_LIMIT"> = { summarize, DEFAULT_LIMIT };',
    );
    // No nominal class appears in the annotation or the object.
    expect(skeleton).not.toMatch(/__conformance[^\n]*BuildingId/);
    expect(skeleton).not.toMatch(/__conformance[^\n]*MeterId/);
    // And never the whole-namespace annotation that caused the r18 failure.
    expect(skeleton).not.toContain("const __conformance: typeof __Contract");
  });

  // A class-only contract has no scaffoldable non-class value export, so there is
  // nothing a typeof check could assert — emit no block rather than
  // `Pick<typeof __Contract, never>`. It still compiles.
  test("a class-only contract emits no conformance block and compiles", () => {
    const skeleton = scaffoldContract(CLASS_ONLY_CONTRACT, "meter.contract.ts");
    expect(skeleton).not.toContain("__conformance");
    expect(skeleton).not.toContain("__Contract");
    expect(
      typecheck({
        "meter.contract.ts": CLASS_ONLY_CONTRACT,
        "meter.ts": skeleton,
        ...SHARED,
      }),
    ).toEqual([]);
  });

  // A function/const-only contract still gets a correct Pick-annotated block and
  // compiles (the common case, now stated with the Pick form pinned).
  test("a function/const-only contract gets a Pick-annotated block and compiles", () => {
    expect(goldenOf("functions")).toContain(
      'const __conformance: Pick<typeof __Contract, "createOrder" | "find" | "identity"> = { createOrder, find, identity };',
    );
    expect(goldenOf("values")).toContain(
      'const __conformance: Pick<typeof __Contract, "DEFAULT_PAGE_SIZE" | "SERVICE_NAME"> = { DEFAULT_PAGE_SIZE, SERVICE_NAME };',
    );
  });

  // deliver strips the block by AST identity (the __conformance variable and the
  // `import type * as __Contract` namespace import), not by matching the old
  // `typeof __Contract` text — so the Pick form is stripped just the same.
  test("deliver's conformance strip still removes the Pick-annotated block", () => {
    const skeleton = scaffoldContract(MIXED_CONTRACT, "cockpit.contract.ts");
    const stripped = stripConformance(skeleton, "cockpit.ts");
    expect(stripped).not.toBeNull();
    expect(stripped!).not.toContain("__conformance");
    expect(stripped!).not.toContain("__Contract");
    // The real exports survive the strip.
    expect(stripped!).toContain("export function summarize");
    expect(stripped!).toContain("export class BuildingId");
  });
});

// ---------------------------------------------------------------------------
// CONTRACTS IMPORT ONLY CONTRACTS (ADR 2026-059) — the scaffolder's backstop
// ---------------------------------------------------------------------------
//
// The retired declare-class model needed the OPPOSITE rule (reach a value
// object through its implementation module, ADR 2026-023/026). Now a contract
// imports other contracts, and the scaffolder refuses exactly what
// contract-purity's contract-imports-contracts-only refuses, by asking the
// rule's own predicate — lint-passing implies scaffoldable.

describe("the scaffolder's import backstop agrees with contract-imports-contracts-only", () => {
  const OP = (source: string): string => `import type { Money } from "${source}";\nexport declare function charge(amount: Money): Money;\n`;

  test("a contract-to-contract import scaffolds", () => {
    expect(() => scaffoldContract(OP("../values/values.contract.ts"), "src/billing/billing.contract.ts")).not.toThrow();
  });

  test.each([
    ["an implementation module", "../values/values.ts", /is not a contract/],
    ["a '.js' specifier", "../values/values.contract.js", /uses a '\.js' specifier/],
    ["a workspace layer path", "@acme/billing/application", /workspace layer path/],
  ])("%s is refused, naming the rule", (_label, source, reason) => {
    const run = (): string => scaffoldContract(OP(source), "src/billing/billing.contract.ts");
    expect(run).toThrowError(ScaffoldError);
    expect(run).toThrowError(reason);
    expect(run).toThrowError(/contract-imports-contracts-only/);
  });

  test("a package outside the hexagonal layers is not builder code, so it scaffolds", () => {
    expect(() => scaffoldContract(OP("some-lib"), "src/billing/billing.contract.ts")).not.toThrow();
  });

  test("a composed pack's shipped support module is generated machinery, so it scaffolds", () => {
    expect(supportModuleNames()).toContain("service-runtime");
    expect(() => scaffoldContract(OP("./service-runtime.js"), "src/api/api.contract.ts")).not.toThrow();
  });

  test("re-exports and import() types are refused", () => {
    expect(() => scaffoldContract('export type { Money } from "../values/values.contract.ts";\nexport declare function f(): void;\n', "src/b/b.contract.ts"))
      .toThrowError(/re-exports nothing \(contract-imports-contracts-only\)/);
    expect(() => scaffoldContract('export declare function f(): import("../values/values.ts").Money;\n', "src/b/b.contract.ts"))
      .toThrowError(/import\(/);
  });
});

// --- every export throws NotImplementedError ---------------------------------

// Skeletons import the shared errors module at runtime, so runtime tests
// bundle from a real tmp project (esbuild resolves the .js→.ts specifiers).
async function importModule(
  files: Record<string, string>,
  entry: string,
): Promise<Record<string, unknown>> {
  const dir = writeTmp(files);
  const result = await build({
    entryPoints: [join(dir, entry)],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
  });
  const code = result.outputFiles[0].text;
  return import("data:text/javascript;base64," + Buffer.from(code, "utf8").toString("base64"));
}

describe("skeletons throw NotImplementedError at runtime", () => {
  test("functions: module imports cleanly; every call throws NotImplementedError", async () => {
    const mod = await importModule({ "functions.ts": goldenOf("functions"), ...SHARED }, "functions.ts");
    for (const name of ["createOrder", "find", "identity"]) {
      expect(() => (mod[name] as (...a: unknown[]) => unknown)("x")).toThrowError(/NotImplemented/);
      try {
        (mod[name] as (...a: unknown[]) => unknown)("x");
        expect.unreachable();
      } catch (e) {
        expect((e as Error).name).toBe("NotImplementedError");
      }
    }
  });

  test("class: constructor and statics throw NotImplementedError", async () => {
    const mod = await importModule(
      { "queue/queue.ts": goldenOf("queue"), ...SHARED },
      "queue/queue.ts",
    );
    const Queue = mod["Queue"] as {
      new (n: number): unknown;
      create(n: number): unknown;
      instances: number;
    };
    expect(() => new Queue(3)).toThrowError(/NotImplemented: Queue\.constructor/);
    expect(() => Queue.create(3)).toThrowError(/NotImplemented: Queue\.create/);
    expect(() => Queue.instances).toThrowError(/NotImplemented: Queue\.instances/);
    try {
      new Queue(3);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).name).toBe("NotImplementedError");
    }
  });

  test("declare const: the throw happens at module evaluation (documented behavior)", async () => {
    const files = { "values.ts": goldenOf("values"), ...SHARED };
    await expect(importModule(files, "values.ts")).rejects.toThrowError(
      /NotImplemented: DEFAULT_PAGE_SIZE/,
    );
    await importModule(files, "values.ts").then(
      () => expect.unreachable(),
      (e: Error) => expect(e.name).toBe("NotImplementedError"),
    );
  });

  test("types-only skeleton imports as an empty module", async () => {
    const mod = await importModule({ "types.ts": goldenOf("types") }, "types.ts");
    expect(Object.keys(mod)).toHaveLength(0);
  });
});

// --- path mapping -------------------------------------------------------------

describe("skeletonPathFor (foo.contract.ts → sibling foo.ts)", () => {
  test("maps the fixed naming rule", () => {
    expect(skeletonPathFor("src/orders/orders.contract.ts")).toBe("src/orders/orders.ts");
    expect(skeletonPathFor("a.contract.ts")).toBe("a.ts");
  });

  test("rejects non-contract paths", () => {
    expect(() => skeletonPathFor("src/orders/orders.ts")).toThrowError(ScaffoldError);
    expect(() => skeletonPathFor("src/orders/orders.ts")).toThrowError(/not a \*\.contract\.ts path/);
  });

  test("scaffoldContract insists on a *.contract.ts filename", () => {
    expect(() => scaffoldContract("export type T = string;", "x.ts")).toThrowError(
      /not a \*\.contract\.ts path/,
    );
  });

  test("errorsModuleFor: shared errors module lives at <root>/shared/errors", () => {
    expect(errorsModuleFor("src/orders/orders.contract.ts")).toBe("src/shared/errors");
    expect(errorsModuleFor("src/x.contract.ts")).toBe("src/shared/errors");
    expect(errorsModuleFor("x.contract.ts")).toBe("shared/errors");
  });
});

// --- unsupported constructs fail loudly (never silently wrong output) ---------

describe("unsupported or non-declaration constructs → ScaffoldError", () => {
  const cases: [label: string, source: string, pattern: RegExp][] = [
    ["enum", "export enum Level { Low, High }", /enum/],
    ["declare enum", "export declare enum Level { Low, High }", /enum/],
    ["value import", 'import { Pool } from "pg";', /value import/],
    ["side-effect import", 'import "pg";', /side-effect import/],
    ["function body", "export function f() { return 1; }", /function body/],
    ["value binding", "export const X = 1;", /value binding/],
    ["namespace value", "export declare namespace N { function f(): void; }", /namespace/],
    ["default export", "export default function f(): void;", /default export/],
    ["export =", "export = {};", /export =/],
    ["destructuring declare", "export declare const { a }: { a: string };", /destructur/],
    [
      "scaffold-internal name collision",
      "export declare function notImplemented(): void;",
      /collides with scaffold internals/,
    ],
    [
      "public-surface type must be exported",
      "type Hidden = string;\nexport declare function f(): Hidden;",
      /'Hidden' is part of the public surface but not exported/,
    ],
    [
      "overloaded method",
      "export declare class C {\n  m(a: string): void;\n  m(a: number): void;\n}",
      /overloaded method 'C\.m'/,
    ],
    [
      "overloaded constructor",
      "export declare class C {\n  constructor(a: string);\n  constructor(a: number);\n}",
      /overloaded constructor/,
    ],
    [
      "declare const without a type",
      "export declare const X;",
      /needs an explicit type/,
    ],
    ["extends heritage", "export declare class E extends Error {}", /extends a base class/],
  ];
  for (const [label, source, pattern] of cases) {
    test(label, () => {
      expect(() => scaffoldContract(source, "x.contract.ts")).toThrowError(ScaffoldError);
      expect(() => scaffoldContract(source, "x.contract.ts")).toThrowError(pattern);
    });
  }

  test("implements still scaffolds (no super needed)", () => {
    const source = "export interface Foo { m(): void }\nexport declare class C implements Foo { m(): void; }";
    expect(() => scaffoldContract(source, "x.contract.ts")).not.toThrow();
  });
});

// --- CLI: thin wiring + guard-log events --------------------------------------

const SCRIPT = join(import.meta.dirname, "scaffold-contract.ts");

describe("scaffold-contract CLI", () => {
  test("success: writes skeleton, creates shared errors module, logs pass", () => {
    const dir = writeTmp({ "src/orders/orders.contract.ts": contractOf("functions") });
    const r = spawnSync(process.execPath, [SCRIPT, "src/orders/orders.contract.ts"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/scaffold: created src\/shared\/errors\.ts/);
    expect(r.stdout).toMatch(/scaffold: wrote src\/orders\/orders\.ts/);
    const events = readGuardLog(dir);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      guard: "scaffold",
      verdict: "pass",
      summary: "wrote src/orders/orders.ts",
    });
    expect(events[0].detail).toMatchObject({
      contract: "src/orders/orders.contract.ts",
      skeleton: "src/orders/orders.ts",
      createdErrorsModule: true,
    });
  });

  test("failure: ScaffoldError exits 1 with the reason and logs a block", () => {
    const dir = writeTmp({ "src/bad/bad.contract.ts": "export enum Level { Low, High }\n" });
    const r = spawnSync(process.execPath, [SCRIPT, "src/bad/bad.contract.ts"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/enum 'Level' is not scaffoldable/);
    const events = readGuardLog(dir);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ guard: "scaffold", verdict: "block" });
    expect(events[0].summary).toMatch(/enum 'Level' is not scaffoldable/);
  });
});

// ---------------------------------------------------------------------------
// runScaffold — the CLI and `design_gate`'s scaffold step both land here
// ---------------------------------------------------------------------------

describe("runScaffold", () => {
  const dirs: string[] = [];
  const project = (contracts: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), "scaffold-run-"));
    dirs.push(dir);
    for (const [rel, source] of Object.entries(contracts)) {
      const path = join(dir, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, source);
    }
    return dir;
  };
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  const GOOD = `export type Id = string & { readonly __brand: "Id" };
export declare function get(id: Id): string;
`;

  // The CLI takes ONE contract per call, and dogfood Run 4 lost time to exactly
  // that: the orchestrator passed a glob, got a confusing error, and went
  // reading the script. The tool finds the contracts itself.
  test("scaffolds every contract in the project from one call", () => {
    const dir = project({
      "src/orders/orders.contract.ts": GOOD,
      "src/billing/billing.contract.ts": GOOD,
    });
    const result = runScaffold(dir);
    expect(result.code).toBe(0);
    expect(readFileSync(join(dir, "src/orders/orders.ts"), "utf8")).toContain("NotImplementedError");
    expect(readFileSync(join(dir, "src/billing/billing.ts"), "utf8")).toContain(
      "NotImplementedError",
    );
  });

  // The ordering nit recorded in docs/dogfooding.md: the CLI created the shared
  // errors module BEFORE validating the contract, so a rejected scaffold left
  // the module behind. Generating first — the step that rejects — means a
  // refusal now touches nothing at all.
  test("a rejected contract leaves nothing behind on disk", () => {
    const dir = project({ "src/orders/orders.contract.ts": "export const runtimeValue = 42;\n" });
    const result = runScaffold(dir);
    expect(result.code).toBe(1);
    expect(result.lines.join("\n")).toContain("declaration-only");
    expect(existsSync(join(dir, "src/shared/errors.ts"))).toBe(false);
    expect(existsSync(join(dir, "src/orders/orders.ts"))).toBe(false);
  });

  // A gate that silently succeeds on an empty project is a broken gate — the
  // same rule contract-purity already follows.
  test("a project with no contracts is misuse, not a pass", () => {
    const result = runScaffold(project({}));
    expect(result.code).toBe(2);
    expect(result.lines.join("\n")).toContain("nothing to scaffold");
  });

  // The architect's scratch zone (Fix 4): a probe that happens to be named like
  // a contract is not a contract. The scaffolder shares checksum-gate's walk,
  // which skips scratch/, so it generates no skeleton for it — a project whose
  // ONLY contract-shaped file is in scratch/ has nothing to scaffold.
  test("a scratch/*.contract.ts is not scaffolded", () => {
    const dir = project({
      "src/orders/orders.contract.ts": GOOD,
      "scratch/probe.contract.ts": GOOD,
    });
    expect(runScaffold(dir).code).toBe(0);
    expect(existsSync(join(dir, "src/orders/orders.ts"))).toBe(true);
    // No skeleton was written beside the scratch probe.
    expect(existsSync(join(dir, "scratch/probe.ts"))).toBe(false);
  });

  test("a project whose only contract-shaped file lives in scratch/ has nothing to scaffold", () => {
    const result = runScaffold(project({ "scratch/probe.contract.ts": GOOD }));
    expect(result.code).toBe(2);
    expect(result.lines.join("\n")).toContain("nothing to scaffold");
  });
});

// ---------------------------------------------------------------------------
// A contract with no value exports is not implementable (dogfood Run 6)
// ---------------------------------------------------------------------------

describe("contracts that declare only types", () => {
  const dirs: string[] = [];
  const project = (contracts: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), "scaffold-empty-"));
    dirs.push(dir);
    for (const [rel, source] of Object.entries(contracts)) {
      const path = join(dir, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, source);
    }
    return dir;
  };
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  // THE RUN 6 FAILURE. The architect expressed every operation as a method on
  // `export interface SubscriptionBilling`. An interface is a TYPE — it exists
  // only at compile time — so the contract had 27 type exports and zero value
  // exports. The scaffolder had nothing to throw, emitted a file containing
  // just `export type * from "./billing.contract.js"`, and logged `pass`.
  //
  // Every gate then agreed: contract-purity passed (declaration-only, no naked
  // primitives), typecheck passed (an empty module compiles), checksum-gate
  // froze it. Four green gates on a contract that cannot be implemented or
  // tested — the test-writer had no way to obtain a SubscriptionBilling to
  // call, and the builder had nothing to fill in.
  //
  // An empty skeleton is the loudest available signal that DESIGN produced
  // nothing buildable. It must be a block, named at the moment it happens,
  // rather than a confusing red-gate failure two phases later.
  const TYPES_ONLY = `export type PlanId = string & { readonly __brand: "PlanId" };
export interface Plan { readonly id: PlanId; }
export interface Billing {
  start(plan: Plan): Plan;
}
`;

  const IMPLEMENTABLE = `export type PlanId = string & { readonly __brand: "PlanId" };
export interface Plan { readonly id: PlanId; }
export declare function start(plan: Plan): Plan;
`;

  test("a types-only contract is a block, not a silent empty skeleton", () => {
    const dir = project({ "src/billing.contract.ts": TYPES_ONLY });
    const result = runScaffold(dir);
    expect(result.code).toBe(1);
    const text = result.lines.join("\n");
    expect(text).toContain("billing.contract.ts");
    expect(text).toMatch(/only types|nothing to implement/i);
  });

  test("the message says how to fix it", () => {
    const result = runScaffold(project({ "src/billing.contract.ts": TYPES_ONLY }));
    // An interface full of methods LOOKS like an API, so the block has to name
    // the actual distinction rather than just refusing.
    expect(result.lines.join("\n")).toMatch(/export declare/);
  });

  test("a contract with a declared function still scaffolds", () => {
    const dir = project({ "src/billing.contract.ts": IMPLEMENTABLE });
    const result = runScaffold(dir);
    expect(result.code).toBe(0);
    expect(readFileSync(join(dir, "src/billing.ts"), "utf8")).toContain("NotImplementedError");
  });

  // A shared vocabulary module IS legitimately types-only (Run 1 had
  // shared/book.contract.ts). What matters is that the PROJECT has something
  // implementable, not that every single file does.
  test("a types-only contract is fine alongside one that is implementable", () => {
    const dir = project({
      "src/shared/vocab.contract.ts": TYPES_ONLY,
      "src/billing.contract.ts": IMPLEMENTABLE,
    });
    const result = runScaffold(dir);
    expect(result.code).toBe(0);
    expect(readFileSync(join(dir, "src/billing.ts"), "utf8")).toContain("NotImplementedError");
  });
});


// ---------------------------------------------------------------------------
// Domain concepts (ADR 2026-059): the domain emitter's skeleton and laws
// ---------------------------------------------------------------------------
//
// A contract at contexts/<ctx>/src/domain/<area>/<concept>.contract.ts is not
// scaffolded by the declare-class path: runScaffold writes the emitter's
// <Name>Impl skeleton where no file exists, regenerates the colocated laws,
// and creates the red-phase errors module where the skeleton imports it.

describe("runScaffold on domain concept contracts", () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  function domainProject(): string {
    const dir = createTempDir(join(tmpdir(), "scaffold-domain-"));
    dirs.push(dir);
    writeProjectPacks(dir, ["ts"]);
    for (const c of EXAMPLE_CONCEPTS) {
      mkdirSync(dirname(join(dir, c.contractPath)), { recursive: true });
      writeFileSync(join(dir, c.contractPath), c.contract);
    }
    return dir;
  }

  test("writes each skeleton, each laws file and the errors module", () => {
    const dir = domainProject();
    const r = runScaffold(dir);
    expect(r.code).toBe(0);
    for (const c of EXAMPLE_CONCEPTS) {
      const impl = c.contractPath.replace(".contract.ts", ".ts");
      expect(readFileSync(join(dir, impl), "utf8")).toBe(implementationSkeleton(parseDomainConcept(c.contractPath, c.contract)));
      expect(existsSync(join(dir, c.contractPath.replace(".contract.ts", ".laws.test.ts")))).toBe(true);
      expect(r.lines).toContain(`scaffold: wrote ${impl}`);
    }
    const errors = "contexts/project-management/src/domain/shared/errors.ts";
    expect(readFileSync(join(dir, errors), "utf8")).toBe(NOT_IMPLEMENTED_MODULE_SOURCE);
    expect(r.lines).toContain(`scaffold: created ${errors} (red-phase errors module)`);
  });

  test("an existing implementation is never overwritten; the laws are regenerated", () => {
    const dir = domainProject();
    expect(runScaffold(dir).code).toBe(0);
    const note = exampleConcept("note");
    const impl = join(dir, note.contractPath.replace(".contract.ts", ".ts"));
    writeFileSync(impl, note.implementation);
    const laws = join(dir, note.contractPath.replace(".contract.ts", ".laws.test.ts"));
    const generated = readFileSync(laws, "utf8");
    writeFileSync(laws, "// tampered\n");
    const r = runScaffold(dir);
    expect(r.code).toBe(0);
    expect(readFileSync(impl, "utf8")).toBe(note.implementation);
    expect(readFileSync(laws, "utf8")).toBe(generated);
    expect(r.lines.some((l) => l.startsWith(`scaffold: kept ${note.contractPath.replace(".contract.ts", ".ts")}`))).toBe(true);
  });

  test("a bad domain contract blocks the run with its path and the fix, writing nothing", () => {
    const dir = domainProject();
    const bad = exampleConcept("note-text");
    writeFileSync(join(dir, bad.contractPath), bad.contract.replace("Result<NoteText>", "NoteText | undefined"));
    const r = runScaffold(dir);
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toMatch(/note-text\.contract\.ts: .*parse\(raw: unknown\): Result<NoteText>/);
    expect(existsSync(join(dir, bad.contractPath.replace(".contract.ts", ".ts")))).toBe(false);
  });

  test("a domain-only project is not refused as types-only", () => {
    const dir = domainProject();
    expect(runScaffold(dir).lines.join("\n")).not.toMatch(/declares only types/);
  });
});

// ---------------------------------------------------------------------------
// The scaffold step is a SYNC: deleting a contract deletes what it generated
// ---------------------------------------------------------------------------
//
// Run r14: an architect deleted a scratch contract, and its skeleton and law
// suite stayed. Generated files live in write zones the architect does not
// hold, so removing them cost ~10 minutes and two failed delegate spawns for
// two files nobody wrote. The generator owns its output on the way out as well
// as on the way in — deleting the contract is the whole gesture.

describe("runScaffold prunes orphaned generated files", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  const project = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), "scaffold-prune-"));
    dirs.push(dir);
    for (const [rel, source] of Object.entries(files)) {
      const path = join(dir, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, source);
    }
    return dir;
  };

  /** A value object, so the contract generates a law suite as well as a skeleton. */
  const CURRENCY = `/** Currency: ISO-4217 alphabetic code — three uppercase letters. */
export declare class Currency {
  private readonly __brand: "Currency";
  private constructor();
  readonly value: string;
  static parse(raw: unknown): Currency | undefined;
}

export declare function normalize(currency: Currency): Currency;
`;

  const KEEPER = `export type Id = string & { readonly __brand: "Id" };
export declare function get(id: Id): string;
`;

  /** A domain concept (ADR 2026-059): its laws are colocated and generated;
   *  its skeleton is builder-owned once written, so it carries no marker. */
  const DOMAIN_CONTRACT = "contexts/shop/src/domain/money/currency.contract.ts";
  const DOMAIN_IMPL = "contexts/shop/src/domain/money/currency.ts";
  const DOMAIN_LAWS = "contexts/shop/src/domain/money/currency.laws.test.ts";
  const CURRENCY_CONCEPT = exampleConcept("project-name").contract.replaceAll("ProjectName", "Currency");

  // Both generators must keep emitting the marker the sync recognises. If one
  // ever stopped, the sync would quietly leak that generator's output forever
  // — the failure would be invisible, so it is pinned here rather than trusted.
  test("every generated file this pack writes carries the marker the sync looks for", () => {
    expect(isGeneratedArtifact(scaffoldContract(CURRENCY, "src/money/money.contract.ts"))).toBe(true);
    const dir = project({ [DOMAIN_CONTRACT]: CURRENCY_CONCEPT });
    expect(runScaffold(dir).code).toBe(0);
    expect(isGeneratedArtifact(readFileSync(join(dir, DOMAIN_LAWS), "utf8"))).toBe(true);
    expect(isGeneratedArtifact(readFileSync(join(dir, DOMAIN_IMPL), "utf8"))).toBe(false);
    expect(isGeneratedArtifact(ERRORS_MODULE_SOURCE)).toBe(false);
    expect(isGeneratedArtifact("export const x = 1;\n")).toBe(false);
  });

  // TN-26-006 B1: the marker's pack segment is a wildcard, so a SECOND pack's
  // generator owns its output on the same terms — it may byte-compare,
  // overwrite and delete what it wrote. A ts-web-shaped marker the sync could
  // not read would leave that pack's files undeletable by their own generator
  // and indistinguishable from hand-written work.
  test("another pack's generator marker is recognised too", () => {
    expect(
      isGeneratedArtifact(
        "// GENERATED from packs/ts-web/template.ts by packs/ts-web/scripts/new-web-app.ts — do not edit.\nexport const x = 1;\n",
      ),
    ).toBe(true);
  });

  // What stays narrow is everything that could let a project file acquire the
  // marker by accident, or a generator outside a pack's scripts directory claim
  // ownership of a tree it does not own.
  test("the marker's shape is still exact — near misses are not generated files", () => {
    const nearMisses = [
      // not under packs/
      "// GENERATED from x.ts by tools/ts-web/scripts/new-web-app.ts — do not edit.",
      // not in a scripts/ directory
      "// GENERATED from x.ts by packs/ts-web/new-web-app.ts — do not edit.",
      // a nested path where the pack name goes
      "// GENERATED from x.ts by packs/ts/web/scripts/new-web-app.ts — do not edit.",
      // capitalised pack name
      "// GENERATED from x.ts by packs/TsWeb/scripts/new-web-app.ts — do not edit.",
      // an ASCII hyphen where the em dash belongs
      "// GENERATED from x.ts by packs/ts-web/scripts/new-web-app.ts - do not edit.",
      // no source named
      "// GENERATED by packs/ts-web/scripts/new-web-app.ts — do not edit.",
    ];
    for (const line of nearMisses) {
      expect(isGeneratedArtifact(`${line}\nexport const x = 1;\n`), line).toBe(false);
    }
  });

  // A generator deletes only what IT wrote (TN-26-006 B1). The marker names its
  // generator, and this sync's licence covers the ts pack's two generators and
  // nothing else — otherwise the first design_gate after `new-web-app` ran
  // would sweep away src/ui/main.tsx as an orphaned skeleton, because both
  // files say the word GENERATED.
  test("another pack's generated file survives the prune", () => {
    const webFile =
      "// GENERATED from packs/ts-web/template.ts by packs/ts-web/scripts/new-web-app.ts — do not edit.\nexport const mounted = true;\n";
    const dir = project({
      "src/orders/orders.contract.ts": KEEPER,
      "src/ui/main.tsx": webFile,
    });
    expect(runScaffold(dir).code).toBe(0);
    expect(existsSync(join(dir, "src/ui/main.tsx"))).toBe(true);
    expect(readFileSync(join(dir, "src/ui/main.tsx"), "utf8")).toBe(webFile);
  });

  test("deleting a contract removes its generated skeleton on the next run", () => {
    const dir = project({
      "src/money/money.contract.ts": CURRENCY,
      "src/orders/orders.contract.ts": KEEPER,
    });
    expect(runScaffold(dir).code).toBe(0);
    const skeleton = join(dir, "src/money/money.ts");
    expect(existsSync(skeleton)).toBe(true);

    rmSync(join(dir, "src/money/money.contract.ts"));
    const r = runScaffold(dir);
    expect(r.code).toBe(0);
    expect(r.lines).toContain("scaffold: pruned src/money/money.ts — its contract no longer exists");
    expect(existsSync(skeleton)).toBe(false);
    // The surviving contract's own skeleton is untouched.
    expect(existsSync(join(dir, "src/orders/orders.ts"))).toBe(true);
  });

  // A domain concept's laws are generated and go with the contract; its
  // implementation is the builder's once written (ADR 2026-060) and stays.
  test("deleting a domain contract removes its law suite and keeps the implementation", () => {
    const dir = project({ [DOMAIN_CONTRACT]: CURRENCY_CONCEPT, "src/orders/orders.contract.ts": KEEPER });
    expect(runScaffold(dir).code).toBe(0);
    expect(existsSync(join(dir, DOMAIN_LAWS))).toBe(true);

    rmSync(join(dir, DOMAIN_CONTRACT));
    const r = runScaffold(dir);
    expect(r.code).toBe(0);
    expect(r.lines).toContain(`scaffold: pruned ${DOMAIN_LAWS} — its contract no longer exists`);
    expect(existsSync(join(dir, DOMAIN_LAWS))).toBe(false);
    expect(existsSync(join(dir, DOMAIN_IMPL))).toBe(true);
  });

  test("a directory the prune empties goes too", () => {
    const dir = project({
      "src/money/money.contract.ts": CURRENCY,
      "src/orders/orders.contract.ts": KEEPER,
    });
    expect(runScaffold(dir).code).toBe(0);
    rmSync(join(dir, "src/money/money.contract.ts"));
    const r = runScaffold(dir);
    expect(r.lines).toContain("scaffold: removed empty directory src/money");
    expect(existsSync(join(dir, "src/money"))).toBe(false);
  });

  // The marker is the whole safety argument. A hand-written file that merely
  // sits where a skeleton would sit is somebody's work, and no amount of
  // name-matching may delete it.
  test("a marker-less file with a generated file's exact name survives", () => {
    const dir = project({
      "src/money/money.contract.ts": CURRENCY,
      "src/orders/orders.contract.ts": KEEPER,
    });
    expect(runScaffold(dir).code).toBe(0);
    const handWritten = "export const rate = 1; // written by a person, before the contract existed\n";
    writeFileSync(join(dir, "src/money/money.ts"), handWritten);
    rmSync(join(dir, "src/money/money.contract.ts"));

    const r = runScaffold(dir);
    expect(r.code).toBe(0);
    expect(r.lines.filter((l) => l.includes("pruned"))).toEqual([]);
    expect(readFileSync(join(dir, "src/money/money.ts"), "utf8")).toBe(handWritten);
  });

  test("the prune is idempotent: the second run has nothing to say", () => {
    const dir = project({
      "src/money/money.contract.ts": CURRENCY,
      "src/orders/orders.contract.ts": KEEPER,
    });
    expect(runScaffold(dir).code).toBe(0);
    rmSync(join(dir, "src/money/money.contract.ts"));
    expect(runScaffold(dir).lines.some((l) => l.includes("pruned"))).toBe(true);
    const again = runScaffold(dir);
    expect(again.code).toBe(0);
    expect(again.lines.filter((l) => l.includes("pruned") || l.includes("removed empty"))).toEqual([]);
  });

  test("normal generation is untouched: nothing is pruned when every contract stands", () => {
    const dir = project({
      "src/money/money.contract.ts": CURRENCY,
      "src/orders/orders.contract.ts": KEEPER,
      [DOMAIN_CONTRACT]: CURRENCY_CONCEPT,
    });
    const first = runScaffold(dir);
    expect(first.lines.filter((l) => l.includes("pruned"))).toEqual([]);
    const second = runScaffold(dir);
    expect(second.code).toBe(0);
    expect(second.lines.filter((l) => l.includes("pruned"))).toEqual([]);
    expect(existsSync(join(dir, "src/money/money.ts"))).toBe(true);
    expect(existsSync(join(dir, DOMAIN_LAWS))).toBe(true);
    expect(existsSync(join(dir, "src/orders/orders.ts"))).toBe(true);
    // The shared errors modules carry no marker and must never be swept up.
    expect(existsSync(join(dir, "src/shared/errors.ts"))).toBe(true);
    expect(existsSync(join(dir, "contexts/shop/src/domain/shared/errors.ts"))).toBe(true);
  });

  test("the prune is logged, so a run's own record says what it removed", () => {
    const dir = project({
      "src/money/money.contract.ts": CURRENCY,
      "src/orders/orders.contract.ts": KEEPER,
      [DOMAIN_CONTRACT]: CURRENCY_CONCEPT,
    });
    runScaffold(dir);
    rmSync(join(dir, "src/money/money.contract.ts"));
    rmSync(join(dir, DOMAIN_CONTRACT));
    runScaffold(dir);
    const prune = readGuardLog(dir).filter((e) => e.summary?.includes("orphaned generated file"));
    expect(prune).toHaveLength(1);
    expect(prune[0]).toMatchObject({ guard: "scaffold", verdict: "pass" });
    expect(prune[0].summary).toBe("pruned 2 orphaned generated files");
    expect([...(prune[0].detail as { pruned: string[] }).pruned].sort()).toEqual([DOMAIN_LAWS, "src/money/money.ts"]);
  });

  // -------------------------------------------------------------------------
  // ...and the same marker governs writing. Run r15: a re-freeze ran the
  // scaffold step over two finished arms, and both had their implementations
  // overwritten by throwing skeletons. One survived only because the work
  // happened to be in the index on a `git add -A`; the other rebuilt 28
  // minutes of code. The scaffolder writes a skeleton where there is nothing
  // to lose — an absent file, or another skeleton — and skips anything else
  // out loud.
  // -------------------------------------------------------------------------

  const IMPLEMENTED = `import { NotImplementedError } from "../shared/errors.js";

export type * from "./money.contract.js";

export class Currency {
  private readonly __brand = "Currency" as const;
  private constructor(readonly value: string) {}
  static parse(raw: unknown): Currency | undefined {
    return typeof raw === "string" && /^[A-Z]{3}$/.test(raw) ? new Currency(raw) : undefined;
  }
}

export function normalize(currency: Currency): Currency {
  void NotImplementedError;
  return currency;
}
`;

  test("an implemented file survives a re-scaffold byte-identical", () => {
    const dir = project({
      "src/money/money.contract.ts": CURRENCY,
      "src/orders/orders.contract.ts": KEEPER,
    });
    expect(runScaffold(dir).code).toBe(0);
    writeFileSync(join(dir, "src/money/money.ts"), IMPLEMENTED);

    const r = runScaffold(dir);
    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, "src/money/money.ts"), "utf8")).toBe(IMPLEMENTED);
  });

  // The line has to be loud and greppable: a silent skip is how a stale
  // implementation survives a contract change without anyone noticing, and the
  // remedy — read the type errors, they are yours — belongs in the line itself.
  test("the skip says so, and says where the drift will surface", () => {
    const dir = project({ "src/money/money.contract.ts": CURRENCY });
    expect(runScaffold(dir).code).toBe(0);
    writeFileSync(join(dir, "src/money/money.ts"), IMPLEMENTED);

    expect(runScaffold(dir).lines).toContain(
      "scaffold: kept src/money/money.ts — implemented; contract drift will surface as type errors routed to the builder",
    );
  });

  test("the skip is in the run's own record, not just its output", () => {
    const dir = project({ "src/money/money.contract.ts": CURRENCY });
    runScaffold(dir);
    writeFileSync(join(dir, "src/money/money.ts"), IMPLEMENTED);
    runScaffold(dir);

    const kept = readGuardLog(dir).filter((e) => e.summary?.startsWith("kept "));
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ guard: "scaffold", verdict: "pass" });
    expect(kept[0].summary).toBe("kept src/money/money.ts (implemented)");
    expect(kept[0].detail).toMatchObject({ skeleton: "src/money/money.ts", kept: true });
  });

  // The other half: a file that IS a skeleton has nothing to lose, so a changed
  // contract still regenerates it. Skipping everything would be the same bug
  // with the sign flipped.
  test("a genuine skeleton is still regenerated when the contract changes", () => {
    const dir = project({ "src/money/money.contract.ts": CURRENCY });
    expect(runScaffold(dir).code).toBe(0);
    const before = readFileSync(join(dir, "src/money/money.ts"), "utf8");
    expect(before).toContain("normalize");

    writeFileSync(
      join(dir, "src/money/money.contract.ts"),
      CURRENCY.replace("normalize(currency: Currency)", "rename(currency: Currency)"),
    );
    const r = runScaffold(dir);
    expect(r.code).toBe(0);
    expect(r.lines.some((l) => l.startsWith("scaffold: wrote src/money/money.ts"))).toBe(true);
    const after = readFileSync(join(dir, "src/money/money.ts"), "utf8");
    expect(after).toContain("rename");
    expect(after).not.toContain("normalize");
  });

  // Keeping an implementation must not make it prunable, and must not stop the
  // prune from doing its job elsewhere.
  test("an implemented file is kept while a deleted contract's leftovers are still pruned", () => {
    const dir = project({
      "src/money/money.contract.ts": CURRENCY,
      "src/orders/orders.contract.ts": KEEPER,
    });
    expect(runScaffold(dir).code).toBe(0);
    writeFileSync(join(dir, "src/money/money.ts"), IMPLEMENTED);
    rmSync(join(dir, "src/orders/orders.contract.ts"));

    const r = runScaffold(dir);
    expect(r.code).toBe(0);
    expect(r.lines).toContain("scaffold: pruned src/orders/orders.ts — its contract no longer exists");
    expect(readFileSync(join(dir, "src/money/money.ts"), "utf8")).toBe(IMPLEMENTED);
  });

  // A run that failed part-way has an incomplete picture of what it generated,
  // so it must remove nothing at all.
  test("a scaffold that blocked prunes nothing", () => {
    const dir = project({
      "src/money/money.contract.ts": CURRENCY,
      "src/orders/orders.contract.ts": KEEPER,
    });
    expect(runScaffold(dir).code).toBe(0);
    rmSync(join(dir, "src/money/money.contract.ts"));
    // A contract that cannot be scaffolded at all: the run returns before the sync.
    writeFileSync(join(dir, "src/orders/orders.contract.ts"), "export const runtimeValue = 42;\n");
    const r = runScaffold(dir);
    expect(r.code).toBe(1);
    expect(r.lines.some((l) => l.includes("pruned"))).toBe(false);
    expect(existsSync(join(dir, "src/money/money.ts"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The API-service runtime (TN-26-004): shipped by the sync, never written
// ---------------------------------------------------------------------------

describe("skeletonExtensionFor: the names are contributions, not ts-pack content", () => {
  const COMPONENT_CONTRACT = `import type { ReactElement } from "react";
export declare function StatusCard(props: { readonly label: string }): ReactElement;
`;

  test("with no contributed names, nothing ever scaffolds .tsx (no web pack composed)", () => {
    expect(skeletonExtensionFor(COMPONENT_CONTRACT, new Set())).toBe(".ts");
  });

  test("with the ts-web pack installed (this repo), the same contract answers .tsx", () => {
    expect(skeletonExtensionFor(COMPONENT_CONTRACT)).toBe(".tsx");
  });
});

describe("runScaffold: the service runtime is shipped where a contract points", () => {
  const dirs: string[] = [];
  const project = (files: Record<string, string>, packs = ["ts", "ts-service"]): string => {
    const dir = createTempDir(join(tmpdir(), "scaffold-rt-"));
    writeProjectPacks(dir, packs);
    dirs.push(dir);
    for (const [rel, source] of Object.entries(files)) {
      const path = join(dir, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, source);
    }
    return dir;
  };
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  const API_CONTRACT = `import type { Ack } from "./service-runtime.js";

export interface ServiceCaller {
  ingestReport(raw: unknown): Promise<Ack>;
}
export declare function createServiceCaller(deps: { readonly now: () => string }): ServiceCaller;
`;

  test("a contract importing ./service-runtime.js gets the canonical copy, marker first", () => {
    const dir = project({ "src/api/api.contract.ts": API_CONTRACT });
    const r = runScaffold(dir);
    expect(r.code).toBe(0);
    const rt = join(dir, "src/api/service-runtime.ts");
    expect(existsSync(rt)).toBe(true);
    const source = readFileSync(rt, "utf8");
    expect(isGeneratedArtifact(source)).toBe(true);
    expect(source).toContain("createService");
    expect(source).toContain('code: "BAD_REQUEST"');
    expect(source).toBe(shippedSupportSource(serviceRuntimeSupport));
    expect(r.lines.some((l) => l.includes("service-runtime.ts (API-service runtime"))).toBe(true);
  });

  test("re-running changes nothing; a component that stops being a service loses the copy", () => {
    const dir = project({ "src/api/api.contract.ts": API_CONTRACT });
    expect(runScaffold(dir).code).toBe(0);
    const rt = join(dir, "src/api/service-runtime.ts");
    const first = readFileSync(rt, "utf8");
    const second = runScaffold(dir);
    expect(second.code).toBe(0);
    expect(readFileSync(rt, "utf8")).toBe(first);
    expect(second.lines.some((l) => l.includes("API-service runtime"))).toBe(false); // compare-and-skip

    // The contract stops importing the runtime → the sync prunes the copy.
    writeFileSync(
      join(dir, "src/api/api.contract.ts"),
      'export declare function ping(raw: unknown): "pong";\n',
    );
    expect(runScaffold(dir).code).toBe(0);
    expect(existsSync(rt)).toBe(false);
  });

  test("a contract whose support import escapes src/ is refused and nothing is written outside", () => {
    const escaping = API_CONTRACT.replace('"./service-runtime.js"', '"../../../x/service-runtime.js"');
    const dir = project({ "src/api/api.contract.ts": escaping });
    const r = runScaffold(dir);
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toContain(
      "src/api/api.contract.ts asks for the API-service runtime at '../x/service-runtime.ts', which resolves outside the project's src/",
    );
    expect(existsSync(join(dir, "..", "x", "service-runtime.ts"))).toBe(false);
  });

  test("an unmarked file already at the runtime's path is a block, not a keep", () => {
    const dir = project({
      "src/api/api.contract.ts": API_CONTRACT,
      "src/api/service-runtime.ts": "export const handRolled = true;\n",
    });
    const r = runScaffold(dir);
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toMatch(/does not carry the generated marker/);
    // The hand-written file survives untouched — non-destructive even in refusal.
    expect(readFileSync(join(dir, "src/api/service-runtime.ts"), "utf8")).toBe(
      "export const handRolled = true;\n",
    );
  });

  test("only a project that composed ts-service gets the runtime (ADR 2026-046)", () => {
    for (const packs of [["ts"], ["ts", "ts-web"]]) {
      const dir = project({ "src/api/api.contract.ts": API_CONTRACT }, packs);
      const r = runScaffold(dir);
      expect(r.code).toBe(0);
      expect(existsSync(join(dir, "src/api/service-runtime.ts"))).toBe(false);
      expect(r.lines.some((l) => l.includes("API-service runtime"))).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// TSX: a contract that declares a component scaffolds to a .tsx sibling
// (TN-26-006 A1)
// ---------------------------------------------------------------------------
//
// The skeleton's CONTENT is unchanged — a throw has no JSX — so everything
// below is about the NAME and the sync bookkeeping that follows from it. Both
// halves matter equally: the builder's replacement for a component skeleton is
// full of JSX, which does not parse in a `.ts` file, and the sync must still be
// able to recognise, keep and prune a file it named with the other extension.

const COMPONENT_CONTRACT = `import type { ReactElement } from "react";

export interface BadgeProps {
  readonly tone: "ok" | "warn";
}

export declare function Badge(props: BadgeProps): ReactElement;
`;

const PLAIN_CONTRACT = `export type Id = string & { readonly __brand: "Id" };
export declare function get(id: Id): string;
`;

describe("skeletonExtensionFor (the extension is a function of the contract text)", () => {
  // All three spellings, because a model picks whichever its training favours
  // and the extension may not depend on that choice.
  test.each([
    ["ReactElement", 'import type { ReactElement } from "react";\nexport declare function A(): ReactElement;\n'],
    ["JSX.Element", "export declare function A(): JSX.Element;\n"],
    ["ReactNode", 'import type { ReactNode } from "react";\nexport declare function A(): ReactNode;\n'],
  ])("a contract returning %s is a component", (_name, source) => {
    expect(skeletonExtensionFor(source)).toBe(".tsx");
  });

  test("a component type anywhere on the exported surface counts, not just a return", () => {
    expect(
      skeletonExtensionFor(
        'import type { ReactNode } from "react";\nexport interface Panel { readonly body: ReactNode; }\nexport declare function render(p: Panel): string;\n',
      ),
    ).toBe(".tsx");
  });

  test("an ordinary contract is .ts", () => {
    expect(skeletonExtensionFor(PLAIN_CONTRACT)).toBe(".ts");
    expect(skeletonExtensionFor(contractOf("values"))).toBe(".ts");
    expect(skeletonExtensionFor(contractOf("queue"))).toBe(".ts");
  });

  // The rule reads the EXPORTED surface. A component type mentioned only in a
  // local declaration is not something the builder has to spell in JSX.
  test("an unexported reference does not make the file a component", () => {
    expect(
      skeletonExtensionFor(
        'import type { ReactNode } from "react";\ntype Hidden = ReactNode;\nexport declare function name(): string;\n',
      ),
    ).toBe(".ts");
  });

  // A name that merely CONTAINS one of the three is a different type.
  test("a look-alike name is not a component type", () => {
    expect(
      skeletonExtensionFor('import type { ReactNodeList } from "./x.js";\nexport declare function a(): ReactNodeList;\n'),
    ).toBe(".ts");
  });

  // The extension is decided before scaffoldContract has its say, so a contract
  // it will reject must still get a deterministic answer rather than a throw.
  test("a contract the scaffolder will reject still yields an extension", () => {
    expect(skeletonExtensionFor("export enum Level { Low, High }\n")).toBe(".ts");
  });
});

describe("skeletonPathFor / skeletonSiblingPaths with the contract text", () => {
  test("the source decides the extension; without it the answer is .ts", () => {
    expect(skeletonPathFor("src/ui/badge.contract.ts", COMPONENT_CONTRACT)).toBe("src/ui/badge.tsx");
    expect(skeletonPathFor("src/ui/badge.contract.ts", PLAIN_CONTRACT)).toBe("src/ui/badge.ts");
    expect(skeletonPathFor("src/ui/badge.contract.ts")).toBe("src/ui/badge.ts");
  });

  test("siblings are both legal implementation paths for the same contract", () => {
    expect(skeletonSiblingPaths("src/ui/badge.contract.ts")).toEqual([
      "src/ui/badge.ts",
      "src/ui/badge.tsx",
    ]);
  });

  test("it is still the fixed naming rule — a non-contract path is refused", () => {
    expect(() => skeletonSiblingPaths("src/ui/badge.ts")).toThrowError(/not a \*\.contract\.ts path/);
  });
});

describe("runScaffold writes, keeps and prunes .tsx skeletons", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const project = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), "scaffold-tsx-"));
    dirs.push(dir);
    for (const [rel, source] of Object.entries(files)) {
      const path = join(dir, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, source);
    }
    return dir;
  };

  test("a component contract scaffolds to .tsx, and to nothing else", () => {
    const dir = project({ "src/ui/badge.contract.ts": COMPONENT_CONTRACT });
    const r = runScaffold(dir);
    expect(r.code).toBe(0);
    expect(r.lines).toContain("scaffold: wrote src/ui/badge.tsx");
    const skeleton = readFileSync(join(dir, "src/ui/badge.tsx"), "utf8");
    expect(isGeneratedArtifact(skeleton)).toBe(true);
    expect(skeleton).toContain('throw new NotImplementedError("Badge");');
    // Content generation is untouched — the bytes are exactly what the pure
    // core produces for this contract. Only the file's NAME moved.
    expect(skeleton).toBe(scaffoldContract(COMPONENT_CONTRACT, "src/ui/badge.contract.ts"));
    expect(existsSync(join(dir, "src/ui/badge.ts"))).toBe(false);
  });

  test("a non-component contract still scaffolds to .ts", () => {
    const dir = project({ "src/orders/orders.contract.ts": PLAIN_CONTRACT });
    expect(runScaffold(dir).code).toBe(0);
    expect(existsSync(join(dir, "src/orders/orders.ts"))).toBe(true);
    expect(existsSync(join(dir, "src/orders/orders.tsx"))).toBe(false);
  });

  const IMPLEMENTED_TSX = `import type { BadgeProps } from "./badge.contract.js";

export type * from "./badge.contract.js";

export function Badge(props: BadgeProps): ReactElement {
  return <span className={props.tone}>{props.tone}</span>;
}
`;

  // The r15 overwrite, in its TSX costume: a finished component must survive a
  // re-scaffold byte-identical, exactly as a finished module does.
  test("an implemented .tsx survives a re-scaffold byte-identical", () => {
    const dir = project({ "src/ui/badge.contract.ts": COMPONENT_CONTRACT });
    expect(runScaffold(dir).code).toBe(0);
    writeFileSync(join(dir, "src/ui/badge.tsx"), IMPLEMENTED_TSX);

    const r = runScaffold(dir);
    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, "src/ui/badge.tsx"), "utf8")).toBe(IMPLEMENTED_TSX);
    expect(r.lines).toContain(
      "scaffold: kept src/ui/badge.tsx — implemented; contract drift will surface as type errors routed to the builder",
    );
    const kept = readGuardLog(dir).filter((e) => e.summary?.startsWith("kept "));
    expect(kept.at(-1)?.summary).toBe("kept src/ui/badge.tsx (implemented)");
  });

  // THE CROSS-EXTENSION CLOBBER. A contract that gains a component changes which
  // sibling this run wants — and the other one may already hold finished work.
  // Asking only about the intended path would reopen r15 through an edit that
  // reads as entirely innocent: adding a ReactNode to a return type.
  test("a contract that grows a component does not overwrite the implemented .ts", () => {
    const dir = project({ "src/ui/badge.contract.ts": PLAIN_CONTRACT });
    expect(runScaffold(dir).code).toBe(0);
    const handWritten = 'export type * from "./badge.contract.js";\nexport function get(): string { return "x"; }\n';
    writeFileSync(join(dir, "src/ui/badge.ts"), handWritten);

    writeFileSync(join(dir, "src/ui/badge.contract.ts"), COMPONENT_CONTRACT);
    const r = runScaffold(dir);
    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, "src/ui/badge.ts"), "utf8")).toBe(handWritten);
    expect(existsSync(join(dir, "src/ui/badge.tsx"))).toBe(false);
    expect(r.lines).toContain(
      "scaffold: kept src/ui/badge.ts — implemented; contract drift will surface as type errors routed to the builder",
    );
  });

  test("and the reverse: a contract that stops being a component keeps the implemented .tsx", () => {
    const dir = project({ "src/ui/badge.contract.ts": COMPONENT_CONTRACT });
    expect(runScaffold(dir).code).toBe(0);
    writeFileSync(join(dir, "src/ui/badge.tsx"), IMPLEMENTED_TSX);

    writeFileSync(join(dir, "src/ui/badge.contract.ts"), PLAIN_CONTRACT);
    const r = runScaffold(dir);
    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, "src/ui/badge.tsx"), "utf8")).toBe(IMPLEMENTED_TSX);
    expect(existsSync(join(dir, "src/ui/badge.ts"))).toBe(false);
  });

  // The other half of the sync: a SKELETON at the stale extension has nothing
  // to lose, so the run writes the new one and the prune takes the old one —
  // no special case, the same marker licence as every other orphan.
  test("a stale skeleton at the other extension is regenerated and pruned", () => {
    const dir = project({ "src/ui/badge.contract.ts": PLAIN_CONTRACT });
    expect(runScaffold(dir).code).toBe(0);
    expect(existsSync(join(dir, "src/ui/badge.ts"))).toBe(true);

    writeFileSync(join(dir, "src/ui/badge.contract.ts"), COMPONENT_CONTRACT);
    const r = runScaffold(dir);
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, "src/ui/badge.tsx"))).toBe(true);
    expect(existsSync(join(dir, "src/ui/badge.ts"))).toBe(false);
    expect(r.lines).toContain("scaffold: pruned src/ui/badge.ts — its contract no longer exists");
  });

  // Deleting the contract is the whole gesture for a component too — an
  // extension the prune's walk cannot see is a generated file that leaks
  // forever (r14's ten minutes, one file at a time).
  test("deleting a component contract prunes its .tsx skeleton", () => {
    const dir = project({
      "src/ui/badge.contract.ts": COMPONENT_CONTRACT,
      "src/orders/orders.contract.ts": PLAIN_CONTRACT,
    });
    expect(runScaffold(dir).code).toBe(0);
    expect(existsSync(join(dir, "src/ui/badge.tsx"))).toBe(true);

    rmSync(join(dir, "src/ui/badge.contract.ts"));
    const r = runScaffold(dir);
    expect(r.code).toBe(0);
    expect(r.lines).toContain("scaffold: pruned src/ui/badge.tsx — its contract no longer exists");
    expect(existsSync(join(dir, "src/ui/badge.tsx"))).toBe(false);
    expect(existsSync(join(dir, "src/ui"))).toBe(false);
    expect(existsSync(join(dir, "src/orders/orders.ts"))).toBe(true);
  });

  // The marker is the whole safety argument, and widening the walk to .tsx must
  // not have widened the LICENCE: a hand-written component sitting where a
  // skeleton would sit is somebody's work.
  test("a marker-less .tsx with a skeleton's exact name survives the prune", () => {
    const dir = project({
      "src/ui/badge.contract.ts": COMPONENT_CONTRACT,
      "src/orders/orders.contract.ts": PLAIN_CONTRACT,
    });
    expect(runScaffold(dir).code).toBe(0);
    writeFileSync(join(dir, "src/ui/badge.tsx"), IMPLEMENTED_TSX);
    rmSync(join(dir, "src/ui/badge.contract.ts"));

    const r = runScaffold(dir);
    expect(r.code).toBe(0);
    expect(r.lines.filter((l) => l.includes("pruned"))).toEqual([]);
    expect(readFileSync(join(dir, "src/ui/badge.tsx"), "utf8")).toBe(IMPLEMENTED_TSX);
  });

  test("the sync is idempotent over a component contract", () => {
    const dir = project({ "src/ui/badge.contract.ts": COMPONENT_CONTRACT });
    expect(runScaffold(dir).code).toBe(0);
    const first = readFileSync(join(dir, "src/ui/badge.tsx"), "utf8");
    const again = runScaffold(dir);
    expect(again.code).toBe(0);
    expect(again.lines.filter((l) => l.includes("pruned") || l.includes("removed empty"))).toEqual([]);
    expect(readFileSync(join(dir, "src/ui/badge.tsx"), "utf8")).toBe(first);
  });
});

// Existing fixtures exercise the previously installed language and web rules.
function mkdtempSync(prefix: string): string {
  const dir = createTempDir(prefix);
  writeProjectPacks(dir, ["ts", "ts-web"]);
  return dir;
}

const webComponentNames = new Set(["ReactElement", "ReactNode", "JSX.Element"]);
function skeletonExtensionFor(source: string, names = webComponentNames) {
  return extensionFor(source, names);
}
function skeletonPathFor(path: string, source?: string) {
  return pathFor(path, source, webComponentNames);
}
