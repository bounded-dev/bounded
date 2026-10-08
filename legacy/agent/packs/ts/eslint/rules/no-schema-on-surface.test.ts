import { afterAll, describe, it } from "vitest";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { noSchemaOnSurface } from "./no-schema-on-surface.ts";

// TN-26-004 / ADR 2026-031: zod is the engine inside a value object, never a
// public identity — nothing from zod may appear in a contract at all. The
// contract declares `parse(raw: unknown): T | undefined`; the schema stays in
// the implementation module.

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-schema-on-surface", noSchemaOnSurface, {
  valid: [
    // THE CORRECT FORM: the parse door, engine invisible.
    `export declare class BuildingId {
  private readonly __brand: "BuildingId";
  private constructor();
  readonly value: string;
  static parse(raw: unknown): BuildingId | undefined;
}`,
    // Implementation-module imports are the sanctioned route for types.
    `import type { BuildingId } from "./values.js";
export declare function rate(id: BuildingId): BuildingId;`,
  ],
  invalid: [
    {
      code: `import { z } from "zod";
export declare const schema: typeof z;`,
      errors: [{ messageId: "zodImport", data: { source: "zod" } }],
    },
    // Type-only imports are the same identity leak.
    {
      code: `import type { ZodType } from "zod";
export declare function check(t: ZodType): boolean;`,
      errors: [{ messageId: "zodImport", data: { source: "zod" } }],
    },
    // Subpath imports too.
    {
      code: `import type { ZodIssue } from "zod/v4";
export declare function issues(): ZodIssue[];`,
      errors: [{ messageId: "zodImport", data: { source: "zod/v4" } }],
    },
    // Re-exporting launders the engine onto the surface.
    {
      code: `export type { ZodType } from "zod";`,
      errors: [{ messageId: "zodReexport", data: { source: "zod" } }],
    },
    {
      code: `export * from "zod";`,
      errors: [{ messageId: "zodReexport", data: { source: "zod" } }],
    },
  ],
});
