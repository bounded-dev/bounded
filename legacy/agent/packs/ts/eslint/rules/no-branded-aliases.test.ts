import { afterAll, describe, it } from "vitest";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { noBrandedAliases } from "./no-branded-aliases.ts";

// Run 9's loophole: `string & { readonly __brand?: 'X' }` passed every gate
// and enforced nothing. Both alias forms are banned — the optional one is a
// costume, and the required one can only be constructed with a cast that the
// src lint bans.

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-branded-aliases", noBrandedAliases, {
  valid: [
    // The canonical form.
    `export declare class Currency {
      private readonly __brand: "Currency";
      private constructor();
      readonly value: string;
      static parse(raw: unknown): Currency | undefined;
    }`,
    // Ordinary vocabulary: unions, object aliases, interfaces.
    "export type Status = 'open' | 'paid';",
    "export type Money = { readonly amount: number; readonly currency: string };",
    "export interface Plan { readonly price: number }",
    // Intersections of object types are not the branded-alias pattern.
    "export type Extended = { a: string } & { b: number };",
    // Unexported aliases are internal.
    "type Internal = string & { readonly __brand: 'Internal' };",
  ],
  invalid: [
    // Run 9 verbatim: the optional brand.
    {
      code: "export type Currency = string & { readonly __brand?: 'Currency' };",
      errors: [{ messageId: "brandedAlias" }],
    },
    // The required brand — canonical until the class replaced it.
    {
      code: "export type Isbn = string & { readonly __brand: 'Isbn' };",
      errors: [{ messageId: "brandedAlias" }],
    },
    // Number base.
    {
      code: "export type Amount = number & { readonly __brand?: 'Amount' };",
      errors: [{ messageId: "brandedAlias" }],
    },
    // Branding on top of another alias (Run 9's PeriodStart).
    {
      code: "export type PeriodStart = DateString & { readonly __brand?: 'PeriodStart' };",
      errors: [{ messageId: "brandedAlias" }],
    },
    // A non-__brand tag is the same pattern.
    {
      code: "export type UserId = string & { readonly _tag: 'UserId' };",
      errors: [{ messageId: "brandedAlias" }],
    },
  ],
});
