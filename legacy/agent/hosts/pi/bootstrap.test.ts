import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { composeDemoPack, markDependenciesReady } from "../../test/support/bootstrap-project.ts";
import { BOOTSTRAP_SETUP_TOOL, enterProject, type ExtensionModule } from "./bootstrap.ts";
import { LEAD_SETUP_TOOL } from "../../src/lead-policy.ts";

// The pi entry must make the same decisions as the Claude Code bootstrap hook.
// A small fake stands in for pi's extension API.

type Handler = (event: Record<string, unknown>, ctx: { cwd: string }) => unknown;

function fakePi(active: string[]) {
  const handlers: Record<string, Handler[]> = {};
  const tools: string[] = [];
  let current = [...active];
  const pi = {
    registerTool: (tool: { name: string }) => { tools.push(tool.name); },
    on: (event: string, handler: Handler) => { (handlers[event] ??= []).push(handler); },
    getActiveTools: () => current,
    setActiveTools: (next: string[]) => { current = next; },
  };
  const toolCall = (cwd: string, toolName: string, input: Record<string, unknown> = {}): unknown =>
    (handlers["tool_call"] ?? []).map((handler) => handler({ toolName, input }, { cwd })).find((result) => result !== undefined);
  const start = (cwd: string): string[] => {
    for (const handler of handlers["session_start"] ?? []) handler({}, { cwd });
    return current;
  };
  return { api: pi as unknown as ExtensionAPI, tools, toolCall, start, handlers };
}

const roots: string[] = [];
const childFlag = process.env["PI_SUBAGENT_CHILD"];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
  if (childFlag === undefined) delete process.env["PI_SUBAGENT_CHILD"];
  else process.env["PI_SUBAGENT_CHILD"] = childFlag;
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "bounded-pi-bootstrap-"));
  roots.push(root);
  composeDemoPack(root);
  writeFileSync(join(root, "README.md"), "hello\n");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "export {};\n");
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "config"), "[core]\n");
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  return root;
}

const blocked = (result: unknown): boolean => (result as { block?: boolean } | undefined)?.block === true;
const neverLoad = (): Promise<readonly ExtensionModule[]> => { throw new Error("full adapter must not load"); };

