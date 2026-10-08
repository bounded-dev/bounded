import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installPathGate } from "./extensions/path-gate.ts";
import { readGuardLog } from "../../src/guard-log.ts";
import { resetPathGateRegistry } from "../../src/path-gate.ts";
import type { TempProject } from "../../test/support/temp-project.ts";
import { makeLeadProject } from "../../test/support/lead-project.ts";

// ADR 2026-048 on pi: in a project's own harness copy, the root session is
// the read-only team lead and an unbound child is held to the scout's
// read-only policy. Both go through the same seat resolution and policy as
// Claude Code; this file pins the pi adapter's wiring.

const LEAD_COMMAND_TOOLS = ["lead_ticket_create", "lead_queue", "lead_start", "lead_status", "lead_reply", "lead_merge", "lead_board", "lead_sync_config"];
const FULL = ["read", "grep", "find", "ls", "bash", "edit", "write", "web_search", "subagent", "subagent_wait",
  "contact_supervisor", "subagent_supervisor", ...LEAD_COMMAND_TOOLS, "lead_setup", "lead_replan"];
const REGISTERED = [...LEAD_COMMAND_TOOLS, "lead_replan", "lead_setup"].sort();

type Handler = (event: unknown, ctx: unknown) => unknown;
interface Tool { readonly name: string; execute(...args: unknown[]): Promise<{ content: { text: string }[]; details: unknown }> }

