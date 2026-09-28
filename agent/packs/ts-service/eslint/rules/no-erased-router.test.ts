import { afterAll, describe, it } from "vitest";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { noErasedRouter } from "./no-erased-router.ts";

// TN-26-004 / ADR 2026-030: a contract may not declare its service surface
// with a type-erased framework type. The reproduce case is dogfood Run 22 —
// `export type ServiceRouter = AnyRouter` shipped a typed client whose inputs
// are `unknown`, flagged by the reviewer, refused by nothing.
//
// The valid[] list is the load-bearing half: the sanctioned form — the
// inferred router type re-exported from the implementation module (ADR
// 2026-026) — must lint clean, or the rule steers nowhere.

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-erased-router", noErasedRouter, {
  valid: [
    // THE CORRECT FORM: the inferred type, re-exported from the impl module.
    `import type { serviceRouter } from "./api.js";
export type ServiceRouter = typeof serviceRouter;`,
    // Non-erased tRPC types are not this rule's business.
    `import type { inferRouterInputs } from "@trpc/server";
import type { serviceRouter } from "./api.js";
export type Inputs = inferRouterInputs<typeof serviceRouter>;`,
    // A domain type whose name merely starts with "Any" from a NON-trpc module.
    `import type { AnyBuilding } from "./values.js";
export declare function rate(b: AnyBuilding): AnyBuilding;`,
  ],
  invalid: [
    // THE r22 REPRODUCE CASE.
    {
      code: `import type { AnyRouter } from "@trpc/server";
export type ServiceRouter = AnyRouter;`,
      errors: [
        { messageId: "erasedImport", data: { what: "AnyRouter" } },
        { messageId: "erasedReference", data: { what: "AnyRouter" } },
      ],
    },
    // The whole Any* family from @trpc is refused at the import.
    {
      code: `import type { AnyProcedure } from "@trpc/server";
export interface S { readonly p: AnyProcedure; }`,
      errors: [
        { messageId: "erasedImport", data: { what: "AnyProcedure" } },
        { messageId: "erasedReference", data: { what: "AnyProcedure" } },
      ],
    },
    // A local alias laundering the erasure keeps the banned NAME — still caught.
    {
      code: `declare const r: unknown;
export type AnyRouter = typeof r;
export type ServiceRouter = AnyRouter;`,
      errors: [{ messageId: "erasedReference", data: { what: "AnyRouter" } }],
    },
    // Qualified references are the same erasure through a namespace.
    {
      code: `import type * as trpc from "@trpc/server";
export type ServiceRouter = trpc.AnyRouter;`,
      errors: [{ messageId: "erasedReference", data: { what: "AnyRouter" } }],
    },
  ],
});
