import { describe, expect, test } from "bun:test";
import { valueObjectLaws } from "../shared/value-object.laws.test-support.ts";
import { describeEffect, Effect } from "./effect.ts";

const read = { kind: "read", path: "src/a.ts" };
const list = { kind: "list", root: "src", filter: "*.ts" };
const write = { kind: "write", path: "src/a.ts", change: "modify" };
const execute = { kind: "execute", command: "make build" };
const fetch = { kind: "fetch", url: "https://example.com/a" };
const delegate = { kind: "delegate", agent: "explore" };

valueObjectLaws("Effect", Effect, [read, list, write, execute, fetch, delegate], [{ kind: "delete", path: "a" }, { ...read, path: "/etc/hosts" }, { ...write, change: "rename" }]);

const error = (raw: unknown): string | undefined => {
  const result = Effect.parse(raw);
  return result.ok ? undefined : result.error;
};

describe("Effect — the six kinds", () => {
  test("a read names the file whose contents it reads, normalised", () => {
    expect<unknown>(Effect.parse({ kind: "read", path: "./src//a.ts" })).toEqual({ ok: true, value: { kind: "read", path: "src/a.ts" } });
  });

  test("a list names the directory it lists and an optional file-name filter", () => {
    expect<unknown>(Effect.parse(list)).toEqual({ ok: true, value: { kind: "list", root: "src", filter: "*.ts" } });
    expect<unknown>(Effect.parse({ kind: "list", root: "." })).toEqual({ ok: true, value: { kind: "list", root: ".", filter: null } });
    expect(error({ kind: "list", root: "src", filter: " " })).toBe("A list's filter is a non-empty file-name pattern, or null");
    expect(error({ kind: "list", root: "../x" })).toBe("Path '../x' climbs out of the project with '..'. Only paths inside the project can be checked");
    expect(error({ kind: "read", path: "src", filter: "*.ts" })).toBe("A read effect is { kind, path }");
  });

  test("a write names the file and whether it is created, modified or deleted", () => {
    for (const change of ["create", "modify", "delete"]) expect(Effect.parse({ ...write, change }).ok).toBe(true);
    expect(error({ ...write, change: "rename" })).toBe("A write's change is create, modify or delete, not 'rename'");
  });

  test("an execute names its command exactly as given; tabs and line breaks are allowed, NUL and other control characters are not", () => {
    expect<unknown>(Effect.parse({ kind: "execute", command: " make\n\tbuild " })).toEqual({ ok: true, value: { kind: "execute", command: " make\n\tbuild " } });
    expect(error({ kind: "execute", command: " " })).toBe("An execute effect must name the command it runs");
    expect(error({ kind: "execute", command: "rm a\0b" })).toBe("A command must not contain a NUL character");
    expect(error({ kind: "execute", command: "echo \u001b[31m" })).toBe("A command must not contain control characters other than tab and line breaks");
  });

  test("a fetch names an absolute URL without spaces or control characters", () => {
    expect(error({ kind: "fetch", url: "example.com" })).toBe("Fetch URL 'example.com' must be an absolute URL with a scheme, without spaces or control characters");
    expect(error({ kind: "fetch", url: "https://a b" })).toBe("Fetch URL 'https://a b' must be an absolute URL with a scheme, without spaces or control characters");
    expect(error({ kind: "fetch", url: "" })).toBe("Fetch URL '' must be an absolute URL with a scheme, without spaces or control characters");
  });

  test("a delegate names the agent it hands work to", () => {
    expect(error({ kind: "delegate", agent: " " })).toBe("A delegate effect must name the agent it delegates to");
    expect(error({ kind: "delegate", agent: "a\nb" })).toBe("An agent's name must not contain control characters");
  });

  test("a path that is absolute or climbs out is refused with the path's reason", () => {
    expect(error({ kind: "write", path: "../b.ts", change: "create" })).toBe("Path '../b.ts' climbs out of the project with '..'. Only paths inside the project can be checked");
    expect(error({ kind: "list", root: "/etc" })).toBe("Path '/etc' is absolute. Give it relative to the project root, such as 'src/a.ts'");
  });
});

describe("Effect — nonsense is refused", () => {
  test("an effect of no known kind", () => {
    for (const raw of [undefined, null, "read", [], { kind: "delete", path: "a" }, { path: "a" }]) {
      expect(error(raw)).toBe("An effect has kind read, list, write, execute, fetch or delegate");
    }
  });

  test("fields that do not belong to the kind, and missing ones", () => {
    expect(error({ kind: "read", path: "a", command: "cat a" })).toBe("A read effect is { kind, path }");
    expect(error({ kind: "read" })).toBe("A read effect is { kind, path }");
    expect(error({ kind: "write", path: "a" })).toBe("A write effect is { kind, path, change }");
    expect(error({ kind: "execute", command: "ls", path: "a" })).toBe("An execute effect is { kind, command }");
    expect(error({ kind: "list", path: "a" })).toBe("A list effect is { kind, root, filter? }");
    expect(error({ kind: "fetch", url: "https://a", path: "x" })).toBe("A fetch effect is { kind, url }");
    expect(error({ kind: "delegate" })).toBe("A delegate effect is { kind, agent }");
  });

  test("never throws, and reads only its own fields", () => {
    const hostile = new Proxy({}, { get: () => { throw new Error("trap"); }, has: () => { throw new Error("trap"); }, ownKeys: () => { throw new Error("trap"); }, getOwnPropertyDescriptor: () => { throw new Error("trap"); } });
    expect(Effect.parse(hostile)).toEqual({ ok: false, error: "An effect could not be read: trap" });
    expect(Effect.parse(Object.create(read)).ok).toBe(false);
  });

  test("is frozen", () => {
    const result = Effect.parse(list);
    expect(result.ok && Object.isFrozen(result.value)).toBe(true);
  });
});

describe("describeEffect — how a message names an effect", () => {
  test("names the kind and what it touches", () => {
    const named = (raw: object) => {
      const result = Effect.parse(raw);
      if (!result.ok) throw new Error(result.error);
      return describeEffect(result.value);
    };
    expect(named(read)).toBe("read src/a.ts");
    expect(named(list)).toBe("list src (*.ts)");
    expect(named({ kind: "list", root: "src" })).toBe("list src");
    expect(named({ ...write, change: "modify" })).toBe("write (modify) src/a.ts");
    expect(named(execute)).toBe("execute `make build`");
    expect(named(fetch)).toBe("fetch https://example.com/a");
    expect(named(delegate)).toBe("delegate to explore");
  });
});
