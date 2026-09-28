import { afterAll, describe, it } from "vitest";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { clientOneDoor } from "./client-one-door.ts";

// TN-26-006: the frontend has one door to the network — `@trpc/*` and
// `@tanstack/*` at runtime only under src/ui/shared/api/.
//
// THE VALID LIST IS THE LOAD-BEARING HALF. The door's own files must be free,
// type-only imports must be free everywhere, and — the case that matters most —
// the CORRECT shape a component uses must obviously pass, or the rule is
// teaching nothing but frustration.

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("client-one-door", clientOneDoor, {
  valid: [
    // THE CORRECT FORM: a component reaches the door, not the transport. This
    // is also what makes it testable — render it under a provider holding a
    // fake and it knows no difference.
    {
      code: `import { useServiceClient } from "../../shared/api/client.js";`,
      filename: "src/ui/entities/building/model/query.ts",
    },
    // The door itself, in every file it is made of.
    {
      code: `import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";`,
      filename: "src/ui/shared/api/client.tsx",
    },
    {
      code: `import { useQuery } from "@tanstack/react-query";`,
      filename: "src/ui/shared/api/hooks.ts",
    },
    // An absolute path finds the door too.
    {
      code: `import { createTRPCClient } from "@trpc/client";`,
      filename: "/home/dev/project/src/ui/shared/api/client.tsx",
    },
    // Type-only imports move no bytes and open no socket — legal anywhere.
    {
      code: `import type { TRPCClientError } from "@trpc/client";
export declare function explain(e: TRPCClientError<never>): string;`,
      filename: "src/ui/features/submit-report/model/command.ts",
    },
    {
      code: `import { type UseQueryResult } from "@tanstack/react-query";`,
      filename: "src/ui/entities/building/model/query.ts",
    },
    {
      code: `export type { QueryKey } from "@tanstack/react-query";`,
      filename: "src/ui/entities/building/index.ts",
    },
    // Everything else a component imports is nobody's business here.
    {
      code: `import { useState } from "react";`,
      filename: "src/ui/features/submit-report/form.tsx",
    },
    // @trpc/server belongs to the ts-service pack's raw-framework-entry, not to this
    // rule's door — but it is still a transport import outside shared/api, and
    // a service file is not a UI file. Both rules see it; only one owns it.
    {
      code: `import { createService } from "./service-runtime.js";`,
      filename: "src/api/api.ts",
    },
  ],
  invalid: [
    // The archetype: a query hook with the transport soldered into it.
    {
      code: `import { useQuery } from "@tanstack/react-query";`,
      filename: "src/ui/entities/building/model/query.ts",
      errors: [{ messageId: "outsideDoor", data: { source: "@tanstack/react-query" } }],
    },
    // A second client is a second URL to get wrong.
    {
      code: `import { createTRPCClient } from "@trpc/client";`,
      filename: "src/ui/features/submit-report/model/command.ts",
      errors: [{ messageId: "outsideDoor", data: { source: "@trpc/client" } }],
    },
    // A second QueryClient is worse: it splits the cache, and nothing fails —
    // half the app just stops seeing the other half's writes.
    {
      code: `import { QueryClient } from "@tanstack/react-query";`,
      filename: "src/ui/pages/dashboard.tsx",
      errors: [{ messageId: "outsideDoor", data: { source: "@tanstack/react-query" } }],
    },
    // Sub-paths are the same package.
    {
      code: `import { unstable_httpBatchStreamLink } from "@trpc/client/links/httpBatchStreamLink";`,
      filename: "src/ui/pages/dashboard.tsx",
      errors: [{ messageId: "outsideDoor", data: { source: "@trpc/client/links/httpBatchStreamLink" } }],
    },
    {
      code: `import { useStore } from "@tanstack/react-store";`,
      filename: "src/ui/entities/building/model/query.ts",
      errors: [{ messageId: "outsideDoor", data: { source: "@tanstack/react-store" } }],
    },
    // A side-effect import has no specifiers and cannot be a type.
    {
      code: `import "@tanstack/react-query";`,
      filename: "src/ui/pages/dashboard.tsx",
      errors: [{ messageId: "outsideDoor", data: { source: "@tanstack/react-query" } }],
    },
    // Re-exporting the transport is importing it for someone else.
    {
      code: `export { useQuery } from "@tanstack/react-query";`,
      filename: "src/ui/shared/lib/data.ts",
      errors: [{ messageId: "outsideDoor", data: { source: "@tanstack/react-query" } }],
    },
    {
      code: `export * from "@trpc/client";`,
      filename: "src/ui/shared/lib/data.ts",
      errors: [{ messageId: "outsideDoor", data: { source: "@trpc/client" } }],
    },
    // `shared/ui` is NOT `shared/api`: the door is one directory, not a layer.
    {
      code: `import { useQuery } from "@tanstack/react-query";`,
      filename: "src/ui/shared/ui/button.tsx",
      errors: [{ messageId: "outsideDoor", data: { source: "@tanstack/react-query" } }],
    },
  ],
});
