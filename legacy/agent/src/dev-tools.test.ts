import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import installDevTools from "../hosts/pi/extensions/dev-tools.ts";
import { readGuardLog } from "./guard-log.ts";
import { ROLE_TOOLS } from "./path-policy.ts";

// dev-tools is a worker role's whole world: none of them has `bash`, so
// anything a role cannot do through these tools it cannot do at all. Two things
// are therefore worth pinning — that the registration surface still matches what
// the role allowlists promise, and that `remove` (the only tool here with real
// mechanics of its own) behaves exactly as its description claims.
//
// run_tests, typecheck and record_design_review are deliberately NOT executed
// here: the first two take no injectable command runner from this layer, so
// calling execute() would spawn vitest/tsc for real, and the third is covered
// directly in packs/ts/scripts/design-review.test.ts. What typecheck SHOWS a
// worker is covered the same way — packs/ts/scripts/typecheck-scope.test.ts —
// so what is pinned here is the half that only exists in the registration: the
// description and guidelines that tell the worker its view is scoped.

interface ToolResult {
  readonly content: readonly { readonly type: string; readonly text: string }[];
  readonly details?: Record<string, unknown>;
}

interface RecordedTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: { properties?: Record<string, unknown>; required?: string[] };
  execute(
    toolCallId: string,
    params: { path?: string; cwd?: string },
    signal: AbortSignal | undefined,
    onUpdate: () => void,
    ctx: { cwd: string },
  ): Promise<ToolResult>;
}

/** Minimal ExtensionAPI stub: records the tool specs dev-tools registers. */
function registered(): Map<string, RecordedTool> {
  const tools = new Map<string, RecordedTool>();
  const pi = {
    registerTool(spec: RecordedTool) {
      tools.set(spec.name, spec);
    },
    on() {
      /* dev-tools installs no hooks today; tolerate it if it starts */
    },
  };
  installDevTools(pi as never);
  return tools;
}

const TOOLS = registered();

function tool(name: string): RecordedTool {
  const spec = TOOLS.get(name);
  if (spec === undefined) throw new Error(`dev-tools no longer registers '${name}'`);
  return spec;
}

const dirs: string[] = [];
function project(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "dev-tools-"));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function removeEvents(cwd: string) {
  return readGuardLog(cwd).filter((e) => e.guard === "remove");
}

function callRemove(ctxCwd: string, params: { path: string; cwd?: string }): Promise<ToolResult> {
  return tool("remove").execute("call-1", params, undefined, () => {}, { cwd: ctxCwd });
}

describe("dev-tools registration surface", () => {
  test("registers exactly the developer-stage worker tools", () => {
    expect([...TOOLS.keys()].sort()).toEqual([
      "change_diff",
      "record_design_review",
      "remove",
      "run_tests",
      "typecheck",
    ]);
  });

  // The worker roles' allowlists are frontmatter strings — a rename here would
  // otherwise surface only as a builder that silently cannot run its tests, or
  // a reviewer with nothing to record its findings into.
  test("provides every non-builtin tool the worker roles are allowed to hold", () => {
    const BUILTIN = new Set(["read", "grep", "find", "ls", "write", "edit"]);
    for (const role of ["test-writer", "builder", "reviewer"] as const) {
      for (const name of ROLE_TOOLS[role]) {
        if (BUILTIN.has(name)) continue;
        expect([...TOOLS.keys()], `ROLE_TOOLS.${role} names '${name}' but dev-tools does not register it`).toContain(name);
      }
    }
  });

  test("run_tests and typecheck take an optional cwd and require nothing", () => {
    for (const name of ["run_tests", "typecheck"]) {
      const params = tool(name).parameters;
      expect(Object.keys(params.properties ?? {})).toEqual(["cwd"]);
      expect(params.required ?? []).toEqual([]);
    }
  });

  // The reviewer holds no pen but this one, so its shape is load-bearing: an
  // empty list must be passable (recording "I found nothing" is the point), and
  // the cwd must stay optional like every sibling.
  test("record_design_review requires findings and nothing else", () => {
    const params = tool("record_design_review").parameters;
    expect(params.required).toEqual(["findings"]);
    expect(Object.keys(params.properties ?? {}).sort()).toEqual(["cwd", "findings"]);
  });

  test("record_design_review says the review covers a file set, challenged once", () => {
    const description = tool("record_design_review").description;
    expect(description).toMatch(/empty list is a valid review/);
    expect(description).toMatch(/added or removed|whole design once/);
  });

  // A worker that is not TOLD its typecheck is scoped reads a shrunken error
  // list as the whole truth. Dogfood Run 15's builder did the opposite of that
  // and reshaped its implementation around a test file's diagnostic; the tool
  // now hides those, so it must also say what it hides and whose they are.
  test("typecheck tells the caller its view is scoped and foreign errors are not theirs", () => {
    const spec = tool("typecheck");
    expect(spec.description).toMatch(/SCOPED TO YOUR ROLE/);
    expect(spec.description).toMatch(/count and an owner only|no symbol names/);
    const guidelines = (spec as unknown as { promptGuidelines?: string[] }).promptGuidelines ?? [];
    expect(guidelines.join("\n")).toMatch(/not yours to fix|do not block you/);
    expect(guidelines.join("\n")).toMatch(/clean in your zone/);
  });

  test("remove requires a path", () => {
    const params = tool("remove").parameters;
    expect(params.required).toEqual(["path"]);
    expect(Object.keys(params.properties ?? {}).sort()).toEqual(["cwd", "path"]);
  });
});

