import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { ProjectPath, type Result } from "bounded/domain";
import { type Locate, locator } from "./pi-path.ts";
import { translate } from "./translate.ts";

// A lexical stand-in for the locator: the translation is pure given it.
const ROOT = "/project";
const EXISTING = new Set(["src/a.ts"]);
const fake: Locate = (raw, base) => {
  const absolute = resolve(base, raw);
  const path = ProjectPath.parse(relative(ROOT, absolute) || ".");
  if (!path.ok) return { ok: false, error: `Path '${raw}' is outside the project` };
  return { ok: true, value: { path: path.value, absolute, exists: EXISTING.has(path.value) } };
};
// Results are compared with plain objects, so they are typed as unknown values.
const pi = (toolName: string, input: unknown, cwd = ROOT): Result<unknown> => translate({ toolName, input }, cwd, fake);
const use = (tool: string, ...effects: unknown[]) => ({ ok: true as const, value: { kind: "tool-use", role: null, tool, effects } });
const refusal = (result: ReturnType<typeof pi>): string => (result.ok ? "allowed" : result.error);

describe("translate — pi's tools as host-neutral tool uses", () => {
  test("read reads its path", () => {
    expect(pi("read", { path: "src/a.ts", offset: 3 })).toEqual(use("read", { kind: "read", path: "src/a.ts" }));
  });

  test("write creates a file that does not exist and modifies one that does", () => {
    expect(pi("write", { path: "src/new.ts", content: "x" })).toEqual(use("write", { kind: "write", path: "src/new.ts", change: "create" }));
    expect(pi("write", { path: "src/a.ts", content: "x" })).toEqual(use("write", { kind: "write", path: "src/a.ts", change: "modify" }));
  });

  test("edit modifies its path", () => {
    expect(pi("edit", { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] })).toEqual(use("edit", { kind: "write", path: "src/a.ts", change: "modify" }));
  });

  test("ls lists its directory, the session's when none is given", () => {
    expect(pi("ls", { path: "src" })).toEqual(use("search", { kind: "list", root: "src" }));
    expect(pi("ls", {}, `${ROOT}/src`)).toEqual(use("search", { kind: "list", root: "src" }));
  });

  test("find lists its directory, filtered by its pattern", () => {
    expect(pi("find", { pattern: "*.ts", path: "src" })).toEqual(use("search", { kind: "list", root: "src", filter: "*.ts" }));
    expect(pi("find", { pattern: "**/*.json" })).toEqual(use("search", { kind: "list", root: ".", filter: "**/*.json" }));
  });

  test("grep lists its root, filtered by its glob, and reads it; the content pattern is not part of the event", () => {
    expect(pi("grep", { pattern: "TODO", path: "src", glob: "*.ts" })).toEqual(use("search", { kind: "list", root: "src", filter: "*.ts" }, { kind: "read", path: "src" }));
    expect(pi("grep", { pattern: "TODO" })).toEqual(use("search", { kind: "list", root: "." }, { kind: "read", path: "." }));
  });

  test("bash and powershell execute their command", () => {
    expect(pi("bash", { command: "ls -la", timeout: 5 })).toEqual(use("shell", { kind: "execute", command: "ls -la", cwd: "." }));
    expect(pi("powershell", { command: "Get-ChildItem" })).toEqual(use("shell", { kind: "execute", command: "Get-ChildItem", cwd: "." }));
  });

  test("a shell command runs in the session's directory, project-relative, which must be in the project", () => {
    expect(pi("bash", { command: "ls" }, `${ROOT}/src`)).toEqual(use("shell", { kind: "execute", command: "ls", cwd: "src" }));
    expect(refusal(pi("bash", { command: "ls" }, "/elsewhere"))).toContain("outside the project");
  });

  test("subagent delegates to every agent it names, single, parallel or chained", () => {
    expect(pi("subagent", { agent: "scout", task: "look" })).toEqual(use("subagent", { kind: "delegate", agent: "scout" }));
    expect(pi("subagent", { tasks: [{ agent: "a", task: "x" }, { agent: "b", task: "y" }] })).toEqual(use("subagent", { kind: "delegate", agent: "a" }, { kind: "delegate", agent: "b" }));
    expect(pi("subagent", { chain: [{ agent: "planner", task: "x" }] })).toEqual(use("subagent", { kind: "delegate", agent: "planner" }));
  });

  test("web_fetch fetches its url; web_search names no url, so it is invoked by name", () => {
    expect(pi("web_fetch", { url: "https://example.com/a" })).toEqual(use("web", { kind: "fetch", url: "https://example.com/a" }));
    expect(pi("web_search", { query: "bun sqlite" })).toEqual(use("web", { kind: "invoke", name: "web_search" }));
  });

  test("an unknown tool is 'other', invoked by name only, whatever its arguments", () => {
    expect(pi("deploy", { target: "prod" })).toEqual(use("other", { kind: "invoke", name: "deploy" }));
    expect(pi("mcp__github__create_issue", {})).toEqual(use("other", { kind: "invoke", name: "mcp__github__create_issue" }));
    expect(pi("remove", { path: "src/a.ts", cwd: "../elsewhere" })).toEqual(use("other", { kind: "invoke", name: "remove" }));
    expect(pi("remove", { path: "src/gone.ts" })).toEqual(use("other", { kind: "invoke", name: "remove" }));
  });

  test("pi's built-in tools ignore a cwd argument, so it changes nothing they are judged by", () => {
    expect(pi("read", { cwd: "public", path: "secrets.env" })).toEqual(use("read", { kind: "read", path: "secrets.env" }));
    expect(pi("write", { cwd: "src", path: "a.ts" })).toEqual(use("write", { kind: "write", path: "a.ts", change: "create" }));
    expect(pi("ls", { cwd: "../elsewhere" })).toEqual(use("search", { kind: "list", root: "." }));
    expect(pi("grep", { cwd: "src", pattern: "x" })).toEqual(use("search", { kind: "list", root: "." }, { kind: "read", path: "." }));
    expect(pi("bash", { cwd: "src", command: "ls" })).toEqual(use("shell", { kind: "execute", command: "ls", cwd: "." }));
  });
});

