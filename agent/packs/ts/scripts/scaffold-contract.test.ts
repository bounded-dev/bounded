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
  implementationSpecifierFor,
  isGeneratedArtifact,
  scaffoldContract,
  runScaffold,
  skeletonExtensionFor as extensionFor,
  skeletonPathFor as pathFor,
  skeletonSiblingPaths,
  shippedSupportSource,
} from "./scaffold-contract.ts";
import { serviceRuntimeSupport } from "../../ts-service/service-runtime-support.ts";
import { lawsPathFor, valueObjectLawsSource } from "./value-object-laws.ts";
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

const MONEY_CONTRACT = "export interface Money {\n  cents: number;\n  currency: string;\n}\n";
// Cross-component types are imported from the IMPLEMENTATION module, never from
// the sibling contract (ADR 2026-023) — so the fixture needs the module that
// re-exports them, exactly as the scaffolder would have written it.
const MONEY_MODULE = scaffoldContract(MONEY_CONTRACT, "shared/money.contract.ts");

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
        "shared/money.ts": MONEY_MODULE,
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
// ONE CLASS IDENTITY PER VALUE OBJECT (ADR 2026-023)
// ---------------------------------------------------------------------------
//
// THE r15 FAILURE, in one arm's own words: "red-phase typecheck is unsatisfiable
// for contracts whose operation signatures carry branded value objects
// constructed from a sibling implementation module." It cost ~44 of 76 live
// minutes — 41 type errors in the shadow red, all of them "separate
// declarations of a private property '__brand'", and an architect inventing
// eight `parse*` boundary functions and re-freezing mid-loop to make red
// satisfiable at all.
//
// The mechanism is not subtle once seen. `values.contract.ts` declares the
// nominal class (ADR 2026-015); the scaffolder turns it into the RUNTIME class
// in `values.ts`. Those are two declarations of the same private `__brand`, and
// TypeScript treats two such declarations as unrelated types. Any other
// contract that reaches for `Money` through `values.contract.js` therefore
// declares operations over a type NOTHING can produce: `Money.parse` — the only
// legal door in — returns the other one.
//
// The fix is that the second declaration must never be reachable: cross-
// component types are imported from the IMPLEMENTATION module, which
// re-exports every type its contract declares and shadows the ambient class
// with the real one. This block is the spec.

const VO_CONTRACT = `/** Money: minor units of a single currency. */
export declare class Money {
  private readonly __brand: "Money";
  private constructor();
  readonly cents: number;
  static parse(raw: unknown): Money | undefined;
  equals(other: Money): boolean;
}
`;

/** The consuming contract, written the one-identity way. */
const OP_CONTRACT = `import type { Money } from "../values/values.js";

export interface Receipt {
  readonly total: Money;
}

export declare function charge(amount: Money): Receipt;
`;

/** The r15 shape: the value object reached through the sibling CONTRACT. */
const OP_CONTRACT_VIA_CONTRACT = OP_CONTRACT.replace(
  '"../values/values.js"',
  '"../values/values.contract.js"',
);

/** What the test-writer writes at red: build the value through the only legal
 *  route — the runtime class — and hand it to the operation. */
const CONSUMER_TEST = `import { describe, expect, test } from "vitest";
import { Money } from "../src/values/values.js";
import { charge } from "../src/billing/billing.js";
import type { Receipt } from "../src/billing/billing.js";

describe("charge", () => {
  test("accepts a Money built through the runtime class", () => {
    const amount = Money.parse(500);
    if (amount === undefined) throw new Error("unparseable");
    const receipt: Receipt = charge(amount);
    const total: Money = receipt.total;
    expect(total).toBe(amount);
  });
});
`;

/** vitest is not installed in the throwaway project, and \`types: []\` means
 *  nothing ambient is present either. The consumer test uses three names. */
const VITEST_STUB = `declare module "vitest" {
  export function describe(name: string, fn: () => void): void;
  export function test(name: string, fn: () => void): void;
  export function expect(actual: unknown): { toBe(expected: unknown): void };
}
`;

