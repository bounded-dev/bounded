import { describe, expect, test } from "bun:test";
import { ToolUse, Verdict } from "bounded/domain";
import { type PathResolver, toToolUse } from "./event.ts";
import type { HostCall } from "./translate.ts";

/** A value's wire form: its JSON, parsed. */
const wireOf = (value: unknown): unknown => JSON.parse(JSON.stringify(value) ?? "null");

// A stand-in for the file system: '/p' is the project; a raw path containing
// 'old' exists; one starting 'bad' is refused.
const paths: PathResolver = {
  resolve: (raw, cwd) =>
    raw.startsWith("bad")
      ? { ok: false, error: Verdict.refuse(`Path '${raw}' is bad`, "Use a good one") }
      : { ok: true, value: { path: (raw.startsWith("/") ? raw : `${cwd}/${raw}`).replace(/^\/p\/?/, "") || ".", exists: raw.includes("old") } },
};
const at = { role: null, cwd: "/p", paths };

const event = (call: HostCall, context: Parameters<typeof toToolUse>[1] = at) => {
  const result = toToolUse(call, context);
  if (!result.ok) throw new Error(result.error.reason);
  return result.value;
};

describe("toToolUse: a translated call, its paths resolved, as a host-neutral event", () => {
  test("paths become project-relative, resolved against the session's directory", () => {
    expect(wireOf(event({ tool: "read", effects: [{ kind: "read", path: "/p/src/a.ts" }] }))).toEqual({ kind: "tool-use", role: null, tool: "read", effects: [{ kind: "read", path: "src/a.ts" }] });
    expect(wireOf(event({ tool: "read", effects: [{ kind: "read", path: "a.ts" }] }, { ...at, cwd: "/p/src" }).effects)).toEqual([{ kind: "read", path: "src/a.ts" }]);
  });

  test("a write that may create is a create when the file does not exist, a modify when it does", () => {
    expect(wireOf(event({ tool: "write", effects: [{ kind: "write", path: "/p/new.ts", change: "create-or-modify" }] }).effects)).toEqual([{ kind: "write", path: "new.ts", change: "create" }]);
    expect(wireOf(event({ tool: "write", effects: [{ kind: "write", path: "/p/old.ts", change: "create-or-modify" }] }).effects)).toEqual([{ kind: "write", path: "old.ts", change: "modify" }]);
    expect(wireOf(event({ tool: "edit", effects: [{ kind: "write", path: "/p/new.ts", change: "modify" }] }).effects)).toEqual([{ kind: "write", path: "new.ts", change: "modify" }]);
  });

  test("a list's root is resolved; its filter is kept, and left out when the host gave none", () => {
    const search = event({ tool: "search", effects: [{ kind: "list", root: ".", filter: "*.md" }, { kind: "list", root: "/p/docs" }] });
    // The core's list effect always has a filter: null when the host gave none.
    expect(wireOf(search.effects)).toEqual([{ kind: "list", root: ".", filter: "*.md" }, { kind: "list", root: "docs", filter: null }]);
    expect(search.effects[1]?.kind === "list" && search.effects[1].filter).toBeNull();
  });

  test("effects without paths pass as they are", () => {
    const effects = [{ kind: "execute", command: "ls" }, { kind: "fetch", url: "https://example.com" }, { kind: "delegate", agent: "Explore" }, { kind: "invoke", name: "Skill" }] as const;
    // The core's execute effect always has a cwd: null when the host gave none.
    expect(wireOf(event({ tool: "other", effects: [...effects] }).effects)).toEqual([{ ...effects[0], cwd: null }, ...effects.slice(1)]);
  });

  test("an execute's cwd is resolved to a project-relative directory; one the resolver refuses refuses the call", () => {
    expect(wireOf(event({ tool: "shell", effects: [{ kind: "execute", command: "ls", cwd: "." }] }, { ...at, cwd: "/p/src" }).effects)).toEqual([{ kind: "execute", command: "ls", cwd: "src" }]);
    expect(wireOf(event({ tool: "shell", effects: [{ kind: "execute", command: "ls", cwd: "." }] }).effects)).toEqual([{ kind: "execute", command: "ls", cwd: "." }]);
    const outside = toToolUse({ tool: "shell", effects: [{ kind: "execute", command: "ls", cwd: "bad-dir" }] }, at);
    expect(outside).toEqual({ ok: false, error: Verdict.refuse("Path 'bad-dir' is bad", "Use a good one") });
  });

  test("the role is a checked role label, or null", () => {
    expect(event({ tool: "shell", effects: [{ kind: "execute", command: "ls" }] }, { ...at, role: "builder" }).role?.value).toBe("builder");
    const bad = toToolUse({ tool: "shell", effects: [{ kind: "execute", command: "ls" }] }, { ...at, role: "Not A Role" });
    expect(bad).toEqual({ ok: false, error: Verdict.refuse("Role 'Not A Role' must be lowercase words joined by single hyphens, such as 'builder'", "Start the hook with --role naming a role label") });
  });

  test("the event is the core's, built by its parse", () => {
    const made = event({ tool: "read", effects: [{ kind: "read", path: "/p/a" }] });
    expect(ToolUse.parse(made)).toEqual({ ok: true, value: made });
  });

  test("the event and its effects are frozen", () => {
    const made = event({ tool: "read", effects: [{ kind: "read", path: "/p/a" }] });
    expect(Object.isFrozen(made)).toBe(true);
    expect(Object.isFrozen(made.effects)).toBe(true);
    expect(Object.isFrozen(made.effects[0])).toBe(true);
  });

  test("any path the resolver refuses refuses the whole call", () => {
    const result = toToolUse({ tool: "edit", effects: [{ kind: "write", path: "/p/ok", change: "modify" }, { kind: "write", path: "bad/x", change: "modify" }] }, at);
    expect(result).toEqual({ ok: false, error: Verdict.refuse("Path 'bad/x' is bad", "Use a good one") });
  });

  test("a resolved path the core would not accept is refused", () => {
    const odd: PathResolver = { resolve: () => ({ ok: true, value: { path: "a\\b", exists: true } }) };
    const result = toToolUse({ tool: "read", effects: [{ kind: "read", path: "x" }] }, { ...at, paths: odd });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe("Path 'a\\b' contains '\\'. Separate its parts with '/'");
  });

  test("a call with no effects is refused: every tool use does something", () => {
    const result = toToolUse({ tool: "other", effects: [] }, at);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe("A tool use must have at least one effect");
  });
});
