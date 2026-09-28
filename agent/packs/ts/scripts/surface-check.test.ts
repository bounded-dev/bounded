import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { checkProjectSurfaces, compareSurfaces } from "./surface-check.ts";
import type { SurfaceViolation } from "./surface-check.ts";

// --- fixtures ------------------------------------------------------------------

/** The canonical nominal value-object contract (ts-contract-authoring style). */
const CONTRACT = `
/** ISO-4217 alphabetic code: exactly three uppercase letters. */
export declare class Currency {
  private readonly __brand: "Currency";
  private constructor();
  readonly code: string;
  static parse(raw: unknown): Currency | undefined;
  equals(other: Currency): boolean;
}
`;

/** A conforming implementation, formatted differently on purpose. */
const IMPL = `
export type * from "./money.contract.js";

export class Currency {
  private declare readonly __brand: "Currency";
  readonly code: string;
  private constructor(code: string) {
    this.code = code;
  }
  static parse(raw: unknown): Currency | undefined {
    return undefined;
  }
  equals(other: Currency): boolean {
    return this.code === other.code;
  }
}
`;

function compare(contractSource: string, implSource: string): SurfaceViolation[] {
  return compareSurfaces(contractSource, "src/shared/money.contract.ts", implSource, "src/shared/money.ts");
}

// --- classes: matching surfaces -------------------------------------------------

describe("matching surfaces", () => {
  test("a conforming implementation passes", () => {
    expect(compare(CONTRACT, IMPL)).toEqual([]);
  });

  test("reordered members, comments and formatting do not matter", () => {
    const reordered = `
export type * from "./money.contract.js";
export class Currency {
  /* the brand last, the methods first — order is not surface */
  equals(other: Currency): boolean { return this.code === other.code; }
  static parse(raw: unknown): Currency   |   undefined { return undefined; } // trailing comment
  private constructor(code: string) { this.code = code; }
  readonly code: string;
  private declare readonly __brand: "Currency";
}
`;
    expect(compare(CONTRACT, reordered)).toEqual([]);
  });

  test("parameter names are not surface", () => {
    const renamed = IMPL.replace("equals(other: Currency)", "equals(candidate: Currency)");
    expect(compare(CONTRACT, renamed)).toEqual([]);
  });

  test("an extra PRIVATE member is implementation detail, not a violation", () => {
    const withPrivates = IMPL.replace(
      "static parse",
      `private normalize(raw: string): string { return raw.trim(); }
  private static cache: Map<string, Currency> = new Map();
  static parse`,
    );
    expect(compare(CONTRACT, withPrivates)).toEqual([]);
  });

  test("a parameter property satisfies a contract property (the flattened form)", () => {
    const contract = `
export declare class Point {
  readonly x: number;
  constructor(x: number);
}
`;
    const impl = `
export class Point {
  constructor(readonly x: number) {}
}
`;
    expect(compareSurfaces(contract, "src/geo/point.contract.ts", impl, "src/geo/point.ts")).toEqual([]);
  });
});

// --- classes: nominality degradations -------------------------------------------

describe("nominality", () => {
  test("dropping the private __brand is flagged", () => {
    const dropped = IMPL.replace(`private declare readonly __brand: "Currency";`, "");
    const violations = compare(CONTRACT, dropped);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ exportName: "Currency", member: "__brand", kind: "missing-member" });
    expect(violations[0]?.message).toContain("nominality");
  });

  test("changing the brand's literal type is flagged", () => {
    const retyped = IMPL.replace(`__brand: "Currency"`, `__brand: string`);
    const violations = compare(CONTRACT, retyped);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ exportName: "Currency", member: "__brand", kind: "member-mismatch" });
  });

  test("making the constructor public is flagged", () => {
    const opened = IMPL.replace("private constructor", "constructor");
    const violations = compare(CONTRACT, opened);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ exportName: "Currency", member: "constructor", kind: "member-mismatch" });
    expect(violations[0]?.message).toContain("make it private");
  });

  test("writing no constructor at all (implicit public) is flagged", () => {
    const none = IMPL.replace(/private constructor\(code: string\) \{\s*this\.code = code;\s*\}/, "");
    const violations = compare(CONTRACT, none);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ member: "constructor", kind: "missing-member" });
  });

  test("the private constructor's PARAMETERS are implementation detail", () => {
    // The contract's `private constructor();` vs the implementation's
    // `private constructor(code: string)` — private surface is invisible.
    expect(compare(CONTRACT, IMPL)).toEqual([]);
  });
});

