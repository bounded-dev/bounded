import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { BOOTSTRAP_RUNTIME, composeDemoPack, markDependenciesReady } from "../../test/support/bootstrap-project.ts";

// The dependency-free Claude Code entry, run as Claude Code runs it: a copied
// harness inside a project, one JSON tool call on stdin, one decision out.

const SOURCE = fileURLToPath(new URL("../../", import.meta.url));
const SETUP = "bash .bounded/harness/scripts/bounded setup";
const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "bounded-claude-bootstrap-"));
  roots.push(root);
  for (const rel of BOOTSTRAP_RUNTIME) {
    const dest = join(root, ".bounded", "harness", rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(SOURCE, rel), dest);
  }
  composeDemoPack(root);
  writeFileSync(join(root, "README.md"), "hello\n");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "export {};\n");
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "config"), "[core]\n");
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  return root;
}

/** Replace the full policy hook with a stub. */
function fullHook(root: string, body: string): void {
  writeFileSync(join(root, ".bounded", "harness", "hosts", "claude-code", "path-gate-hook.ts"), body);
}

type Outcome = { readonly allowed: boolean; readonly stdout: string; readonly reason?: string };

function call(root: string, input: string | object, args: readonly string[] = []): Outcome {
  const run = spawnSync(process.execPath, [join(root, ".bounded", "harness", "hosts", "claude-code", "bootstrap-hook.ts"), "--project-local", ...args], {
    cwd: root,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, BOUNDED_GUARD_LOG: "" },
    input: typeof input === "string" ? input : JSON.stringify({ cwd: root, hook_event_name: "PreToolUse", ...input }),
    encoding: "utf8",
  });
  expect(run.status).toBe(0);
  if (run.stdout.trim() === "") return { allowed: true, stdout: "" };
  const parsed = JSON.parse(run.stdout) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
  const decision = parsed.hookSpecificOutput?.permissionDecision;
  return { allowed: decision !== "deny", stdout: run.stdout, reason: parsed.hookSpecificOutput?.permissionDecisionReason };
}

const tool = (tool_name: string, tool_input: object, extra: object = {}): object => ({ tool_name, tool_input, ...extra });

function log(root: string): Record<string, unknown>[] {
  const path = join(root, ".bounded", "guard-log.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("before setup", () => {
  test("a hook run after a call prints nothing: there is nothing to refuse", () => {
    const root = project();
    const outcome = call(root, { ...tool("SendMessage", { to: "a1", message: "x" }), hook_event_name: "PostToolUse" }, ["--role", "architect"]);
    expect(outcome).toEqual({ allowed: true, stdout: "" });
  });

  test.each([
    ["Write", { file_path: "src/b.ts", content: "x" }],
    ["Edit", { file_path: "src/a.ts", old_string: "a", new_string: "b" }],
    ["Bash", { command: "ls" }],
    ["Bash", { command: `${SETUP} && rm -rf src` }],
    ["Agent", { subagent_type: "scout", prompt: "look" }],
    ["WebFetch", { url: "https://example.com" }],
    ["Skill", { skill: "team-lead" }],
  ])("%s is denied until setup completes", (name, input) => {
    const root = project();
    const outcome = call(root, tool(name, input));
    expect(outcome.allowed).toBe(false);
    expect(outcome.reason).toContain(SETUP);
    expect(log(root).at(-1)).toMatchObject({ guard: "team-lead", verdict: "block", detail: { host: "claude-code", kind: "bootstrap-setup-required" } });
  });

  test("the lead may re-plan initialization before setup, only before the first ticket and only in the plain form", () => {
    const root = project();
    const replan = "bounded init --host claude-code --surface browser-ui --surface persistence";
    expect(call(root, tool("Bash", { command: replan })).allowed).toBe(true);
    expect(call(root, tool("Bash", { command: `${replan} && rm -rf src` })).allowed).toBe(false);
    expect(call(root, tool("Bash", { command: "bounded init --host claude-code --cwd /tmp --surface desktop" })).allowed).toBe(false);
    expect(call(root, tool("Bash", { command: replan }, { agent_id: "a1", agent_type: "scout" })).allowed).toBe(false);
    writeFileSync(join(root, ".bounded", "active-ticket"), "1\n");
    expect(call(root, tool("Bash", { command: replan })).allowed).toBe(false);
  });

  test.each([
    ["Read", { file_path: join("src", "a.ts") }],
    ["Read", { file_path: "README.md" }],
    ["LS", { path: "src" }],
    ["Grep", { pattern: "export", path: "src", glob: "**/*.ts" }],
    ["Glob", { pattern: "**/*.ts", path: "src" }],
  ])("the lead may %s inside the project", (name, input) => {
    expect(call(project(), tool(name, input)).allowed).toBe(true);
  });

  test.each([
    ["Read", { file_path: "/etc/hosts" }],
    ["Read", { file_path: "../outside.txt" }],
    ["Read", { file_path: ".git/config" }],
    ["Read", {}],
    ["Read", { file_path: 7 }],
    ["LS", { path: "/" }],
    ["Grep", { pattern: "x", path: "/etc" }],
    ["Grep", { pattern: "x", glob: "../**" }],
    ["Glob", { pattern: "/etc/*" }],
    ["Glob", { pattern: ".git/**" }],
    ["Glob", { pattern: ".gi?/config" }],
    ["Glob", { pattern: "{.git,x}/**" }],
    ["Grep", { pattern: "x", glob: ".[g]it/**" }],
    ["Grep", { pattern: "x", glob: "**/.git*" }],
    ["Glob", {}],
    // The read tools search hidden files: a search at the root walks .git.
    ["Grep", { pattern: "url" }],
    ["Grep", { pattern: "url", path: "." }],
    ["Glob", { pattern: "*" }],
    ["Glob", { pattern: "config", path: "." }],
    ["LS", { path: ".git" }], // a one-level listing of the root is allowed (#35); .git is not
    // macOS and Windows open .GIT/config as .git/config.
    ["Read", { file_path: ".GIT/config" }],
    ["Read", { file_path: ".Git/HEAD" }],
    ["Glob", { pattern: ".GIT/**", path: "src" }],
    ["Glob", { pattern: "**/.GIT/*", path: "src" }],
    ["Grep", { pattern: "x", path: "src", glob: "[.]git/*" }],
  ])("a %s outside the project or with malformed paths is denied", (name, input) => {
    const root = project();
    const outcome = call(root, tool(name, input));
    expect(outcome.allowed).toBe(false);
    expect(log(root).at(-1)).toMatchObject({ detail: { host: "claude-code", kind: "bootstrap-read" } });
  });

  test("reads by a subagent or a bound role are denied", () => {
    const root = project();
    expect(call(root, tool("Read", { file_path: "README.md" }, { agent_id: "a1", agent_type: "scout" })).allowed).toBe(false);
    expect(call(root, tool("Read", { file_path: "README.md" }), ["--role", "builder"]).allowed).toBe(false);
  });

  test.each(["", "{not json", "[]", "null", '{"tool_input":{}}'])("unreadable input %j fails closed", (input) => {
    const root = project();
    const outcome = call(root, input);
    expect(outcome.allowed).toBe(false);
    expect(log(root).at(-1)).toMatchObject({ detail: { kind: "bootstrap-unreadable" } });
  });
});

