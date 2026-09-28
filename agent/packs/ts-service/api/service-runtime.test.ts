import { describe, expect, test } from "vitest";
import { TRPCError } from "@trpc/server";
import {
  applied,
  conflict,
  createService,
  notFound,
  replayed,
  serveStandalone,
  unprocessable,
  type Ack,
} from "./service-runtime.ts";

// The runtime IS the error taxonomy (TN-26-004): a procedure built through
// `command`/`query` cannot map a parse failure to anything but BAD_REQUEST,
// and the named throwers are the taxonomy's remaining rows. These tests pin
// the mapping the way the gates pin everything else — as machinery, not
// convention.

/** A command value object in miniature: the parse door and nothing else. */
class Ping {
  private constructor(readonly word: string) {}
  static parse(raw: unknown): Ping | undefined {
    return raw === "ping" ? new Ping("ping") : undefined;
  }
}

class Find {
  private constructor(readonly id: string) {}
  static parse(raw: unknown): Find | undefined {
    return typeof raw === "string" && raw.startsWith("F-") ? new Find(raw) : undefined;
  }
}

interface Ctx {
  readonly seen: string[];
}

function build() {
  const s = createService<Ctx>();
  const router = s.router({
    ping: s.command(Ping, (cmd, ctx): Ack => {
      ctx.seen.push(cmd.word);
      return ctx.seen.length > 1 ? replayed : applied;
    }),
    find: s.query(Find, (q, ctx) => ({ id: q.id, hits: ctx.seen.length })),
    missing: s.query(Find, (q): never => notFound(`nothing stored for ${q.id}`)),
  });
  const ctx: Ctx = { seen: [] };
  return { caller: s.createCallerFactory(router)(ctx), router, ctx };
}

describe("createService: the wire is untyped, the door parses", () => {
  test("a command that parses runs and acknowledges — applied, then replayed", async () => {
    const { caller } = build();
    await expect(caller.ping("ping")).resolves.toEqual({ outcome: "applied" });
    await expect(caller.ping("ping")).resolves.toEqual({ outcome: "replayed" });
  });

  test("a payload that does not parse is BAD_REQUEST before any resolver runs", async () => {
    const { caller, ctx } = build();
    const failure = caller.ping(42);
    await expect(failure).rejects.toBeInstanceOf(TRPCError);
    await expect(failure).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "invalid Ping: the payload does not parse",
    });
    expect(ctx.seen).toEqual([]); // the resolver never saw it
  });

  test("a query that parses returns its read model", async () => {
    const { caller } = build();
    await expect(caller.find("F-1")).resolves.toEqual({ id: "F-1", hits: 0 });
  });

  test("a query payload that does not parse is BAD_REQUEST too", async () => {
    const { caller } = build();
    await expect(caller.find("nope")).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("the taxonomy's named rows", () => {
  test("notFound is NOT_FOUND through the caller", async () => {
    const { caller } = build();
    await expect(caller.missing("F-404")).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "nothing stored for F-404",
    });
  });

  test("unprocessable and conflict throw their codes", () => {
    expect(() => unprocessable("ratable >= full-confidence")).toThrowError(TRPCError);
    try {
      unprocessable("x");
    } catch (e) {
      expect(e).toMatchObject({ code: "UNPROCESSABLE_CONTENT" });
    }
    try {
      conflict("id reused with different content");
    } catch (e) {
      expect(e).toMatchObject({ code: "CONFLICT" });
    }
  });
});

describe("serveStandalone", () => {
  test("binds the standalone adapter and closes cleanly — no express anywhere", async () => {
    const { router, ctx } = build();
    const server = serveStandalone(router, () => ctx, 0);
    expect(server.listening).toBe(true);
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  });
});