// --- classes: drift and extras --------------------------------------------------

describe("drift", () => {
  test("a changed return type is flagged", () => {
    const changed = IMPL.replace("equals(other: Currency): boolean", "equals(other: Currency): number");
    const violations = compare(CONTRACT, changed);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ exportName: "Currency", member: "equals", kind: "member-mismatch" });
    expect(violations[0]?.message).toContain("exactly as the contract declares it");
  });

  test("a changed parameter type is flagged", () => {
    const changed = IMPL.replace("static parse(raw: unknown)", "static parse(raw: string)");
    const violations = compare(CONTRACT, changed);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ member: "parse", kind: "member-mismatch" });
  });

  test("dropping readonly from a public property is flagged", () => {
    const mutable = IMPL.replace("readonly code: string;", "code: string;");
    const violations = compare(CONTRACT, mutable);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ member: "code", kind: "member-mismatch" });
    expect(violations[0]?.message).toContain("readonly");
  });

  test("an undeclared public static method is flagged (the Money.signed case)", () => {
    const signed = IMPL.replace(
      "equals(other: Currency)",
      `static signed(code: string): Currency | undefined { return Currency.parse(code); }
  equals(other: Currency)`,
    );
    const violations = compare(CONTRACT, signed);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ exportName: "Currency", member: "signed", kind: "undeclared-member" });
    expect(violations[0]?.message).toContain("undeclared public surface");
    expect(violations[0]?.message).toContain("CONTRACT-DISPUTE");
  });

  test("a missing contract export is flagged", () => {
    const violations = compare(CONTRACT, `export type * from "./money.contract.js";`);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ exportName: "Currency", kind: "missing-export" });
  });

  test("an undeclared public export is flagged, re-exports included", () => {
    const widened = `${IMPL}
export const CURRENCY_PATTERN: RegExp = /^[A-Z]{3}$/;
export { Money } from "../shared/money.js";
`;
    const violations = compare(CONTRACT, widened);
    expect(violations).toHaveLength(2);
    expect(violations.map((v) => v.exportName).sort()).toEqual(["CURRENCY_PATTERN", "Money"]);
    for (const v of violations) {
      expect(v.kind).toBe("undeclared-export");
      expect(v.message).toContain("undeclared public surface");
    }
  });
});

// --- type-only exports ----------------------------------------------------------

