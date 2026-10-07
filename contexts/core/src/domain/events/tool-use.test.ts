import { describe, expect, test } from "bun:test";
import { valueObjectLaws } from "../shared/value-object.laws.test-support.ts";
import { ToolUse } from "./tool-use.ts";

const edit = { role: "builder", tool: "edit", action: "write", paths: ["src/a.ts"] };
const run = { role: null, tool: "shell", action: "run", paths: [], command: "make build" };
const search = { role: null, tool: "search", action: "read", paths: [], search: { root: "src", filter: "*.ts" } };

valueObjectLaws("ToolUse", ToolUse, [edit, run, search], [{ ...edit, tool: "bash" }, { ...edit, paths: ["/etc/hosts"] }, { ...run, command: undefined }]);

const error = (raw: unknown): string | undefined => {
  const result = ToolUse.parse(raw);
  return result.ok ? undefined : result.error;
};

describe("ToolUse — boundaries", () => {
  test("a tool use: who acts, with what kind of tool, how, on which paths", () => {
    expect<unknown>(ToolUse.parse(edit)).toEqual({
      ok: true,
      value: { kind: "tool-use", role: "builder", tool: "edit", action: "write", paths: ["src/a.ts"], command: null, search: null },
    });
  });

  test("a run carries its command, exactly as given", () => {
    const result = ToolUse.parse({ ...run, command: " make build " });
    expect(result.ok && result.value.command).toBe(" make build ");
  });

  test("its paths are normalised project-relative paths, in the order given", () => {
    const result = ToolUse.parse({ ...edit, paths: ["./b//c.ts", "a/../a.ts", "."] });
    expect<unknown>(result.ok && result.value.paths).toEqual(["b/c.ts", "a.ts", "."]);
  });

  test("the role is a role label, or null when no role is active", () => {
    expect(ToolUse.parse({ ...edit, role: null }).ok).toBe(true);
    expect(error({ ...edit, role: "Builder" })).toBe("Role 'Builder' must be lowercase words joined by single hyphens, such as 'builder'");
    expect(error({ tool: "edit", action: "write", paths: [] })).toBe("A tool use must name its role: a role label, or null when no role is active");
  });

  test("every host-neutral tool kind is accepted, and nothing else", () => {
    for (const tool of ["read", "search", "edit", "write", "shell", "web", "subagent", "other"]) expect(ToolUse.parse({ ...edit, tool }).ok).toBe(true);
    expect(error({ ...edit, tool: "bash" })).toBe("Tool kind 'bash' is not one of: read, search, edit, write, shell, web, subagent, other");
  });

  test("the action is read, write or run", () => {
    expect(ToolUse.parse({ ...edit, action: "read" }).ok).toBe(true);
    expect(error({ ...edit, action: "delete" })).toBe("Action 'delete' is not one of: read, write, run");
  });

  test("a path that is absolute or climbs out refuses the whole tool use, naming the path", () => {
    expect(error({ ...edit, paths: ["src/a.ts", "../b.ts"] })).toBe("Path '../b.ts' climbs out of the project with '..'. Only paths inside the project can be checked");
    expect(error({ ...edit, paths: ["/etc/hosts"] })).toBe("Path '/etc/hosts' is absolute. Give it relative to the project root, such as 'src/a.ts'");
    expect(error({ ...edit, paths: "src/a.ts" })).toBe("A tool use's paths must be a list of project-relative paths");
  });

  test("a run must name its command, and only a run has one", () => {
    expect(error({ ...run, command: undefined })).toBe("A run must name the command it runs");
    expect(error({ ...run, command: "  " })).toBe("A run must name the command it runs");
    expect(error({ ...edit, command: "cat a" })).toBe("Only a run carries a command; a write does not");
    expect(ToolUse.parse({ ...edit, command: null }).ok).toBe(true);
  });

  test("a search can say where it searches: the directory searched and the file-name filter that limits it", () => {
    expect<unknown>(ToolUse.parse(search)).toEqual({
      ok: true,
      value: { kind: "tool-use", role: null, tool: "search", action: "read", paths: [], command: null, search: { root: "src", filter: "*.ts" } },
    });
    const whole = ToolUse.parse({ ...search, search: { root: "./" } });
    expect<unknown>(whole.ok && whole.value.search).toEqual({ root: ".", filter: null });
    const unsaid = ToolUse.parse({ ...search, search: undefined });
    expect(unsaid.ok && unsaid.value.search).toBeNull();
  });

  test("a search's root is a project path and its filter is non-empty text; only a search carries them", () => {
    expect(error({ ...search, search: { root: "../x" } })).toBe("Path '../x' climbs out of the project with '..'. Only paths inside the project can be checked");
    expect(error({ ...search, search: { filter: "*.ts" } })).toBe("A search is { root, filter }: root the project-relative directory searched, filter the file-name pattern that limits it, or null");
    expect(error({ ...search, search: { root: "src", filter: " " } })).toBe("A search is { root, filter }: root the project-relative directory searched, filter the file-name pattern that limits it, or null");
    expect(error({ ...edit, search: { root: "src" } })).toBe("Only a search carries search details; an edit does not");
  });

  test("refuses something that is not a tool use", () => {
    for (const raw of [undefined, null, "edit", []]) expect(error(raw)).toBe("A tool use is an object: { role, tool, action, paths, command, search }");
    expect(error({ ...edit, kind: "session-start" })).toBe("A tool use has kind 'tool-use', not 'session-start'");
  });

  test("is frozen, its paths and search too", () => {
    const result = ToolUse.parse(search);
    expect(result.ok && Object.isFrozen(result.value) && Object.isFrozen(result.value.paths) && Object.isFrozen(result.value.search)).toBe(true);
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
  test("tool kind and action are independent: the host classifies both", () => {
    expect(ToolUse.parse({ ...edit, tool: "shell", action: "write" }).ok).toBe(true);
    expect(ToolUse.parse({ ...run, tool: "web" }).ok).toBe(true);
  });

  test("a command must not contain a NUL character", () => {
    expect(error({ ...run, command: "rm a\0b" })).toBe("A command must not contain a NUL character");
  });
});