function fakePi() {
  let active = [...FULL];
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, Tool>();
  const pi = {
    on(event: string, handler: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    getActiveTools: () => [...active],
    setActiveTools(names: string[]) { active = [...names]; },
    // Like pi, refuse a tool name registered twice in one process.
    registerTool(tool: Tool) {
      if (tools.has(tool.name)) throw new Error(`Tool "${tool.name}" conflicts`);
      tools.set(tool.name, tool);
    },
  };
  return {
    pi: pi as unknown as Parameters<typeof installPathGate>[0],
    start(cwd: string) { for (const h of handlers.get("session_start") ?? []) h({}, { cwd }); },
    async call(cwd: string, toolName: string, input: Record<string, unknown>): Promise<{ block: true; reason: string } | undefined> {
      for (const h of handlers.get("tool_call") ?? []) {
        const r = await h({ toolName, input }, { cwd });
        if (r !== undefined) return r as { block: true; reason: string };
      }
      return undefined;
    },
    active: () => active,
    async run(name: string, params: Record<string, unknown>, cwd: string): Promise<string> {
      const tool = tools.get(name);
      if (tool === undefined) throw new Error(`${name} not registered`);
      return (await tool.execute("id", params, undefined, undefined, { cwd })).content[0]!.text;
    },
    tools,
  };
}

const projects: TempProject[] = [];
function project(files: Readonly<Record<string, string>> = {}): string {
  const p = makeLeadProject(files);
  projects.push(p);
  return p.dir;
}
beforeEach(() => {
  resetPathGateRegistry();
  vi.stubEnv("PI_SUBAGENT_CHILD", undefined);
  vi.stubEnv("BOUNDED_DEV_STAGE_ROLE", undefined);
  vi.stubEnv("BOUNDED_TICKET", undefined);
  vi.stubEnv("BOUNDED_GUARD_LOG", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetPathGateRegistry();
  while (projects.length) projects.pop()?.cleanup();
});

describe("pi lead session", () => {
  test("session start strips the lead to reads, lookups, commissions and its commands", () => {
    const dir = project();
    const fake = fakePi();
    installPathGate(fake.pi, undefined, { projectCopy: true });
    expect([...fake.tools.keys()].sort()).toEqual(REGISTERED);
    fake.start(dir);
    expect(fake.active()).toEqual(["read", "grep", "find", "ls", "web_search", "subagent", "subagent_wait",
      "contact_supervisor", "subagent_supervisor", ...LEAD_COMMAND_TOOLS, "lead_setup", "lead_replan"]);
  });

  test("a pipeline child loads the ambient gate and its role loader without a tool conflict", () => {
    const fake = fakePi();
    installPathGate(fake.pi, undefined, { projectCopy: true });
    installPathGate(fake.pi, "architect", { projectCopy: true });
    expect([...fake.tools.keys()].sort()).toEqual(REGISTERED);
  });

  test("tool calls go through the lead policy", async () => {
    const dir = project({ "docs/a.md": "" });
    const fake = fakePi();
    installPathGate(fake.pi, undefined, { projectCopy: true });
    expect(await fake.call(dir, "read", { path: "docs/a.md" })).toBeUndefined();
    expect(await fake.call(dir, "subagent", { agent: "scout", task: "look" })).toBeUndefined();
    expect(await fake.call(dir, "subagent", { action: "status" })).toBeUndefined();
    // A commissioned seat that escalates must be answerable (dogfood: an
    // architect paused on a supervisor request the lead could not reply to).
    expect(await fake.call(dir, "subagent_supervisor", { action: "reply", replyTo: "r1", message: "go ahead" })).toBeUndefined();
    expect(await fake.call(dir, "subagent_supervisor", { action: "pending" })).toBeUndefined();
    const refused: readonly [string, Record<string, unknown>, string][] = [
      ["bash", { command: "ls" }, "outside the read-only lead toolset"],
      ["write", { path: "a", content: "" }, "outside the read-only lead toolset"],
      ["subagent", { chain: [] }, "'chain' is not allowed"],
      ["subagent", { workflowScript: "x" }, "'workflowScript' is not allowed"],
      // A field allowlist: anything that backgrounds, moves, forks or
      // publishes the seat is refused without being named in advance.
      ["subagent", { agent: "scout", task: "x", async: true }, "'async' is not allowed"],
      ["subagent", { agent: "scout", task: "x", worktree: true }, "'worktree' is not allowed"],
      ["subagent", { agent: "scout", task: "x", isolation: "worktree" }, "'isolation' is not allowed"],
      ["subagent", { agent: "scout", task: "x", cwd: "/elsewhere" }, "'cwd' is not allowed"],
      ["subagent", { agent: "scout", task: "x", share: true }, "'share' is not allowed"],
      ["subagent", { agent: "scout", task: "x", context: "fork" }, "'context' is not allowed"],
      ["subagent", { agent: "scout", task: "x", output: "out.md" }, "'output' is not allowed"],
      ["subagent", { agent: "scout", task: "x", sessionDir: "/tmp/s" }, "'sessionDir' is not allowed"],
      ["subagent", { action: "status", share: true }, "may not carry 'share'"],
      ["find", { path: "src", pattern: ".gi?/config" }, "away from .git"],
      ["grep", { path: "src", pattern: "x", glob: "{.git,x}/**" }, "away from .git"],
      ["subagent", { agent: "scout", task: "x", agentScope: "user" }, "bound definitions"],
      ["subagent", { agent: "scout", subagent_type: "builder", task: "x" }, "role fields disagree"],
      ["subagent", { agent: "builder", task: "x" }, "only the scout"],
      ["subagent", { agent: "architect", task: "x" }, "run bounded lead start <issue> first"],
      ["subagent", { action: "resume", id: "r" }, "only a reply prepared with bounded lead reply"],
      ["subagent_supervisor", { action: "send", to: "architect", message: "x" }, "does not start them"],
      ["subagent_supervisor", { action: "ask", to: "architect", message: "x" }, "does not start them"],
      ["subagent_supervisor", { action: "reply", replyTo: "r1", message: "x", timeoutMs: 1 }, "may not carry 'timeoutMs'"],
    ];
    for (const [tool, input, why] of refused) {
      const r = await fake.call(dir, tool, input);
      expect(r?.reason, `${tool} ${JSON.stringify(input)}`).toContain(why);
    }
    expect(readGuardLog(dir).filter((e) => e.guard === "team-lead" && e.verdict === "block")).toHaveLength(refused.length);
  });

  test("the lead command tools validate with the shared parser, then run the command", async () => {
    const dir = project();
    const fake = fakePi();
    installPathGate(fake.pi, undefined, { projectCopy: true });
    expect(await fake.call(dir, "lead_start", { issue: "4" })).toBeUndefined();
    expect(await fake.run("lead_start", { issue: "x" }, dir)).toContain("usage: bounded lead start <issue>");
    expect(await fake.run("lead_reply", { issue: "4", message: " " }, dir)).toContain("usage: bounded lead reply <issue> <message>");
    expect(await fake.run("lead_ticket_create", { title: "t", outcome: "o", acceptance: "a", owns: [], decisions: "d" }, dir))
      .toContain("at least one owned path");
    // The command itself runs: this temporary project is no main worktree on main.
    expect(await fake.run("lead_status", {}, dir)).toContain("the lead works on main");
  });

  test("lead_replan is held only before the first ticket, and validates with the shared parser", async () => {
    const dir = project();
    const fake = fakePi();
    installPathGate(fake.pi, undefined, { projectCopy: true });
    expect(await fake.call(dir, "lead_replan", { surfaces: ["browser-ui"] })).toBeUndefined();
    expect(await fake.run("lead_replan", { surfaces: ["Browser UI"] }, dir)).toContain("re-plan with exactly: bounded init --host pi");
    mkdirSync(join(dir, ".bounded/lead/tickets"), { recursive: true });
    writeFileSync(join(dir, ".bounded/lead/tickets/1.json"), "{}\n");
    fake.start(dir);
    expect(fake.active()).not.toContain("lead_replan");
    expect((await fake.call(dir, "lead_replan", { surfaces: ["browser-ui"] }))?.reason).toContain("only before the first ticket");
    expect(await fake.run("lead_replan", { surfaces: ["browser-ui"] }, dir)).toContain("only before the first ticket");
  });

  test("outside a project installation the lead tools are hidden and nothing is judged", async () => {
    const dir = project();
    const fake = fakePi();
    installPathGate(fake.pi, undefined, { projectCopy: true });
    fake.start(join(dir, "docs"));
    expect(fake.active()).not.toContain("lead_start");
    expect(fake.active()).toContain("bash");
    expect(await fake.call(join(dir, "docs"), "bash", { command: "ls" })).toBeUndefined();
  });
});

describe("a ticket worktree's own pi session (ADR 2026-066)", () => {
  const ticket = (): string => project({ ".bounded/ticket-worktree.json": JSON.stringify({ issue: 3, branch: "ticket/3", main: "/m" }), "docs/a.md": "" });

  test("an unbound top-level session there is only read-only, never a lead", async () => {
    const dir = ticket();
    const fake = fakePi();
    installPathGate(fake.pi, undefined, { projectCopy: true });
    fake.start(dir);
    expect(fake.active()).not.toContain("lead_start");
    expect(await fake.call(dir, "read", { path: "docs/a.md" })).toBeUndefined();
    expect((await fake.call(dir, "write", { path: "docs/a.md", content: "" }))?.reason).toMatch(/^scout: /);
    expect(await fake.run("lead_status", {}, dir)).toContain("only the project-local lead");
  });

  test("the launched architect binds its role through its loader; the ambient copy stands down", async () => {
    const dir = ticket();
    const ambient = fakePi();
    installPathGate(ambient.pi, undefined, { projectCopy: true });
    const bound = fakePi();
    installPathGate(bound.pi, "architect", { projectCopy: true });
    bound.start(dir);
    expect(bound.active()).not.toContain("lead_start");
    expect(await ambient.call(dir, "write", { path: "docs/a.md", content: "" })).toBeUndefined();
    expect((await bound.call(dir, "lead_merge", { issue: "3" }))?.reason).toContain("cannot redraw the run boundary");
  });
});

describe("pi child sessions", () => {
  test("an unbound child is the read-only scout", async () => {
    vi.stubEnv("PI_SUBAGENT_CHILD", "1");
    const dir = project({ "docs/a.md": "" });
    const fake = fakePi();
    installPathGate(fake.pi, undefined, { projectCopy: true });
    fake.start(dir);
    expect(fake.active()).toEqual(["read", "grep", "find", "ls", "subagent_wait", "contact_supervisor"]);
    expect(await fake.call(dir, "read", { path: "docs/a.md" })).toBeUndefined();
    expect(await fake.call(dir, "contact_supervisor", { reason: "need_decision" })).toBeUndefined();
    for (const [tool, input] of [["bash", { command: "ls" }], ["write", { path: "a" }], ["web_search", { query: "x" }],
      ["subagent", { agent: "scout", task: "x" }], ["lead_start", { issue: "1" }], ["read", { path: ".git/HEAD" }],
      ["subagent_supervisor", { action: "reply", replyTo: "r1", message: "x" }]] as const) {
      expect((await fake.call(dir, tool, input))?.reason, tool).toMatch(/^scout: /);
    }
    expect(await fake.run("lead_start", { issue: "1" }, dir)).toContain("only the project-local lead");
    expect(readGuardLog(dir).some((e) => e.guard === "path-gate" && e.detail?.["role"] === "scout")).toBe(true);
  });

  test("a bound role process: the role is gated, the lead tools are refused, the ambient copy stands down", async () => {
    vi.stubEnv("PI_SUBAGENT_CHILD", "1");
    const dir = project();
    const ambient = fakePi();
    installPathGate(ambient.pi, undefined, { projectCopy: true });
    const bound = fakePi();
    installPathGate(bound.pi, "builder", { projectCopy: true });
    bound.start(dir);
    expect(bound.active()).not.toContain("lead_start");
    expect(bound.active()).not.toContain("lead_replan");
    expect((await bound.call(dir, "lead_start", { issue: "1" }))?.reason).toContain("cannot redraw the run boundary");
    expect((await bound.call(dir, "lead_replan", { surfaces: ["desktop"] }))?.reason).toContain("cannot redraw the run boundary");
    expect(await ambient.call(dir, "bash", { command: "ls" })).toBeUndefined();
  });
});