describe("the setup command", () => {
  test("the lead at the project root may run it before the first run", () => {
    expect(call(project(), tool("Bash", { command: SETUP })).allowed).toBe(true);
  });

  test("a subagent, a bound role, or another working directory may not", () => {
    const root = project();
    expect(call(root, tool("Bash", { command: SETUP }, { agent_id: "a1" })).allowed).toBe(false);
    expect(call(root, tool("Bash", { command: SETUP }), ["--role", "architect"]).allowed).toBe(false);
    expect(call(root, tool("Bash", { command: SETUP }, { cwd: join(root, "src") })).allowed).toBe(false);
  });

  test("after a run started, setup is refused unless a completed setup is being repaired", () => {
    const root = project();
    writeFileSync(join(root, ".bounded", "guard-log.jsonl"), '{"guard":"run-start"}\n');
    expect(call(root, tool("Bash", { command: SETUP })).allowed).toBe(false);
    writeFileSync(join(root, ".bounded", "setup-complete"), "complete\n");
    expect(call(root, tool("Bash", { command: SETUP })).allowed).toBe(true);
  });

  // An intact setup after a run is never re-run: the architect may have
  // written an install script into package.json since.
  test("after a run, an intact setup cannot be re-run", () => {
    const root = project();
    writeFileSync(join(root, ".bounded", "guard-log.jsonl"), '{"guard":"run-start"}\n');
    markDependenciesReady(root);
    fullHook(root, "throw new Error('missing package');\n");
    expect(call(root, tool("Bash", { command: SETUP })).allowed).toBe(false);
  });

  test("a malformed guard-log line fails closed", () => {
    const root = project();
    writeFileSync(join(root, ".bounded", "guard-log.jsonl"), '{"guard":"team-lead"}\n{truncated\n');
    expect(call(root, tool("Bash", { command: SETUP })).allowed).toBe(false);
  });
});

describe("once dependencies are ready", () => {
  test("every call goes to the full policy hook with the same arguments", () => {
    const root = project();
    markDependenciesReady(root);
    fullHook(root, [
      'import { readFileSync } from "node:fs";',
      "const call = JSON.parse(readFileSync(0, 'utf8'));",
      "process.stdout.write(JSON.stringify({ full: process.argv.slice(2), tool: call.tool_name }));",
      "",
    ].join("\n"));
    const outcome = call(root, tool("Write", { file_path: "src/b.ts", content: "x" }), ["--role", "builder"]);
    expect(JSON.parse(outcome.stdout)).toEqual({ full: ["--project-local", "--role", "builder"], tool: "Write" });
  });

  test("a crashing full hook falls back to the read-only setup mode", () => {
    const root = project();
    markDependenciesReady(root);
    fullHook(root, "throw new Error('missing package');\n");
    expect(call(root, tool("Read", { file_path: "README.md" })).allowed).toBe(true);
    expect(call(root, tool("Bash", { command: SETUP })).allowed).toBe(true);
    const write = call(root, tool("Write", { file_path: "src/b.ts", content: "x" }));
    expect(write.allowed).toBe(false);
    expect(log(root).some((event) => event["verdict"] === "error" &&
      (event["detail"] as Record<string, unknown>)["kind"] === "full-hook-failed")).toBe(true);
  });
});

