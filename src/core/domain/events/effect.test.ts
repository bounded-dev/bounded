import { describe, expect, test } from "bun:test";
import { wireOf } from "../shared/value-object.laws.test-support.ts";
import { describeEffect, Effect } from "./effect.ts";

const read = { kind: "read", path: "src/a.ts" };
const list = { kind: "list", root: "src", filter: "*.ts" };
const write = { kind: "write", path: "src/a.ts", change: "modify" };
const execute = { kind: "execute", command: "make build" };
const fetch = { kind: "fetch", url: "https://example.com/a" };
const delegate = { kind: "delegate", agent: "explore" };
const invoke = { kind: "invoke", name: "mcp__docs__search" };


const error = (raw: unknown): string | undefined => {
  const result = Effect.parse(raw);
  return result.ok ? undefined : result.error;
};

describe("Effect — the seven kinds", () => {
  test("a read names the file whose contents it reads, normalised", () => {
    expect(wireOf(Effect.parse({ kind: "read", path: "./src//a.ts" }))).toEqual({ ok: true, value: { kind: "read", path: "src/a.ts" } });
  });

  test("a list names the directory it lists and an optional file-name filter", () => {
    expect(wireOf(Effect.parse(list))).toEqual({ ok: true, value: { kind: "list", root: "src", filter: "*.ts" } });
    expect(wireOf(Effect.parse({ kind: "list", root: "." }))).toEqual({ ok: true, value: { kind: "list", root: ".", filter: null } });
    expect(error({ kind: "list", root: "src", filter: " " })).toBe("A list's filter is a non-empty file-name pattern, or null");
    expect(error({ kind: "list", root: "../x" })).toBe("Path '../x' climbs out of the project with '..'. Only paths inside the project can be checked");
    expect(error({ kind: "read", path: "src", filter: "*.ts" })).toBe("A read effect is { kind, path }");
  });

  test("a write names the file and whether it is created, modified or deleted", () => {
    for (const change of ["create", "modify", "delete"]) expect(Effect.parse({ ...write, change }).ok).toBe(true);
    expect(error({ ...write, change: "rename" })).toBe("A write's change is create, modify or delete, not 'rename'");
  });

  test("an execute names its command exactly as given; tabs and line breaks are allowed, NUL and other control characters are not", () => {
    expect(wireOf(Effect.parse({ kind: "execute", command: " make\n\tbuild " }))).toEqual({ ok: true, value: { kind: "execute", command: " make\n\tbuild ", cwd: null } });
    expect(error({ kind: "execute", command: " " })).toBe("An execute effect must name the command it runs");
    expect(error({ kind: "execute", command: "rm a\0b" })).toBe("A command must not contain a NUL character");
    expect(error({ kind: "execute", command: "echo \u001b[31m" })).toBe("A command must not contain control characters other than tab and line breaks");
  });

  test("an execute may name the project directory it runs in, normalised; outside the project is refused", () => {
    expect(wireOf(Effect.parse({ kind: "execute", command: "make", cwd: "./apps//web" }))).toEqual({ ok: true, value: { kind: "execute", command: "make", cwd: "apps/web" } });
    expect(wireOf(Effect.parse({ kind: "execute", command: "make", cwd: null }))).toEqual({ ok: true, value: { kind: "execute", command: "make", cwd: null } });
    expect(error({ kind: "execute", command: "make", cwd: "../elsewhere" })).toBe("Path '../elsewhere' climbs out of the project with '..'. Only paths inside the project can be checked");
    expect(error({ kind: "execute", command: "make", cwd: "/tmp" })).toBe("Path '/tmp' is absolute. Give it relative to the project root, such as 'src/a.ts'");
  });

  test("an execute may carry bounded's reading of its command; without one its reading is null and its wire form has none", () => {
    const reading = { outcome: "read", programs: [{ name: { kind: "literal", text: "make" }, arguments: [], workingDirectory: "." }], fileEffects: [{ effect: { kind: "read", path: "Makefile" } }], unresolved: [] };
    const carried = Effect.parse({ kind: "execute", command: "make", reading });
    expect(carried.ok && carried.value.kind === "execute" && carried.value.reading?.outcome).toBe("read");
    expect(wireOf(carried)).toEqual({ ok: true, value: { kind: "execute", command: "make", cwd: null, reading } });
    const plain = Effect.parse({ kind: "execute", command: "make" });
    expect(plain.ok && plain.value.kind === "execute" && plain.value.reading).toBeNull();
    expect(plain.ok && Object.keys(plain.value.toJSON())).toEqual(["kind", "command", "cwd"]);
    expect(error({ kind: "execute", command: "make", reading: { outcome: "maybe" } })).toBe("A shell command reading is { outcome: 'read', programs, fileEffects, unresolved } or { outcome: 'unread', why }");
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

  test("a delegation says on the call whether it is isolated and whether its finish goes unreported", () => {
    expect(wireOf(Effect.parse({ kind: "delegate", agent: "reviewer", isolated: true, finishUnreported: true }))).toEqual({ ok: true, value: { kind: "delegate", agent: "reviewer", isolated: true, finishUnreported: true } });
    const isolated = Effect.parse({ kind: "delegate", agent: "reviewer", isolated: true });
    expect(isolated.ok && isolated.value.kind === "delegate" && isolated.value.isolated).toBe(true);
    expect(isolated.ok && isolated.value.kind === "delegate" && isolated.value.finishUnreported).toBeUndefined();
    for (const raw of [{ kind: "delegate", agent: "reviewer" }, { kind: "delegate", agent: "reviewer", isolated: false, finishUnreported: false }]) {
      const parsed = Effect.parse(raw);
      expect(parsed.ok && parsed.value.toJSON()).toEqual({ kind: "delegate", agent: "reviewer" });
      expect(parsed.ok && Object.keys(parsed.value.toJSON())).toEqual(["kind", "agent"]);
    }
    expect(error({ kind: "delegate", agent: "reviewer", isolated: "yes" })).toBe("A delegate effect's isolated must be true or false");
    expect(error({ kind: "delegate", agent: "reviewer", finishUnreported: 1 })).toBe("A delegate effect's finishUnreported must be true or false");
    expect(error({ kind: "delegate", agent: "reviewer", isolated: null })).toBe("A delegate effect's isolated must be true or false");
    expect(error({ kind: "delegate", agent: "reviewer", finishUnreported: null })).toBe("A delegate effect's finishUnreported must be true or false");
    expect(error({ kind: "delegate", agent: "reviewer", background: true })).toBe("A delegate effect is { kind, agent, isolated?, finishUnreported? }");
  });

  test("an invoke names a tool whose effects the host cannot describe", () => {
    expect(wireOf(Effect.parse(invoke))).toEqual({ ok: true, value: { kind: "invoke", name: "mcp__docs__search" } });
    expect(error({ kind: "invoke", name: " " })).toBe("An invoke effect must name the tool it invokes");
    expect(error({ kind: "invoke", name: "a\u0000b" })).toBe("A tool name must not contain NUL or control characters");
    expect(error({ kind: "invoke", name: "web", url: "https://a" })).toBe("An invoke effect is { kind, name }");
  });

  test("a path that is absolute or climbs out is refused with the path's reason", () => {
    expect(error({ kind: "write", path: "../b.ts", change: "create" })).toBe("Path '../b.ts' climbs out of the project with '..'. Only paths inside the project can be checked");
    expect(error({ kind: "list", root: "/etc" })).toBe("Path '/etc' is absolute. Give it relative to the project root, such as 'src/a.ts'");
  });
});

describe("Effect — nonsense is refused", () => {
  test("an effect of no known kind", () => {
    for (const raw of [undefined, null, "read", [], { kind: "delete", path: "a" }, { path: "a" }]) {
      expect(error(raw)).toBe("An effect has kind read, list, write, execute, fetch, delegate or invoke");
    }
  });

  test("fields that do not belong to the kind, and missing ones", () => {
    expect(error({ kind: "read", path: "a", command: "cat a" })).toBe("A read effect is { kind, path }");
    expect(error({ kind: "read" })).toBe("A read effect is { kind, path }");
    expect(error({ kind: "write", path: "a" })).toBe("A write effect is { kind, path, change }");
    expect(error({ kind: "execute", command: "ls", path: "a" })).toBe("An execute effect is { kind, command, cwd?, reading? }");
    expect(error({ kind: "list", path: "a" })).toBe("A list effect is { kind, root, filter? }");
    expect(error({ kind: "fetch", url: "https://a", path: "x" })).toBe("A fetch effect is { kind, url }");
    expect(error({ kind: "delegate" })).toBe("A delegate effect is { kind, agent, isolated?, finishUnreported? }");
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
    expect(named({ ...execute, cwd: "apps/web" })).toBe("execute `make build` in apps/web");
    expect(named(fetch)).toBe("fetch https://example.com/a");
    expect(named(delegate)).toBe("delegate to explore");
    expect(named(invoke)).toBe("invoke mcp__docs__search");
  });
});