function twoContractProject(opContract: string, opSkeleton?: string): Record<string, string> {
  return {
    "src/values/values.contract.ts": VO_CONTRACT,
    "src/values/values.ts": scaffoldContract(VO_CONTRACT, "src/values/values.contract.ts"),
    "src/billing/billing.contract.ts": opContract,
    "src/billing/billing.ts":
      opSkeleton ?? scaffoldContract(opContract, "src/billing/billing.contract.ts"),
    "src/shared/errors.ts": ERRORS_MODULE_SOURCE,
    "tests/charge.test.ts": CONSUMER_TEST,
    "tests/vitest.d.ts": VITEST_STUB,
  };
}

describe("one class identity per value object", () => {
  // The spec, stated positively: a red phase over this project is SATISFIABLE.
  // Everything throws NotImplementedError and nothing fails to compile, which
  // is exactly the state the red gate demands and r15 could not reach.
  test("scaffolded project + a consumer test typecheck clean before anything is implemented", () => {
    expect(typecheck(twoContractProject(OP_CONTRACT))).toEqual([]);
  });

  // The mechanism itself, pinned. If this ever stops reproducing, the compiler
  // changed and the rule below can be revisited — until then it is why the
  // rule exists.
  test("reaching the value object through the sibling contract is a second identity", () => {
    const skeleton = scaffoldContract(OP_CONTRACT, "src/billing/billing.contract.ts").replace(
      '"../values/values.js"',
      '"../values/values.contract.js"',
    );
    const diags = typecheck(twoContractProject(OP_CONTRACT_VIA_CONTRACT, skeleton)).join("\n");
    expect(diags).toMatch(/separate declarations of a private property '__brand'/);
  });

  // ...which is why the generator refuses to produce that project at all. The
  // architect fixes the contract, never the skeleton — and the message carries
  // the replacement line, because "import it from somewhere else" is not a fix.
  test("the scaffolder refuses such a contract, naming the import that fixes it", () => {
    const run = (): string =>
      scaffoldContract(OP_CONTRACT_VIA_CONTRACT, "src/billing/billing.contract.ts");
    expect(run).toThrowError(ScaffoldError);
    expect(run).toThrowError(/separate declarations of a private property '__brand'/);
    expect(run).toThrowError(/import type \{ Money \} from "\.\.\/values\/values\.js";/);
  });

  // The same laundering one level out: re-exporting another contract's types
  // puts the ambient declaration back on this contract's surface.
  test("re-exporting from a sibling contract is refused too", () => {
    const source = 'export type * from "../values/values.contract.js";\nexport declare function f(): void;\n';
    const run = (): string => scaffoldContract(source, "src/billing/billing.contract.ts");
    expect(run).toThrowError(ScaffoldError);
    expect(run).toThrowError(/export type … from "\.\.\/values\/values\.js";/);
  });

  test("implementationSpecifierFor maps a contract module to its sibling, and leaves others alone", () => {
    expect(implementationSpecifierFor("../values/values.contract.js")).toBe("../values/values.js");
    expect(implementationSpecifierFor("./money.contract")).toBe("./money");
    expect(implementationSpecifierFor("../values/values.js")).toBeUndefined();
    expect(implementationSpecifierFor("node:crypto")).toBeUndefined();
    expect(implementationSpecifierFor("zod")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// VALUE OBJECTS LIVE IN THEIR OWN CONTRACT FILE (ADR 2026-026)
// ---------------------------------------------------------------------------
//
// ADR 2026-023 (above) refuses reaching a value object through a sibling
// CONTRACT, forcing cross-file references through the implementation module —
// which is why multi-file designs typecheck. Its SAME-FILE twin, uncovered until
// dogfood r18/r19: when a value export's signature references a nominal
// value-object class declared IN THE SAME contract, the scaffolder emits that
// class as a RUNTIME class. The export's local signature then binds the value
// object to the runtime identity, while the compile-time conformance check
// compares it against `typeof __Contract` — the contract's AMBIENT `declare
// class`. Two declarations of the same private `__brand`, and the skeleton does
// not compile. The contract is purity-clean and freezes, yet scaffolds to code
// that cannot compile.
//
// The enforcement lives one gate EARLIER, as the `value-objects-own-contract`
// contract-purity lint rule (ADR 2026-026): a contract file may not declare a
// value object beside an interface / type-alias / operation that references it.
// These two tests pin the two ends the rule steers between — the shape it
// forbids really does scaffold to non-compiling code, and the decomposed shape
// it steers toward scaffolds and typechecks clean.

// The forbidden shape, as the generator WOULD emit it for a same-file value
// object referenced directly by an operation: it fails to compile with the
// __brand clash. This is the evidence behind the lint rule.
const SAME_FILE_CONTRACT = `/** BuildingId: a branded identifier. */
export declare class BuildingId {
  private readonly __brand: "BuildingId";
  private constructor();
  readonly value: string;
  static parse(raw: unknown): BuildingId | undefined;
}

export declare function rateBuildingReport(building: BuildingId): number;
`;
const SAME_FILE_SKELETON = `import type * as __Contract from "./report.contract.js";

export type * from "./report.contract.js";

export class BuildingId {
  private declare readonly __brand: "BuildingId";
  private constructor() { throw new Error(); }
  declare readonly value: string;
  static parse(raw: unknown): BuildingId | undefined { throw new Error(); }
}

export function rateBuildingReport(building: BuildingId): number { throw new Error(); }

const __conformance: Pick<typeof __Contract, "rateBuildingReport"> = { rateBuildingReport };
void __conformance;
`;

describe("value objects and the operations over them live in separate contracts (ADR 2026-026)", () => {
  // WHY the lint rule exists: the same-file shape scaffolds to code TypeScript
  // rejects with the __brand clash. (The lint rule at contract_purity stops it
  // before it ever reaches this skeleton.)
  test("a same-file value object referenced by an operation scaffolds to non-compiling code", () => {
    const diags = typecheck({
      "report.contract.ts": SAME_FILE_CONTRACT,
      "report.ts": SAME_FILE_SKELETON,
    }).join("\n");
    expect(diags).toMatch(/separate declarations of a private property '__brand'/);
  });

  // THE POSITIVE CASE, decomposed — the shape the rule steers toward. The value
  // object in its own contract, the operation contract importing it from the
  // IMPLEMENTATION module: one class identity, and the whole project scaffolds
  // and typechecks clean before anything is implemented.
  const DECOMPOSED_VO = `/** BuildingId: a branded identifier. */
export declare class BuildingId {
  private readonly __brand: "BuildingId";
  private constructor();
  readonly value: string;
  static parse(raw: unknown): BuildingId | undefined;
}
`;
  const DECOMPOSED_OP = `import type { BuildingId } from "../ids/ids.js";

export declare function rateBuildingReport(building: BuildingId): number;
`;

  test("the decomposed equivalent (value object in its own contract) scaffolds and typechecks clean", () => {
    expect(
      typecheck({
        "src/ids/ids.contract.ts": DECOMPOSED_VO,
        "src/ids/ids.ts": scaffoldContract(DECOMPOSED_VO, "src/ids/ids.contract.ts"),
        "src/report/report.contract.ts": DECOMPOSED_OP,
        "src/report/report.ts": scaffoldContract(DECOMPOSED_OP, "src/report/report.contract.ts"),
        "src/shared/errors.ts": ERRORS_MODULE_SOURCE,
      }),
    ).toEqual([]);
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

  // Both generators must keep emitting the marker the sync recognises. If one
  // ever stopped, the sync would quietly leak that generator's output forever
  // — the failure would be invisible, so it is pinned here rather than trusted.
  test("every generated file this pack writes carries the marker the sync looks for", () => {
    expect(isGeneratedArtifact(scaffoldContract(CURRENCY, "src/money/money.contract.ts"))).toBe(true);
    expect(isGeneratedArtifact(valueObjectLawsSource(CURRENCY, "src/money/money.contract.ts"))).toBe(true);
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

  test("deleting a contract removes its skeleton and its law suite on the next run", () => {
    const dir = project({
      "src/money/money.contract.ts": CURRENCY,
      "src/orders/orders.contract.ts": KEEPER,
    });
    expect(runScaffold(dir).code).toBe(0);
    const skeleton = join(dir, "src/money/money.ts");
    const laws = join(dir, lawsPathFor("src/money/money.contract.ts"));
    expect(existsSync(skeleton)).toBe(true);
    expect(existsSync(laws)).toBe(true);

    rmSync(join(dir, "src/money/money.contract.ts"));
    const r = runScaffold(dir);
    expect(r.code).toBe(0);
    expect(r.lines).toContain("scaffold: pruned src/money/money.ts — its contract no longer exists");
    expect(r.lines).toContain(
      "scaffold: pruned tests/generated/money.laws.test.ts — its contract no longer exists",
    );
    expect(existsSync(skeleton)).toBe(false);
    expect(existsSync(laws)).toBe(false);
    // The surviving contract's own skeleton is untouched.
    expect(existsSync(join(dir, "src/orders/orders.ts"))).toBe(true);
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
    expect(r.lines).toContain("scaffold: removed empty directory tests/generated");
    expect(existsSync(join(dir, "src/money"))).toBe(false);
    expect(existsSync(join(dir, "tests"))).toBe(false);
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
    writeFileSync(join(dir, lawsPathFor("src/money/money.contract.ts")), handWritten);
    rmSync(join(dir, "src/money/money.contract.ts"));

    const r = runScaffold(dir);
    expect(r.code).toBe(0);
    expect(r.lines.filter((l) => l.includes("pruned"))).toEqual([]);
    expect(readFileSync(join(dir, "src/money/money.ts"), "utf8")).toBe(handWritten);
    expect(readFileSync(join(dir, lawsPathFor("src/money/money.contract.ts")), "utf8")).toBe(handWritten);
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
    });
    const first = runScaffold(dir);
    expect(first.lines.filter((l) => l.includes("pruned"))).toEqual([]);
    const second = runScaffold(dir);
    expect(second.code).toBe(0);
    expect(second.lines.filter((l) => l.includes("pruned"))).toEqual([]);
    expect(existsSync(join(dir, "src/money/money.ts"))).toBe(true);
    expect(existsSync(join(dir, lawsPathFor("src/money/money.contract.ts")))).toBe(true);
    expect(existsSync(join(dir, "src/orders/orders.ts"))).toBe(true);
    // The shared errors module carries no marker and must never be swept up.
    expect(existsSync(join(dir, "src/shared/errors.ts"))).toBe(true);
  });

  test("the prune is logged, so a run's own record says what it removed", () => {
    const dir = project({
      "src/money/money.contract.ts": CURRENCY,
      "src/orders/orders.contract.ts": KEEPER,
    });
    runScaffold(dir);
    rmSync(join(dir, "src/money/money.contract.ts"));
    runScaffold(dir);
    const prune = readGuardLog(dir).filter((e) => e.summary?.includes("orphaned generated file"));
    expect(prune).toHaveLength(1);
    expect(prune[0]).toMatchObject({ guard: "scaffold", verdict: "pass" });
    expect(prune[0].summary).toBe("pruned 2 orphaned generated files");
    expect((prune[0].detail as { pruned: string[] }).pruned).toEqual([
      "src/money/money.ts",
      "tests/generated/money.laws.test.ts",
    ]);
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
    // Its law suite is a generated file and still belongs to the live contract.
    expect(existsSync(join(dir, lawsPathFor("src/money/money.contract.ts")))).toBe(true);
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
import type { IngestReportCommand } from "./commands.js";

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
