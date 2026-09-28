import { afterAll, describe, it } from "vitest";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { routerTypeReexported } from "./router-type-reexported.ts";

// TN-26-006 A2 / ADR 2026-030: an API-service contract must re-export its
// router's inferred type. The reproduce case is dogfood Run 23 — both service
// arms delivered green having simply omitted it, which forfeits the typed
// client exactly as r22's `AnyRouter` did, with nothing to bounce on.
//
// The valid[] list is the load-bearing half, and doubly so for a rule about
// ABSENCE: it must pass the sanctioned form, and it must stay silent on every
// contract that is not a service contract at all. A rule that asked a domain
// contract for a router would tax every run in the repo.

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

/** The api skill's template, minus the re-export — the r23 shape. */
const SERVICE_CONTRACT = `import type { Ack } from "./service-runtime.js";
import type { IngestReportCommand } from "./commands.js";

export interface ServiceCaller {
  ingestReport(raw: unknown): Promise<Ack>;
}

export declare function createServiceCaller(ctx: { readonly now: () => string }): ServiceCaller;
`;

ruleTester.run("router-type-reexported", routerTypeReexported, {
  valid: [
    // THE CORRECT FORM: the inferred type, borrowed from the impl module. This
    // is verbatim the shape ts-api-service/SKILL.md tells the architect to
    // write, so it must lint clean or the skill teaches a block.
    `${SERVICE_CONTRACT}
import type { serviceRouter } from "./api.js";
export type ServiceRouter = typeof serviceRouter;`,
    // Declaration order is free: the re-export may precede the runtime import.
    `import type { serviceRouter } from "./api.js";
export type ServiceRouter = typeof serviceRouter;
import type { Ack } from "./service-runtime.js";
export declare function ack(): Ack;`,
    // OUT OF SCOPE — the half that keeps this rule from taxing the whole repo.
    // A contract with no service-runtime import declares no service.
    `export type Id = string & { readonly __brand: "Id" };
export declare function get(id: Id): string;`,
    `import type { Currency } from "../money/money.js";
export declare function total(c: Currency): Currency;`,
    // A nested runtime path is still the marker, and still satisfied.
    `import type { Ack } from "../api/service-runtime.js";
import type { serviceRouter } from "../api/api.js";
export type ServiceRouter = typeof serviceRouter;
export declare function ack(): Ack;`,
    // The name on the left is the architect's to choose — the rule is about
    // the SHAPE, not a magic identifier.
    `import type { Ack } from "./service-runtime.js";
import type { reportsRouter } from "./reports.js";
export type ReportsApi = typeof reportsRouter;
export declare function ack(): Ack;`,
  ],
  invalid: [
    // THE r23 REPRODUCE CASE: a complete, legal, green service contract with
    // the router type simply absent.
    { code: SERVICE_CONTRACT, errors: [{ messageId: "missing" }] },
    // Hand-declaring the router locally is the erasure one indirection out:
    // `typeof` over a local declare is a type the architect wrote, not the one
    // the implementation inferred.
    {
      code: `import type { Ack } from "./service-runtime.js";
declare const serviceRouter: { readonly procedures: unknown };
export type ServiceRouter = typeof serviceRouter;
export declare function ack(): Ack;`,
      errors: [{ messageId: "missing" }],
    },
    // Borrowing from a sibling CONTRACT is the second-identity defect
    // (no-cross-contract-type-import owns that message) AND not the inferred
    // router type, so it does not satisfy this rule either.
    {
      code: `import type { Ack } from "./service-runtime.js";
import type { serviceRouter } from "./api.contract.js";
export type ServiceRouter = typeof serviceRouter;
export declare function ack(): Ack;`,
      errors: [{ messageId: "missing" }],
    },
    // The runtime module exports plenty of names; none of them is the router,
    // so `typeof createService` must not buy a pass.
    {
      code: `import type { Ack, createService } from "./service-runtime.js";
export type ServiceRouter = typeof createService;
export declare function ack(): Ack;`,
      errors: [{ messageId: "missing" }],
    },
    // A package specifier is not this component's sibling implementation.
    {
      code: `import type { Ack } from "./service-runtime.js";
import type { appRouter } from "@acme/api";
export type ServiceRouter = typeof appRouter;
export declare function ack(): Ack;`,
      errors: [{ messageId: "missing" }],
    },
    // Declaring the alias without exporting it keeps the type off the surface,
    // which is the same as not having it: a caller cannot import it.
    {
      code: `import type { Ack } from "./service-runtime.js";
import type { serviceRouter } from "./api.js";
type ServiceRouter = typeof serviceRouter;
export declare function ack(): Ack;`,
      errors: [{ messageId: "missing" }],
    },
    // Two runtime imports, ONE report — on the first, the line that made this
    // file a service contract.
    {
      code: `import type { Ack } from "./service-runtime.js";
import type { Applied } from "../other/service-runtime.js";
export declare function ack(a: Applied): Ack;`,
      errors: [{ messageId: "missing", line: 1 }],
    },
  ],
});