describe("before setup", () => {
  test("only project reads and lead_setup remain; everything else is blocked", async () => {
    delete process.env["PI_SUBAGENT_CHILD"];
    const root = project();
    const pi = fakePi(["read", "ls", "grep", "find", "bash", "edit", "write", "subagent", "lead_setup"]);
    await enterProject(pi.api, root, neverLoad);
    expect(pi.tools).toEqual(["lead_setup"]);
    expect(pi.start(root)).toEqual(["read", "ls", "grep", "find", "lead_setup"]);
    for (const [name, input] of [["write", { path: "a.ts", content: "x" }], ["edit", { path: "README.md" }], ["bash", { command: "ls" }], ["subagent", { agent: "scout" }]] as const) {
      expect(blocked(pi.toolCall(root, name, input))).toBe(true);
    }
    expect(pi.toolCall(root, "read", { path: "README.md" })).toBeUndefined();
    expect(pi.toolCall(root, "ls", { path: "src" })).toBeUndefined();
    expect(pi.toolCall(root, "find", { path: "src", pattern: "**/*.ts" })).toBeUndefined();
    expect(pi.toolCall(root, "grep", { path: "src", pattern: "export" })).toBeUndefined();
    expect(pi.toolCall(root, "lead_setup")).toBeUndefined();
    const events = readFileSync(join(root, ".bounded", "guard-log.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(events.at(-1)).toMatchObject({ guard: "team-lead", verdict: "block", detail: { host: "pi", kind: "bootstrap-setup-required", tool: "subagent" } });
  });

  test.each([
    ["read", { path: "/etc/hosts" }],
    ["read", { path: "../x" }],
    ["read", { path: ".git/config" }],
    ["read", {}],
    ["grep", { pattern: "x", glob: "../**" }],
    ["find", { pattern: ".git/**" }],
    ["find", { pattern: ".gi?/config" }],
    ["find", { pattern: "{.git,x}/**" }],
    ["grep", { pattern: "x", glob: ".[g]it/**" }],
    ["grep", { pattern: "x", glob: "**/.git*" }],
    // The read tools search hidden files: a search at the root walks .git.
    ["grep", { pattern: "url" }],
    ["grep", { pattern: "url", path: "." }],
    ["find", { pattern: "*" }],
    ["find", { path: ".", pattern: "config" }],
    ["ls", {}],
    ["ls", { path: ".git" }], // a one-level listing of the root is allowed (#35); .git is not
    // macOS and Windows open .GIT/config as .git/config.
    ["read", { path: ".GIT/config" }],
    ["read", { path: ".Git/HEAD" }],
    ["find", { path: "src", pattern: ".GIT/**" }],
    ["find", { path: "src", pattern: "**/.GIT/*" }],
    ["grep", { path: "src", pattern: "x", glob: "[.]git/*" }],
  ])("%s %j outside the project or malformed is blocked", async (name, input) => {
    delete process.env["PI_SUBAGENT_CHILD"];
    const root = project();
    const pi = fakePi([]);
    await enterProject(pi.api, root, neverLoad);
    expect(blocked(pi.toolCall(root, name, input))).toBe(true);
  });

  test("a child process or another directory is not the lead", async () => {
    const root = project();
    const pi = fakePi(["read", "lead_setup"]);
    await enterProject(pi.api, root, neverLoad);
    process.env["PI_SUBAGENT_CHILD"] = "1";
    expect(blocked(pi.toolCall(root, "read", { path: "README.md" }))).toBe(true);
    expect(pi.start(root)).toEqual([]);
    delete process.env["PI_SUBAGENT_CHILD"];
    expect(blocked(pi.toolCall(join(root, "src"), "lead_setup"))).toBe(true);
  });

  test("a malformed guard-log line closes setup; a completed setup reopens it for repair", async () => {
    delete process.env["PI_SUBAGENT_CHILD"];
    const root = project();
    writeFileSync(join(root, ".bounded", "guard-log.jsonl"), "{truncated\n");
    const pi = fakePi(["read", "lead_setup"]);
    await enterProject(pi.api, root, neverLoad);
    expect(blocked(pi.toolCall(root, "lead_setup"))).toBe(true);
    writeFileSync(join(root, ".bounded", "setup-complete"), "complete\n");
    expect(pi.toolCall(root, "lead_setup")).toBeUndefined();
  });

  // An intact setup after a run is never re-run: the architect may have
  // written an install script into package.json since.
  test("after a run, an intact setup cannot be re-run", async () => {
    delete process.env["PI_SUBAGENT_CHILD"];
    const root = project();
    writeFileSync(join(root, ".bounded", "guard-log.jsonl"), '{"guard":"run-start"}\n');
    markDependenciesReady(root);
    const pi = fakePi(["read", "lead_setup"]);
    await enterProject(pi.api, root, async () => { throw new Error("missing package"); });
    expect(blocked(pi.toolCall(root, "lead_setup"))).toBe(true);
    expect(pi.start(root)).toEqual(["read"]);
  });
});

describe("the dependency-free copies", () => {
  test("the bootstrap setup tool is the lead policy's setup tool", () => {
    expect(BOOTSTRAP_SETUP_TOOL).toBe(LEAD_SETUP_TOOL);
  });

  test("the lead is recognised at the project root through a linked path, as on Claude Code", async () => {
    delete process.env["PI_SUBAGENT_CHILD"];
    const root = project();
    const alias = `${root}-alias`;
    symlinkSync(root, alias);
    roots.push(alias);
    const pi = fakePi(["read", "lead_setup"]);
    await enterProject(pi.api, root, neverLoad);
    expect(pi.toolCall(alias, "lead_setup")).toBeUndefined();
    expect(pi.toolCall(alias, "read", { path: "README.md" })).toBeUndefined();
  });
});

describe("once dependencies are ready", () => {
  test("the full adapter loads and project roles are the default subagent scope", async () => {
    const root = project();
    markDependenciesReady(root);
    const pi = fakePi([]);
    const loaded: string[] = [];
    await enterProject(pi.api, root, async () => [{ default: () => { loaded.push("full"); } }]);
    expect(loaded).toEqual(["full"]);
    expect(pi.tools).toEqual([]);
    const input: Record<string, unknown> = { agent: "scout" };
    expect(pi.toolCall(root, "subagent", input)).toBeUndefined();
    expect(input["agentScope"]).toBe("project");
    expect(pi.toolCall(root, "write", { path: "x" })).toBeUndefined(); // the full adapter decides
  });

  test("a failed full load falls back to the read-only setup mode", async () => {
    delete process.env["PI_SUBAGENT_CHILD"];
    const root = project();
    markDependenciesReady(root);
    const pi = fakePi([]);
    await enterProject(pi.api, root, async () => { throw new Error("missing package"); });
    expect(pi.tools).toEqual(["lead_setup"]);
    expect(blocked(pi.toolCall(root, "write", { path: "x" }))).toBe(true);
    expect(pi.toolCall(root, "read", { path: "README.md" })).toBeUndefined();
    expect(pi.toolCall(root, "lead_setup")).toBeUndefined();
    const log = join(root, ".bounded", "guard-log.jsonl");
    expect(existsSync(log)).toBe(true);
    expect(readFileSync(log, "utf8")).toContain('"kind":"full-adapter-failed"');
  });
});
