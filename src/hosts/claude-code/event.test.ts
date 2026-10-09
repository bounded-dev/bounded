import { describe, expect, test } from "bun:test";
import { type ShellCommandReadingJSON, ToolUse, Verdict } from "bounded/domain";
import type { ReadShellCommand } from "bounded-shell-command-reader/shell-command-reading";
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
/** The reading the stand-in reader gives every command: one running tool-a from the project root. */
const READ: ShellCommandReadingJSON = { outcome: "read", programs: [{ name: { kind: "literal", text: "tool-a" }, arguments: [], workingDirectory: "." }], fileEffects: [], unresolved: [] };
/** What the stand-in reader was asked to read, in order. */
const reads: unknown[] = [];
const readShellCommand: ReadShellCommand = {
  prepare: async () => {},
  read: async (input) => {
    reads.push(input);
    return READ;
  },
};
const at = { role: null, cwd: "/p", paths, projectRoot: "/p", readShellCommand };

const event = async (call: HostCall, context: Parameters<typeof toToolUse>[1] = at) => {
  const result = await toToolUse(call, context);
  if (!result.ok) throw new Error(result.error.reason);
  return result.value;
};

describe("toToolUse: a translated call, its paths resolved, as a host-neutral event", () => {
  test("paths become project-relative, resolved against the session's directory", async () => {
    expect(wireOf(await event({ tool: "read", effects: [{ kind: "read", path: "/p/src/a.ts" }] }))).toEqual({ kind: "tool-use", role: null, tool: "read", effects: [{ kind: "read", path: "src/a.ts" }] });
    expect(wireOf((await event({ tool: "read", effects: [{ kind: "read", path: "a.ts" }] }, { ...at, cwd: "/p/src" })).effects)).toEqual([{ kind: "read", path: "src/a.ts" }]);
  });

  test("a write that may create is a create when the file does not exist, a modify when it does", async () => {
    expect(wireOf((await event({ tool: "write", effects: [{ kind: "write", path: "/p/new.ts", change: "create-or-modify" }] })).effects)).toEqual([{ kind: "write", path: "new.ts", change: "create" }]);
    expect(wireOf((await event({ tool: "write", effects: [{ kind: "write", path: "/p/old.ts", change: "create-or-modify" }] })).effects)).toEqual([{ kind: "write", path: "old.ts", change: "modify" }]);
    expect(wireOf((await event({ tool: "edit", effects: [{ kind: "write", path: "/p/new.ts", change: "modify" }] })).effects)).toEqual([{ kind: "write", path: "new.ts", change: "modify" }]);
  });

  test("a list's root is resolved; its filter is kept, and left out when the host gave none", async () => {
    const search = await event({ tool: "search", effects: [{ kind: "list", root: ".", filter: "*.md" }, { kind: "list", root: "/p/docs" }] });
    // The core's list effect always has a filter: null when the host gave none.
    expect(wireOf(search.effects)).toEqual([{ kind: "list", root: ".", filter: "*.md" }, { kind: "list", root: "docs", filter: null }]);
    expect(search.effects[1]?.kind === "list" && search.effects[1].filter).toBeNull();
  });

  test("effects without paths pass as they are", async () => {
    const effects = [{ kind: "execute", command: "ls" }, { kind: "fetch", url: "https://example.com" }, { kind: "delegate", agent: "Explore" }, { kind: "invoke", name: "Skill" }] as const;
    // The core's execute effect always has a cwd (null when the host gave none) and the reading the host adapter built.
    expect(wireOf((await event({ tool: "other", effects: [...effects] })).effects)).toEqual([{ ...effects[0], cwd: null, reading: READ }, ...effects.slice(1)]);
  });

  test("an isolated delegation, or one whose finish is unreported, reaches the core as one", async () => {
    const made = await event({ tool: "subagent", effects: [{ kind: "delegate", agent: "plan-reviewer", isolated: true }, { kind: "delegate", agent: "builder", finishUnreported: true }] });
    expect(wireOf(made.effects)).toEqual([{ kind: "delegate", agent: "plan-reviewer", isolated: true }, { kind: "delegate", agent: "builder", finishUnreported: true }]);
    const [first, second] = made.effects;
    expect(first?.kind === "delegate" && first.isolated).toBe(true);
    expect(second?.kind === "delegate" && second.finishUnreported).toBe(true);
  });

  test("an execute's cwd is resolved to a project-relative directory; one the resolver refuses refuses the call", async () => {
    expect(wireOf((await event({ tool: "shell", effects: [{ kind: "execute", command: "ls", cwd: "." }] }, { ...at, cwd: "/p/src" })).effects)).toEqual([{ kind: "execute", command: "ls", cwd: "src", reading: READ }]);
    expect(wireOf((await event({ tool: "shell", effects: [{ kind: "execute", command: "ls", cwd: "." }] })).effects)).toEqual([{ kind: "execute", command: "ls", cwd: ".", reading: READ }]);
    const outside = await toToolUse({ tool: "shell", effects: [{ kind: "execute", command: "ls", cwd: "bad-dir" }] }, at);
    expect(outside).toEqual({ ok: false, error: Verdict.refuse("Path 'bad-dir' is bad", "Use a good one") });
  });

  test("an execute effect carries the reading the reader gives for its command, read from the project's root and the command's resolved directory", async () => {
    reads.length = 0;
    const made = await event({ tool: "shell", effects: [{ kind: "execute", command: "ls", cwd: "." }] }, { ...at, cwd: "/p/src" });
    expect(reads).toEqual([{ projectRoot: "/p", command: "ls", cwd: "src" }]);
    const [effect] = made.effects;
    expect(effect?.kind === "execute" && effect.reading.toJSON()).toEqual(READ);
  });

  test("the role is a checked role label, or null", async () => {
    expect((await event({ tool: "shell", effects: [{ kind: "execute", command: "ls" }] }, { ...at, role: "builder" })).role?.value).toBe("builder");
    const bad = await toToolUse({ tool: "shell", effects: [{ kind: "execute", command: "ls" }] }, { ...at, role: "Not A Role" });
    expect(bad).toEqual({ ok: false, error: Verdict.refuse("Role 'Not A Role' must be lowercase words joined by single hyphens, such as 'builder'", "Start the hook with --role naming a role label") });
  });

  test("the event is the core's, built by its parse", async () => {
    const made = await event({ tool: "read", effects: [{ kind: "read", path: "/p/a" }] });
    expect(ToolUse.parse(made)).toEqual({ ok: true, value: made });
  });

  test("the event and its effects are frozen", async () => {
    const made = await event({ tool: "read", effects: [{ kind: "read", path: "/p/a" }] });
    expect(Object.isFrozen(made)).toBe(true);
    expect(Object.isFrozen(made.effects)).toBe(true);
    expect(Object.isFrozen(made.effects[0])).toBe(true);
  });

  test("any path the resolver refuses refuses the whole call", async () => {
    const result = await toToolUse({ tool: "edit", effects: [{ kind: "write", path: "/p/ok", change: "modify" }, { kind: "write", path: "bad/x", change: "modify" }] }, at);
    expect(result).toEqual({ ok: false, error: Verdict.refuse("Path 'bad/x' is bad", "Use a good one") });
  });

  test("a resolved path the core would not accept is refused", async () => {
    const odd: PathResolver = { resolve: () => ({ ok: true, value: { path: "a\\b", exists: true } }) };
    const result = await toToolUse({ tool: "read", effects: [{ kind: "read", path: "x" }] }, { ...at, paths: odd });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe("Path 'a\\b' contains '\\'. Separate its parts with '/'");
  });

  test("a call with no effects is refused: every tool use does something", async () => {
    const result = await toToolUse({ tool: "other", effects: [] }, at);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe("A tool use must have at least one effect");
  });
});