// ADR 2026-066: a call made in a ticket worktree under this project is judged
// by that worktree's own harness, with the worktree as the project.
describe("routing a ticket worktree's calls", () => {
  const STUB = (who: string): string =>
    `import { readFileSync } from "node:fs"; const p = JSON.parse(readFileSync(0, "utf8"));\n` +
    `if (p.hook_event_name === "WorktreeCreate") { process.stderr.write("no"); process.exit(1); }\n` +
    `process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "${who} " + process.env.CLAUDE_PROJECT_DIR + " " + process.argv.slice(2).join(" ") } }));\n`;

  function ticketed(): { main: string; wt: string } {
    const main = project();
    markDependenciesReady(main);
    fullHook(main, STUB("main"));
    const wt = join(main, ".bounded", "worktrees", "7");
    for (const rel of BOOTSTRAP_RUNTIME) {
      mkdirSync(dirname(join(wt, ".bounded", "harness", rel)), { recursive: true });
      cpSync(join(SOURCE, rel), join(wt, ".bounded", "harness", rel));
    }
    markDependenciesReady(wt);
    fullHook(wt, STUB("worktree"));
    writeFileSync(join(wt, ".bounded", "ticket-worktree.json"), JSON.stringify({ issue: 7, branch: "ticket/7", main, owns: [] }));
    mkdirSync(join(wt, "src"), { recursive: true });
    return { main, wt };
  }

  test("a subagent's call in the ticket worktree goes to the worktree's own hook, as its project, with its role", () => {
    const { main, wt } = ticketed();
    const routed = call(main, { ...tool("Write", { file_path: join(wt, "src/a.ts"), content: "" }, { agent_id: "a1", agent_type: "architect" }), cwd: join(wt, "src") }, ["--role", "architect"]);
    expect(routed.reason).toBe(`worktree ${realpathSync(wt)} --project-local --role architect`);
    const lead = call(main, tool("Read", { file_path: join(main, "README.md") }));
    expect(lead.reason).toContain("main ");
  });

  test("a ticket worktree without a hook gets a refusal, never a pass", () => {
    const { main, wt } = ticketed();
    rmSync(join(wt, ".bounded", "harness", "hosts", "claude-code", "bootstrap-hook.ts"));
    const out = call(main, { ...tool("Write", { file_path: join(wt, "x"), content: "" }, { agent_id: "a1" }), cwd: wt });
    expect(out.allowed).toBe(false);
    expect(out.reason).toContain("has no hook that could judge this call");
  });

  // Final review: a crashed worktree hook must never pass a call.
  test("a worktree hook that crashes is a refusal; an explicit block (exit 2) passes through", () => {
    const { main, wt } = ticketed();
    const call7 = () => call(main, { ...tool("Write", { file_path: join(wt, "x"), content: "" }, { agent_id: "a1" }), cwd: wt });
    const entry = join(wt, ".bounded", "harness", "hosts", "claude-code", "bootstrap-hook.ts");
    const original = readFileSync(entry, "utf8");
    writeFileSync(entry, `process.stderr.write("boom"); process.exit(1);\n`);
    const crashed = call7();
    writeFileSync(entry, original);
    expect(crashed.allowed).toBe(false);
    expect(crashed.reason).toContain("the ticket worktree's hook failed");
    writeFileSync(entry, `process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "blocked" } })); process.exit(2);\n`);
    const run = spawnSync(process.execPath, [join(main, ".bounded", "harness", "hosts", "claude-code", "bootstrap-hook.ts"), "--project-local"], {
      cwd: main, env: { ...process.env, CLAUDE_PROJECT_DIR: main, BOUNDED_GUARD_LOG: "" },
      input: JSON.stringify({ cwd: wt, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: join(wt, "x") }, agent_id: "a1" }), encoding: "utf8",
    });
    expect(run.status).toBe(2);
    expect(run.stdout).toContain("blocked");
  });

  test("WorktreeCreate's refusal by exit code passes through", () => {
    const { main } = ticketed();
    const run = spawnSync(process.execPath, [join(main, ".bounded", "harness", "hosts", "claude-code", "bootstrap-hook.ts"), "--project-local"], {
      cwd: main, env: { ...process.env, CLAUDE_PROJECT_DIR: main, BOUNDED_GUARD_LOG: "" },
      input: JSON.stringify({ cwd: main, hook_event_name: "WorktreeCreate", name: "agent-a1234567890abcdef" }), encoding: "utf8",
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
  });
});