describe("translate — refuses what it cannot translate", () => {
  test("input that is not an object", () => {
    for (const input of [null, "src/a.ts", ["src/a.ts"], undefined]) expect(refusal(pi("read", input))).toContain("pi's read call has no input object");
  });

  test("a file tool without its path", () => {
    for (const tool of ["read", "write", "edit"]) expect(refusal(pi(tool, { file_path: "src/a.ts" }))).toBe(`pi's ${tool} call names no path in 'path'`);
  });

  test("a path outside the project, refused by the locator, for any tool", () => {
    for (const [tool, input] of [["read", { path: "../x" }], ["ls", { path: "/etc" }], ["grep", { pattern: "x", path: "../" }], ["subagent", { agent: "a", output: "../x.md" }]] as const) {
      expect(refusal(pi(tool, input))).toContain("outside the project");
    }
  });

  test("a shell call without a command, or with a NUL in it", () => {
    expect(refusal(pi("bash", {}))).toBe("pi's bash call names no command in 'command'");
    expect(refusal(pi("bash", { command: "  " }))).toBe("pi's bash call names no command in 'command'");
    expect(refusal(pi("bash", { command: "ls\0" }))).toContain("NUL");
  });

  test("a subagent call that names no agent, and a web fetch without its url", () => {
    expect(refusal(pi("subagent", { task: "x" }))).toBe("pi's subagent call names no agent");
    expect(refusal(pi("web_fetch", {}))).toBe("pi's web_fetch call names no url in 'url'");
  });

  test("a path or cwd that is not a string", () => {
    expect(refusal(pi("ls", { path: 3 }))).toBe("pi's ls call has a 'path' that is not a string");
    expect(refusal(pi("subagent", { agent: "a", cwd: 3 }))).toBe("pi's subagent call has a 'cwd' that is not a string");
  });

  test("never throws, even on input whose fields cannot be read", () => {
    const hostile = new Proxy({}, { get: () => { throw new Error("trap"); }, getOwnPropertyDescriptor: () => { throw new Error("trap"); } });
    expect(refusal(pi("read", hostile))).toContain("trap");
  });
});

describe("translate — with the real locator", () => {
  const project = mkdtempSync(join(tmpdir(), "bounded-pi-translate-"));
  mkdirSync(join(project, "pkg", "src"), { recursive: true });
  writeFileSync(join(project, "pkg", "src", "a.ts"), "");
  const real = locator(project, "/home/agent");

  test("a subagent's cwd is located before its output path, which starts there", () => {
    const result = translate({ toolName: "subagent", input: { agent: "scout", cwd: "pkg", output: "src/a.ts" } }, project, real);
    expect<unknown>(result).toEqual(use("subagent", { kind: "delegate", agent: "scout" }, { kind: "write", path: "pkg/src/a.ts", change: "modify" }));
  });

  test("a write's change comes from whether the file really exists", () => {
    const write = (path: string): Result<unknown> => translate({ toolName: "write", input: { path } }, project, real);
    expect(write("pkg/src/a.ts")).toEqual(use("write", { kind: "write", path: "pkg/src/a.ts", change: "modify" }));
    expect(write("pkg/src/b.ts")).toEqual(use("write", { kind: "write", path: "pkg/src/b.ts", change: "create" }));
  });
});

