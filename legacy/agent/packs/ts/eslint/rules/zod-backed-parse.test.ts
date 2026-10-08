import { afterAll, describe, it } from "vitest";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { zodBackedParse } from "./zod-backed-parse.ts";

// ADR 2026-031: a value object's `static parse` delegates to a zod schema.
// Hand-rolled typeof-chains are the defect; the rule checks the delegation
// exists, and the generated hostile laws check the schema's judgment.

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

const ZOD_BACKED = `import { z } from "zod";
const schema = z.string().regex(/^B-\\d{4}$/);
export class BuildingId {
  private readonly __brand = "BuildingId" as const;
  private constructor(readonly value: string) {}
  static parse(raw: unknown): BuildingId | undefined {
    const r = schema.safeParse(raw);
    return r.success ? new BuildingId(r.data) : undefined;
  }
}`;

const HAND_ROLLED = `export class BuildingId {
  private readonly __brand = "BuildingId" as const;
  private constructor(readonly value: string) {}
  static parse(raw: unknown): BuildingId | undefined {
    if (typeof raw !== "string") return undefined;
    if (!/^B-\\d{4}$/.test(raw)) return undefined;
    return new BuildingId(raw);
  }
}`;

ruleTester.run("zod-backed-parse", zodBackedParse, {
  valid: [
    // THE CORRECT FORM: module-level schema, safeParse delegation.
    ZOD_BACKED,
    // Inline zod use inside parse counts too — the binding is referenced.
    `import { z } from "zod";
export class Fraction {
  private readonly __brand = "Fraction" as const;
  private constructor(readonly value: number) {}
  static parse(raw: unknown): Fraction | undefined {
    const r = z.number().min(0).max(1).safeParse(raw);
    return r.success ? new Fraction(r.data) : undefined;
  }
}`,
    // Not a value object (no __brand): whatever its parse does, not this rule's business.
    `export class Config {
  static parse(raw: unknown): Config | undefined {
    return typeof raw === "object" && raw !== null ? new Config() : undefined;
  }
}`,
    // A value object with no parse body to inspect (declaration files are the
    // purity gate's concern, not this rule's).
    `import { z } from "zod";
export class Marker {
  private readonly __brand = "Marker" as const;
}`,
  ],
  invalid: [
    {
      code: HAND_ROLLED,
      errors: [{ messageId: "handRolled", data: { className: "BuildingId" } }],
    },
    // Importing zod without using it in parse is still hand-rolled.
    {
      code: `import { z } from "zod";
const unused = z.string();
export class MeterId {
  private readonly __brand = "MeterId" as const;
  private constructor(readonly value: string) {}
  static parse(raw: unknown): MeterId | undefined {
    if (typeof raw !== "string") return undefined;
    return new MeterId(raw);
  }
}`,
      errors: [{ messageId: "handRolled", data: { className: "MeterId" } }],
    },
  ],
});
