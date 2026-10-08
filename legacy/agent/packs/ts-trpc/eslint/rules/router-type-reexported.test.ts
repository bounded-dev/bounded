import { afterAll, describe, it } from "vitest";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { routerTypeReexported } from "./router-type-reexported.ts";

// ADR LEG-2026-030, TN-26-012 §6: a tRPC client is typed by the router type the
// context's generated adapter re-exports. The reproduce case for the absence
// half is dogfood Run 23 — a client with no router type, green and untyped.
//
// The valid[] list is the load-bearing half: the worked example's own client
// must pass, and a file with no client factory must stay silent.

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

const IMPORTS = `import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { ProjectManagementRouter } from "@example/project-management/adapters/trpc";
`;

ruleTester.run("router-type-reexported", routerTypeReexported, {
  valid: [
    // THE WORKED EXAMPLE's apps/web/src/client/main.tsx.
    `${IMPORTS}const api = createTRPCClient<ProjectManagementRouter>({ links: [httpBatchLink({ url: "/trpc" })] });`,
    // An inline type specifier is type-only too.
    `import { createTRPCClient } from "@trpc/client";
import { type ProjectManagementRouter } from "@example/project-management/adapters/trpc";
export const api = createTRPCClient<ProjectManagementRouter>({ links: [] });`,
    // An unscoped package name is still a context package.
    `import { createTRPCClient } from "@trpc/client";
import type { BillingRouter } from "billing/adapters/trpc";
export const api = createTRPCClient<BillingRouter>({ links: [] });`,
    // No client factory, nothing to check.
    `import type { ProjectManagementRouter } from "@example/project-management/adapters/trpc";
export async function seed(router: ProjectManagementRouter): Promise<void> {}`,
    // A same-named function from elsewhere is not tRPC's.
    `function createTRPCClient(x: unknown) { return x; }
createTRPCClient({});`,
  ],
  invalid: [
    // THE r23 SHAPE: no router type at all.
    {
      code: `import { createTRPCClient } from "@trpc/client";
export const api = createTRPCClient({ links: [] });`,
      errors: [{ messageId: "missing", data: { factory: "createTRPCClient" } }],
    },
    // A local alias can drift from the real API.
    {
      code: `import { createTRPCClient } from "@trpc/client";
type MyRouter = { projects: unknown };
export const api = createTRPCClient<MyRouter>({ links: [] });`,
      errors: [{ messageId: "notReexported", data: { factory: "createTRPCClient", type: "MyRouter" } }],
    },
    // A value import of the barrel would bundle the server into the client.
    {
      code: `import { createTRPCClient } from "@trpc/client";
import { ProjectManagementRouter } from "@example/project-management/adapters/trpc";
export const api = createTRPCClient<ProjectManagementRouter>({ links: [] });`,
      errors: [{ messageId: "notReexported" }],
    },
    // The router type from somewhere other than the adapter barrel.
    {
      code: `import { createTRPCClient } from "@trpc/client";
import type { ProjectManagementRouter } from "../server/router.ts";
export const api = createTRPCClient<ProjectManagementRouter>({ links: [] });`,
      errors: [{ messageId: "notReexported" }],
    },
    // typeof a value is not the re-export.
    {
      code: `import { createTRPCClient } from "@trpc/client";
import type { createProjectManagementRouter } from "@example/project-management/adapters/trpc";
export const api = createTRPCClient<ReturnType<typeof createProjectManagementRouter>>({ links: [] });`,
      errors: [{ messageId: "notReexported" }],
    },
    // An aliased factory is the same factory.
    {
      code: `import { createTRPCClient as client } from "@trpc/client";
export const api = client({ links: [] });`,
      errors: [{ messageId: "missing", data: { factory: "createTRPCClient" } }],
    },
  ],
});