describe("type-only exports", () => {
  const typedContract = `
export interface Plan {
  readonly name: string;
}
export type Interval = "monthly" | "yearly";
export declare function pick(plans: readonly Plan[]): Plan | undefined;
`;
  const fn = `export function pick(plans: readonly Plan[]): Plan | undefined { return plans[0]; }`;

  test("the type-star re-export satisfies every contract interface and alias", () => {
    const impl = `
export type * from "./billing.contract.js";
import type { Plan } from "./billing.contract.js";
${fn}
`;
    expect(compareSurfaces(typedContract, "src/billing.contract.ts", impl, "src/billing.ts")).toEqual([]);
  });

  test("a local declaration of the name also satisfies it", () => {
    const impl = `
export interface Plan {
  readonly name: string;
}
export type Interval = "monthly" | "yearly";
${fn}
`;
    expect(compareSurfaces(typedContract, "src/billing.contract.ts", impl, "src/billing.ts")).toEqual([]);
  });

  test("no re-export and no local declaration is flagged, naming the one-line fix", () => {
    const impl = `
import type { Plan } from "./billing.contract.js";
${fn}
`;
    const violations = compareSurfaces(typedContract, "src/billing.contract.ts", impl, "src/billing.ts");
    expect(violations).toHaveLength(2);
    expect(violations.map((v) => v.exportName).sort()).toEqual(["Interval", "Plan"]);
    for (const v of violations) {
      expect(v.kind).toBe("missing-type-reexport");
      expect(v.message).toContain(`export type * from "./billing.contract.js";`);
    }
  });

  // r15 (dogfood): the contract re-exported `BillingInterval` (a string-literal
  // union) and `BillingPeriod` (an interface) from a sibling contract, the
  // implementation re-exported both type-only — and the gate demanded a runtime
  // value export: "export the value (drop the `type` keyword)". Impossible by
  // construction, and it cost one arm 4m19 and three contradictory worker
  // bounces. A contract's TYPE-only declarations are satisfied type-only;
  // only VALUE declarations need a reachable runtime export.
  describe("a contract that re-exports its types (r15)", () => {
    const contract = `
export type { BillingInterval, BillingPeriod } from "./billing-primitives.contract.js";

export declare class Subscription {
  private readonly __brand: "Subscription";
  private constructor();
  static parse(raw: unknown): Subscription | undefined;
}

export declare function renew(current: Subscription, interval: BillingInterval): Subscription;
`;
    const values = `
export class Subscription {
  private declare readonly __brand: "Subscription";
  private constructor() {}
  static parse(raw: unknown): Subscription | undefined { return undefined; }
}

export function renew(current: Subscription, interval: BillingInterval): Subscription { return current; }
`;
    const compareBilling = (impl: string): SurfaceViolation[] =>
      compareSurfaces(contract, "src/billing/subscription.contract.ts", impl, "src/billing/subscription.ts");

    test("type-only re-exports of the types + value exports of the class and function PASS", () => {
      const impl = `
export type { BillingInterval, BillingPeriod } from "./billing-primitives.contract.js";
${values}`;
      expect(compareBilling(impl)).toEqual([]);
    });

    test("the type-star re-export satisfies the contract's own type re-exports too", () => {
      const impl = `
export type * from "./subscription.contract.js";
${values}`;
      expect(compareBilling(impl)).toEqual([]);
    });

    test("a MISSING class value export still FAILS", () => {
      const impl = `
export type { BillingInterval, BillingPeriod } from "./billing-primitives.contract.js";

export function renew(current: Subscription, interval: BillingInterval): Subscription { return current; }
`;
      const violations = compareBilling(impl);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ exportName: "Subscription", kind: "missing-export" });
    });

    test("a class re-exported TYPE-ONLY still FAILS — a value erased at runtime", () => {
      const impl = `
export type { BillingInterval, BillingPeriod } from "./billing-primitives.contract.js";
export type { Subscription } from "./subscription.contract.js";

export function renew(current: Subscription, interval: BillingInterval): Subscription { return current; }
`;
      const violations = compareBilling(impl);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ exportName: "Subscription", kind: "export-kind-mismatch" });
      expect(violations[0]!.message).toContain("export the value");
    });

    test("a re-exported type the implementation drops is flagged as a type, not a value", () => {
      const impl = `
export type { BillingInterval } from "./billing-primitives.contract.js";
${values}`;
      const violations = compareBilling(impl);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ exportName: "BillingPeriod", kind: "missing-type-reexport" });
      expect(violations[0]!.message).toContain("the contract declares type 'BillingPeriod'");
      expect(violations[0]!.message).not.toContain("export the value");
    });
  });

  test("a changed function signature is flagged", () => {
    const impl = `
export type * from "./billing.contract.js";
export function pick(plans: Plan[]): Plan | undefined { return plans[0]; }
`;
    const violations = compareSurfaces(typedContract, "src/billing.contract.ts", impl, "src/billing.ts");
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ exportName: "pick", kind: "export-type-mismatch" });
  });
});

// --- checkProjectSurfaces (IO wrapper) ------------------------------------------

