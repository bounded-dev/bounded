import { describe, expect, test } from "bun:test";
import { valueObjectLaws } from "../shared/value-object.laws.test-support.ts";
import { ToolUse } from "./tool-use.ts";

const edit = { role: "builder", tool: "edit", effects: [{ kind: "write", path: "src/a.ts", change: "modify" }] };
const run = { role: null, tool: "shell", effects: [{ kind: "execute", command: "make build" }] };
const grep = { role: null, tool: "search", effects: [{ kind: "list", root: "src", filter: "*.ts" }, { kind: "read", path: "src" }] };

valueObjectLaws("ToolUse", ToolUse, [edit, run, grep], [{ ...edit, tool: "bash" }, { ...edit, effects: [] }, { ...edit, effects: [{ kind: "read", path: "/etc/hosts" }] }]);

const error = (raw: unknown): string | undefined => {
  const result = ToolUse.parse(raw);
  return result.ok ? undefined : result.error;
};

describe("ToolUse — boundaries", () => {
  test("a tool use: who acts, with what kind of tool, and every effect the call has", () => {
    expect<unknown>(ToolUse.parse(edit)).toEqual({
      ok: true,
      value: { kind: "tool-use", role: "builder", tool: "edit", effects: [{ kind: "write", path: "src/a.ts", change: "modify" }] },
    });
  });

  test("its effects keep the order given, each checked and normalised", () => {
    const rename = { role: null, tool: "edit", effects: [{ kind: "write", path: "./a.ts", change: "delete" }, { kind: "write", path: "b//a.ts", change: "create" }] };
    expect<unknown>(ToolUse.parse(rename)).toEqual({
      ok: true,
      value: { kind: "tool-use", role: null, tool: "edit", effects: [{ kind: "write", path: "a.ts", change: "delete" }, { kind: "write", path: "b/a.ts", change: "create" }] },
    });
  });

  test("the role is a role label, or null when no role is active", () => {
    expect(ToolUse.parse({ ...edit, role: null }).ok).toBe(true);
    expect(error({ ...edit, role: "Builder" })).toBe("Role 'Builder' must be lowercase words joined by single hyphens, such as 'builder'");
    expect(error({ tool: "edit", effects: edit.effects })).toBe("A tool use must name its role: a role label, or null when no role is active");
  });

  test("every host-neutral tool kind is accepted, and nothing else", () => {
    for (const tool of ["read", "search", "edit", "write", "shell", "web", "subagent", "other"]) expect(ToolUse.parse({ ...edit, tool }).ok).toBe(true);
    expect(error({ ...edit, tool: "bash" })).toBe("Tool kind 'bash' is not one of: read, search, edit, write, shell, web, subagent, other");
  });

  test("a call has at least one effect", () => {
    for (const effects of [[], undefined, "read", { kind: "read", path: "a" }]) {
      expect(error({ ...edit, effects })).toBe("A tool use's effects must be a non-empty list of what the call reads, lists, writes, executes, fetches, delegates or invokes");
    }
  });

  test("an invalid effect refuses the whole tool use, naming the effect by position", () => {
    expect(error({ ...edit, effects: [{ kind: "read", path: "a.ts" }, { kind: "write", path: "../b.ts", change: "create" }] })).toBe(
      "Effect 2 of 2: Path '../b.ts' climbs out of the project with '..'. Only paths inside the project can be checked",
    );
    expect(error({ ...edit, effects: [{ kind: "read", path: "/etc/hosts" }] })).toBe("Effect 1 of 1: Path '/etc/hosts' is absolute. Give it relative to the project root, such as 'src/a.ts'");
    expect(error({ ...edit, effects: ["src/a.ts"] })).toBe("Effect 1 of 1: An effect has kind read, list, write, execute, fetch, delegate or invoke");
  });

  test("refuses something that is not a tool use", () => {
    for (const raw of [undefined, null, "edit", []]) expect(error(raw)).toBe("A tool use is an object: { role, tool, effects }");
    expect(error({ ...edit, kind: "session-start" })).toBe("A tool use has kind 'tool-use', not 'session-start'");
  });

  test("is frozen, its effects too", () => {
    const result = ToolUse.parse(grep);
    expect(result.ok && Object.isFrozen(result.value) && Object.isFrozen(result.value.effects) && result.value.effects.every((e) => Object.isFrozen(e))).toBe(true);
  });
});

describe("ToolUse — never throws", () => {
  test("refuses an input whose fields cannot be read, saying so", () => {
    const hostile = new Proxy({}, { get: () => { throw new Error("trap"); }, has: () => { throw new Error("trap"); }, getOwnPropertyDescriptor: () => { throw new Error("trap"); } });
    expect(ToolUse.parse(hostile)).toEqual({ ok: false, error: "A tool use could not be read: trap" });
    const getter = Object.defineProperty({ ...edit }, "role", { enumerable: true, get: () => { throw new Error("no role"); } });
    expect(ToolUse.parse(getter)).toEqual({ ok: false, error: "A tool use could not be read: no role" });
  });

  test("a field whose text cannot be printed is refused, not thrown", () => {
    const trap = { toString: () => { throw new Error("no"); } };
    expect(ToolUse.parse({ ...edit, kind: trap }).ok).toBe(false);
  });

  test("reads only its own fields, never inherited ones", () => {
    expect(ToolUse.parse(Object.create(edit)).ok).toBe(false);
  });
});

describe("ToolUse — independent parts", () => {
  test("tool kind and effects are independent: the host classifies both", () => {
    expect(ToolUse.parse({ ...edit, tool: "shell" }).ok).toBe(true);
    expect(ToolUse.parse({ ...run, tool: "web" }).ok).toBe(true);
  });
});