describe("translate — pi-subagents' subagent tool, read strictly", () => {
  test("recurses into a chain step's parallel tasks", () => {
    expect(pi("subagent", { chain: [{ agent: "a", task: "x" }, { parallel: [{ agent: "b" }, { agent: "c" }] }] })).toEqual(
      use("subagent", { kind: "delegate", agent: "a" }, { kind: "delegate", agent: "b" }, { kind: "delegate", agent: "c" }),
    );
  });

  test("every task and step names its agent", () => {
    expect(refusal(pi("subagent", { tasks: [{ agent: "a" }, { task: "x" }] }))).toBe("pi's subagent call has a task or step that names no agent");
    expect(refusal(pi("subagent", { chain: [{ agent: 3 }] }))).toBe("pi's subagent call has a task or step that names no agent");
    expect(refusal(pi("subagent", { chain: [{ parallel: [{ task: "x" }] }] }))).toBe("pi's subagent call has a task or step that names no agent");
    expect(refusal(pi("subagent", { tasks: "a" }))).toBe("pi's subagent call has a 'tasks' that is not a list of tasks");
  });

  test("refuses fields it does not know, at any level, naming them", () => {
    expect(refusal(pi("subagent", { agent: "a", workflowScript: "return 1" }))).toContain("'workflowScript'");
    expect(refusal(pi("subagent", { tasks: [{ agent: "a", reads: ["x"] }] }))).toContain("'reads'");
    expect(refusal(pi("subagent", { chain: [{ parallel: [{ agent: "a", progress: true }] }] }))).toContain("'progress'");
  });

  test("an output file is a write, from the call's cwd or the task's own", () => {
    expect(pi("subagent", { agent: "a", output: "notes/out.md" })).toEqual(use("subagent", { kind: "delegate", agent: "a" }, { kind: "write", path: "notes/out.md", change: "create" }));
    expect(pi("subagent", { tasks: [{ agent: "a", cwd: "src", output: "a.ts" }] })).toEqual(use("subagent", { kind: "delegate", agent: "a" }, { kind: "write", path: "src/a.ts", change: "modify" }));
    expect(pi("subagent", { agent: "a", output: false })).toEqual(use("subagent", { kind: "delegate", agent: "a" }));
    expect(refusal(pi("subagent", { agent: "a", output: true }))).toBe("pi's subagent call has an 'output' that is not a file path or false");
  });

  test("status and resume are invoked by name; other actions are refused", () => {
    expect(pi("subagent", { action: "status" })).toEqual(use("subagent", { kind: "invoke", name: "subagent.status" }));
    expect(pi("subagent", { action: "status", id: "r1", view: "transcript" })).toEqual(use("subagent", { kind: "invoke", name: "subagent.status" }));
    expect(pi("subagent", { action: "resume", id: "r1", message: "go on" })).toEqual(use("subagent", { kind: "invoke", name: "subagent.resume" }));
    expect(refusal(pi("subagent", { action: "delete", agent: "x" }))).toBe("pi's subagent call uses action 'delete', which bounded does not translate");
    expect(refusal(pi("subagent", { action: "status", agent: "a", task: "x" }))).toContain("'task'");
  });
});

describe("translate — the subagent tool's reach", () => {
  test("only project agents are translated: another agentScope is refused", () => {
    expect(pi("subagent", { agent: "a", agentScope: "project" })).toEqual(use("subagent", { kind: "delegate", agent: "a" }));
    for (const scope of ["user", "both", 3]) {
      expect(refusal(pi("subagent", { agent: "a", agentScope: scope }))).toBe(`pi's subagent call uses agentScope '${scope}'; only 'project' is translated`);
    }
  });

  test("a status or resume run directory must be inside the project", () => {
    expect(pi("subagent", { action: "status", dir: "runs/r1" })).toEqual(use("subagent", { kind: "invoke", name: "subagent.status" }));
    expect(refusal(pi("subagent", { action: "status", dir: "../elsewhere" }))).toContain("outside the project");
    expect(refusal(pi("subagent", { action: "resume", dir: "/tmp/run", message: "go" }))).toContain("outside the project");
    expect(refusal(pi("subagent", { action: "status", dir: 3 }))).toBe("pi's subagent call has a 'dir' that is not a string");
  });
});
