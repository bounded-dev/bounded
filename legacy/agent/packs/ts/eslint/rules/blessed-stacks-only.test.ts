import { afterAll, describe, it } from "vitest";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { blessedStacksOnly } from "./blessed-stacks-only.ts";

// ADR 2026-029: the stack is harness policy. Imports of known non-blessed API
// frameworks and schema engines are refused in the worker zones — the
// mechanical layer of the binding, holding even when no skill loaded and no
// dependency rule stopped the install.

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("blessed-stacks-only", blessedStacksOnly, {
  valid: [
    // The blessed stacks themselves.
    `import { initTRPC } from "@trpc/server";`,
    `import { z } from "zod";`,
    // Ordinary project and platform imports are none of this rule's business.
    `import { rate } from "./heating-cockpit.js";`,
    `import { readFileSync } from "node:fs";`,
    `import { describe } from "vitest";`,
    // A name that merely CONTAINS a banned name is not it.
    `import { x } from "express-checkout-domain";`,
  ],
  invalid: [
    {
      code: `import { graphql } from "graphql";`,
      errors: [{ messageId: "bannedImport", data: { source: "graphql", banned: "graphql" } }],
    },
    // Subpaths are the same package.
    {
      code: `import { buildSchema } from "graphql/utilities";`,
      errors: [{ messageId: "bannedImport", data: { source: "graphql/utilities", banned: "graphql" } }],
    },
    {
      code: `import express from "express";`,
      errors: [{ messageId: "bannedImport", data: { source: "express", banned: "express" } }],
    },
    // Scoped ecosystems are banned by prefix.
    {
      code: `import { ApolloServer } from "@apollo/server";`,
      errors: [{ messageId: "bannedImport", data: { source: "@apollo/server", banned: "@apollo" } }],
    },
    // Schema engines other than zod are the same category leak.
    {
      code: `import Ajv from "ajv";`,
      errors: [{ messageId: "bannedImport", data: { source: "ajv", banned: "ajv" } }],
    },
    // Re-exports and dynamic imports are imports.
    {
      code: `export * from "yup";`,
      errors: [{ messageId: "bannedImport", data: { source: "yup", banned: "yup" } }],
    },
    {
      code: `const m = await import("joi");`,
      errors: [{ messageId: "bannedImport", data: { source: "joi", banned: "joi" } }],
    },
  ],
});
