// The API-service reference runtime (TN-26-004, ADR 2026-029/030).
//
// CANONICAL COPY — packs/ts-service/api/service-runtime.ts. The scaffolder ships this
// file verbatim (plus a GENERATED marker) into any component whose contract
// imports "./service-runtime.js", the same way surface-check.ts is shipped at
// delivery: ONE implementation, copied byte-for-byte, never hand-edited in a
// target. The error taxonomy lives HERE as code, not in guidance: a procedure
// built through `command`/`query` cannot map a parse failure to anything but
// BAD_REQUEST, because the mapping is not the builder's to write. The
// `raw-framework-entry` lint closes the side door: this file is the only
// src/** module allowed a runtime import of @trpc/*.
//
// The shapes it fixes (ADR 2026-030):
//   * every mutation takes ONE command value object and returns an Ack —
//     `applied` or `replayed`, command metadata, never domain data;
//   * every query takes ONE query value object and returns a read model;
//   * the wire is untyped (`unknown` in, parse at the door): the domain's own
//     parse-based value objects ARE the validation (ADR 2026-031), so a
//     malformed payload fails BAD_REQUEST before any resolver runs;
//   * the taxonomy's remaining rows are the three named throwers below —
//     total, closed, and identical in every service the harness ships.

import { initTRPC, TRPCError } from "@trpc/server";
import type { AnyRouter } from "@trpc/server";
import { createHTTPServer } from "@trpc/server/adapters/standalone";

/** What a write returns: command metadata, never domain state (ADR 2026-030).
 *  `applied` — the command changed the world; `replayed` — an idempotent
 *  duplicate, the world was already like this. Anything a caller wants to SEE
 *  after a write, it asks a query for. */
export type Ack = { readonly outcome: "applied" | "replayed" };
export const applied: Ack = { outcome: "applied" };
export const replayed: Ack = { outcome: "replayed" };

/** The parse door every command and query value object already has. The
 *  `name` is the class name — free on any class's static side — and is the
 *  only thing a BAD_REQUEST message reveals about the payload. */
export interface Parser<T> {
  readonly name: string;
  parse(raw: unknown): T | undefined;
}

/** Unknown resource: the (building, period) nobody ingested, the id nothing
 *  matches. A verdict a frontend can show, never an exception leak. */
export function notFound(message: string): never {
  throw new TRPCError({ code: "NOT_FOUND", message });
}

/** Well-formed payload, violated domain invariant — the command parsed, and
 *  the domain says no. */
export function unprocessable(message: string): never {
  throw new TRPCError({ code: "UNPROCESSABLE_CONTENT", message });
}

/** A client-minted id reused with different content, on a command whose
 *  declared duplicate policy is `conflict` (ADR 2026-030). */
export function conflict(message: string): never {
  throw new TRPCError({ code: "CONFLICT", message });
}

/**
 * The one way procedures are built. `Ctx` carries the component's ports (the
 * store, the clock) — injected by the caller, test or server; the service
 * constructs nothing ambient.
 */
/** Parse at the door or refuse as BAD_REQUEST — before any domain code runs. */
function door<T>(parser: Parser<T>, raw: unknown): T {
  const parsed = parser.parse(raw);
  if (parsed === undefined) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `invalid ${parser.name}: the payload does not parse`,
    });
  }
  return parsed;
}

/** The wire is untyped by design: the door types it (ADR 2026-030). */
const wire = (raw: unknown): unknown => raw;

export function createService<Ctx extends object>() {
  const t = initTRPC.context<Ctx>().create();
  const base = t.procedure.input(wire);
  // tRPC's resolved context type, captured from the very builder the
  // procedures are made with. Inside this generic function the library's
  // Simplify/Unwrap conditionals do not reduce to `Ctx`, so the resolver
  // signatures below speak the builder's own type — for a caller with a
  // concrete Ctx the two collapse to the same thing.
  type ResolvedCtx = Parameters<Parameters<(typeof base)["mutation"]>[0]>[0]["ctx"];

  return {
    /** Assemble the router from procedures built below. */
    router: t.router,
    /** `createCallerFactory(router)(ctx)` — the socketless test door. */
    createCallerFactory: t.createCallerFactory,
    /** A write: one command value object in, an Ack out, nothing else. */
    command<T>(parser: Parser<T>, resolve: (command: T, ctx: ResolvedCtx) => Ack | Promise<Ack>) {
      return base.mutation(({ input, ctx }) => resolve(door(parser, input), ctx));
    },
    /** A read: one query value object in, a read model out. */
    query<T, R>(parser: Parser<T>, resolve: (query: T, ctx: ResolvedCtx) => R | Promise<R>) {
      return base.query(({ input, ctx }) => resolve(door(parser, input), ctx));
    },
  };
}

/** The HTTP entry point — tRPC's standalone adapter, no express (ADR
 *  2026-029). Tests never come through here; they use the caller factory. */
export function serveStandalone(
  router: AnyRouter,
  createContext: () => object,
  port: number,
): ReturnType<typeof createHTTPServer> {
  const server = createHTTPServer({ router, createContext });
  server.listen(port);
  return server;
}