describe("checkProjectSurfaces", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function projectWith(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "surface-check-"));
    roots.push(root);
    for (const [rel, source] of Object.entries(files)) {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), source, "utf8");
    }
    return root;
  }

  test("a clean pair exits 0", () => {
    const root = projectWith({
      "src/shared/money.contract.ts": CONTRACT,
      "src/shared/money.ts": IMPL,
    });
    const run = checkProjectSurfaces(root);
    expect(run.code).toBe(0);
    expect(run.violations).toEqual([]);
    expect(run.lines).toEqual(["surface-check: OK (1 contract pair)"]);
  });

  test("a violation exits 1 with one greppable line per violation", () => {
    const root = projectWith({
      "src/shared/money.contract.ts": CONTRACT,
      "src/shared/money.ts": IMPL.replace("private constructor", "constructor"),
    });
    const run = checkProjectSurfaces(root);
    expect(run.code).toBe(1);
    expect(run.violations).toHaveLength(1);
    expect(run.lines.filter((l) => l.startsWith("surface-check: FAIL src/shared/money.ts"))).toHaveLength(1);
  });

  test("a contract with no implementation sibling is misuse (exit 2)", () => {
    const root = projectWith({ "src/shared/money.contract.ts": CONTRACT });
    const run = checkProjectSurfaces(root);
    expect(run.code).toBe(2);
    expect(run.lines[0]).toContain("no implementation sibling src/shared/money.ts");
  });

  test("no contracts at all is misuse (exit 2) — silence is not success", () => {
    const root = projectWith({ "src/index.ts": "export {};" });
    expect(checkProjectSurfaces(root).code).toBe(2);
  });

  // --- TSX (TN-26-006 A1) ----------------------------------------------------
  //
  // A contract that declares a component is implemented by a `.tsx` sibling, so
  // the pairing has to accept either extension. Two ways this could go wrong and
  // both are silent: calling every component in the tree "missing" (exit 2 on a
  // correct project), or parsing the component as `.ts`, where `<span …>` is a
  // type assertion rather than JSX and the wreckage has whatever surface
  // survived — a pass over a file nobody read.

  const COMPONENT_CONTRACT = `import type { ReactElement } from "react";

export interface BadgeProps {
  readonly tone: "ok" | "warn";
}

export declare function Badge(props: BadgeProps): ReactElement;
`;

  const COMPONENT_IMPL = `import type { ReactElement } from "react";
import type { BadgeProps } from "./badge.contract.js";

export type * from "./badge.contract.js";

export function Badge(props: BadgeProps): ReactElement {
  return <span className={props.tone}>{props.tone}</span>;
}
`;

  test("a contract paired with a .tsx implementation is a clean pair", () => {
    const root = projectWith({
      "src/ui/badge.contract.ts": COMPONENT_CONTRACT,
      "src/ui/badge.tsx": COMPONENT_IMPL,
    });
    const run = checkProjectSurfaces(root);
    expect(run.code).toBe(0);
    expect(run.lines).toEqual(["surface-check: OK (1 contract pair)"]);
  });

  test("and it is still a real comparison: undeclared public surface in a .tsx is caught", () => {
    const root = projectWith({
      "src/ui/badge.contract.ts": COMPONENT_CONTRACT,
      "src/ui/badge.tsx":
        COMPONENT_IMPL + "\nexport function Debug(): string {\n  return \"secret\";\n}\n",
    });
    const run = checkProjectSurfaces(root);
    expect(run.code).toBe(1);
    expect(run.lines.join("\n")).toContain("src/ui/badge.tsx");
    expect(run.lines.join("\n")).toMatch(/Debug/);
  });

  test("neither sibling present names both spellings", () => {
    const root = projectWith({ "src/ui/badge.contract.ts": COMPONENT_CONTRACT });
    const run = checkProjectSurfaces(root);
    expect(run.code).toBe(2);
    expect(run.lines[0]).toContain("src/ui/badge.ts or src/ui/badge.tsx");
  });

  // The architect's scratch zone (Fix 4): surface-check is rooted at src/, so a
  // top-level scratch/*.contract.ts is invisible to it — a probe never counts
  // as a contract pair, and a project whose only contract lives in scratch/ has
  // no surface to check.
  test("a scratch/*.contract.ts is not a surface pair", () => {
    const root = projectWith({
      "src/shared/money.contract.ts": CONTRACT,
      "src/shared/money.ts": IMPL,
      "scratch/probe.contract.ts": CONTRACT,
    });
    const run = checkProjectSurfaces(root);
    expect(run.code).toBe(0);
    expect(run.lines).toEqual(["surface-check: OK (1 contract pair)"]);
  });
});

describe("a typeof alias declares an inferred implementation value", () => {
  const IMPL_ROUTER = `export type * from "./api.contract.js";\nexport const router = { ping: () => "pong" };\n`;
  const undeclared = (contract: string) =>
    compareSurfaces(contract, "src/api.contract.ts", IMPL_ROUTER, "src/api.ts")
      .filter((v) => v.kind === "undeclared-export").map((v) => v.exportName);

  test("an exported alias over a type-only import from the sibling declares the const", () => {
    expect(undeclared(`import type { router } from "./api.js";\nexport type Router = typeof router;\n`)).toEqual([]);
    expect(undeclared(`import { type router as r } from "./api.js";\nexport type Router = typeof r;\n`)).toEqual([]);
  });

  test("a value import does not declare it", () => {
    expect(undeclared(`import { router } from "./api.js";\nexport type Router = typeof router;\n`)).toEqual(["router"]);
  });

  test("an unexported alias does not declare it", () => {
    expect(undeclared(`import type { router } from "./api.js";\ntype Router = typeof router;\nexport interface Api { r: Router }\n`))
      .toEqual(["router"]);
  });

  test("a type-only import from another module does not declare it", () => {
    expect(undeclared(`import type { router } from "./other.js";\nexport type Router = typeof router;\n`)).toEqual(["router"]);
  });
});
