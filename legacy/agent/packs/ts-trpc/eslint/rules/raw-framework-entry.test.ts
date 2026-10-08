import { afterAll, describe, it } from "vitest";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { rawFrameworkEntry } from "./raw-framework-entry.ts";

// TN-26-012 §6: procedures and routers are generated into adapters/in/trpc/.
// Role-written code hosts the generated router through a transport adapter
// and never builds a procedure of its own.

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("raw-framework-entry", rawFrameworkEntry, {
  valid: [
    // THE CORRECT FORM: an app's server entry serves the generated router.
    {
      code: `import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { composeApp } from "./composition-root.ts";
export const serve = (req: Request) => fetchRequestHandler({ endpoint: "/trpc", req, router: composeApp() });`,
      filename: "apps/web/src/server/main.ts",
    },
    // Type-only imports harm nothing, anywhere.
    {
      code: `import type { TRPCError } from "@trpc/server";
export declare function explain(e: TRPCError): string;`,
      filename: "apps/web/src/server/errors.ts",
    },
    { code: `import { type inferRouterInputs } from "@trpc/server";`, filename: "apps/web/src/server/types.ts" },
    // The generated adapter owns initTRPC.
    {
      code: `import { initTRPC } from "@trpc/server";
export const t = initTRPC.create();`,
      filename: "contexts/project-management/src/adapters/in/trpc/trpc.ts",
    },
    // The client is a transport with no procedures to build.
    { code: `import { createTRPCClient, httpBatchLink } from "@trpc/client";`, filename: "apps/web/src/client/main.tsx" },
  ],
  invalid: [
    {
      code: `import { initTRPC } from "@trpc/server";`,
      filename: "apps/web/src/server/api.ts",
      errors: [{ messageId: "rawEntry", data: { source: "@trpc/server" } }],
    },
    // A value import of TRPCError is building error mapping by hand — same door.
    {
      code: `import { TRPCError } from "@trpc/server";`,
      filename: "apps/web/src/server/errors.ts",
      errors: [{ messageId: "rawEntry", data: { source: "@trpc/server" } }],
    },
    // A hand-written procedure inside a context but outside the generated folder.
    {
      code: `import { initTRPC } from "@trpc/server";`,
      filename: "contexts/project-management/src/application/notes/extra.ts",
      errors: [{ messageId: "rawEntry", data: { source: "@trpc/server" } }],
    },
    // Unstable internals are not a transport adapter.
    {
      code: `import { createCallerFactory } from "@trpc/server/unstable-core-do-not-import";`,
      filename: "apps/web/src/server/main.ts",
      errors: [{ messageId: "rawEntry", data: { source: "@trpc/server/unstable-core-do-not-import" } }],
    },
    // Re-exporting the framework is importing it for someone else.
    {
      code: `export * from "@trpc/server";`,
      filename: "apps/web/src/server/facade.ts",
      errors: [{ messageId: "rawEntry", data: { source: "@trpc/server" } }],
    },
    {
      code: `export const load = () => import("@trpc/server");`,
      filename: "apps/web/src/server/lazy.ts",
      errors: [{ messageId: "rawEntry", data: { source: "@trpc/server" } }],
    },
  ],
});