describe("remove", () => {
  test("deletes a file relative to the session cwd and logs the removal", async () => {
    const cwd = project({ "src/orders/orders.ts": "export const x = 1;\n" });
    const res = await callRemove(cwd, { path: "src/orders/orders.ts" });
    expect(existsSync(join(cwd, "src/orders/orders.ts"))).toBe(false);
    expect(res.details).toEqual({ ok: true, existed: true });
    expect(res.content[0]!.text).toContain("src/orders/orders.ts");

    const events = removeEvents(cwd);
    expect(events).toHaveLength(1);
    expect(events[0]!.verdict).toBe("pass");
    expect(events[0]!.detail).toEqual({ path: "src/orders/orders.ts" });
  });

  test("accepts an absolute path", async () => {
    const cwd = project({ "a.ts": "" });
    const res = await callRemove(cwd, { path: join(cwd, "a.ts") });
    expect(res.details).toEqual({ ok: true, existed: true });
    expect(existsSync(join(cwd, "a.ts"))).toBe(false);
  });

  test("a cwd override relocates a relative path", async () => {
    const session = project({ "a.ts": "keep me", "sub/a.ts": "delete me" });
    const res = await callRemove(session, { path: "a.ts", cwd: "sub" });
    expect(res.details).toEqual({ ok: true, existed: true });
    expect(existsSync(join(session, "sub/a.ts"))).toBe(false);
    expect(existsSync(join(session, "a.ts"))).toBe(true); // the session copy is untouched
  });

  // Deleting nothing is not an error the builder should have to reason about,
  // but it is also not a removal — so it must not appear in the audit trail.
  test("a missing file is a no-op, not a failure, and is not logged", async () => {
    const cwd = project();
    const res = await callRemove(cwd, { path: "nope.ts" });
    expect(res.details).toEqual({ ok: true, existed: false });
    expect(res.content[0]!.text).toContain("does not exist");
    expect(removeEvents(cwd)).toEqual([]);
  });

  // "A recursive delete is a blast radius, not a capability."
  test("refuses a directory and leaves it and its contents intact", async () => {
    const cwd = project({ "src/orders/orders.ts": "export const x = 1;\n" });
    const res = await callRemove(cwd, { path: "src" });
    expect(res.details).toEqual({ ok: false });
    expect(res.content[0]!.text).toContain("is a directory");
    expect(existsSync(join(cwd, "src/orders/orders.ts"))).toBe(true);
    expect(removeEvents(cwd)).toEqual([]);
  });

  // A symlink is a file, and deleting it must delete the link — never follow
  // it into whatever it points at.
  test("removing a symlink to a directory unlinks it without touching the target", async () => {
    const cwd = project({ "src/orders/orders.ts": "export const x = 1;\n" });
    symlinkSync(join(cwd, "src"), join(cwd, "link"));
    const res = await callRemove(cwd, { path: "link" });
    expect(res.details).toEqual({ ok: true, existed: true });
    expect(existsSync(join(cwd, "link"))).toBe(false);
    expect(existsSync(join(cwd, "src/orders/orders.ts"))).toBe(true);
  });
});
