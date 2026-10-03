import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { logGuardEvent, readGuardLog, type LoggedGuardEvent } from "../../src/guard-log.ts";
import { makeTempProject as makeProject, type TempProject } from "../../test/support/temp-project.ts";
import {
  CLAUDE_COMMISSIONS,
  continuableWorker,

  sendTarget,
  launchOutcome,
  unresolvedLaunchCaller,
  workerRole,
} from "./continuation.ts";
import { licenseUnknownOutcome, runHook } from "./path-gate-hook.ts";

// #33: on Claude Code a bounce goes to the worker that already ran, continued
// with SendMessage, bound and gated. The mechanism was verified live on Claude
// Code 2.1.286 (continuation.ts); these fixtures pin the hook's half of it.

const C = "contexts/m/src";
const W1 = "a8426c7de5ac73ff5";

const projects: TempProject[] = [];
afterEach(() => {
  while (projects.length) projects.pop()?.cleanup();
});

/** A project whose design is complete, so a worker launch is judged only on
 *  the cold-relaunch rule. */
function readyProject(): string {
  const project = makeProject({}, { prefix: "cc-continue-", packs: ["ts", "ts-hexagonal"] });
  projects.push(project);
  const dir = project.dir;
  writeFileSync(join(dir, "spec.md"), "## Intake\n\nNothing stripped.\n\n## Rules\n\n" + "x".repeat(4000));
  mkdirSync(join(dir, C), { recursive: true });
  writeFileSync(join(dir, C, "money.contract.ts"), "export type Money = number;\n");
  for (const guard of ["contract-purity", "scaffold", "checksum-gate"]) {
    logGuardEvent(dir, { guard, verdict: "pass", summary: "step passed" });
  }
  return dir;
}

interface Outcome {
  readonly decision: "allow" | "deny";
  readonly reason: string;
}

function hook(dir: string, event: string, tool: string, input: unknown, extra: Readonly<Record<string, unknown>> = {}, role = "architect"): Outcome {
  vi.stubEnv("BOUNDED_GUARD_LOG", undefined);
  vi.stubEnv("BOUNDED_DEV_STAGE_ROLE", undefined);
  try {
    const stdin = JSON.stringify({ session_id: "s1", cwd: dir, hook_event_name: event, tool_name: tool, tool_input: input, ...extra });
    const out = runHook(["--role", role], stdin, dir);
    if (out.stdout.trim() === "") return { decision: "allow", reason: "" };
    const parsed = JSON.parse(out.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string } };
    return parsed.hookSpecificOutput.permissionDecision === "deny"
      ? { decision: "deny", reason: parsed.hookSpecificOutput.permissionDecisionReason ?? "" }
      : { decision: "allow", reason: "" };
  } finally {
    vi.unstubAllEnvs();
  }
}

/** What the lead's project-wide hook records after its architect's Agent call
 *  completes (lead-hook.ts recordLeadArchitectOutcome). */
function leadSawArchitectEnd(dir: string, agentId: string): void {
  vi.stubEnv("BOUNDED_GUARD_LOG", undefined);
  try {
    runHook(["--project-local"], JSON.stringify({
      session_id: "s1", cwd: dir, hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: `t-${agentId}`,
      tool_input: { subagent_type: "architect", prompt: "deliver" },
      tool_response: { status: "completed", agentId, agentType: "architect" },
    }), dir);
  } finally {
    vi.unstubAllEnvs();
  }
}

const launch = (dir: string, role: string): Outcome => hook(dir, "PreToolUse", "Agent", { subagent_type: role, prompt: "do it" });
const finished = (dir: string, role: string, worker: string): Outcome =>
  hook(dir, "PostToolUse", "Agent", { subagent_type: role, prompt: "do it" },
    { tool_response: { status: "completed", agentId: worker, agentType: role, content: [] } });
const send = (dir: string, input: Readonly<Record<string, unknown>>, role = "architect"): Outcome =>
  hook(dir, "PreToolUse", "SendMessage", input, {}, role);
const phase = (dir: string) => readGuardLog(dir).filter((e) => e.guard === "phase-gate");

describe("Claude Code: a bounce continues the worker that already ran", () => {
  test("a second cold launch is refused, naming SendMessage and the worker's id — and no pi action", () => {
    const dir = readyProject();
    expect(launch(dir, "test-writer").decision).toBe("allow");
    finished(dir, "test-writer", W1);
    const again = launch(dir, "test-writer");
    expect(again.decision).toBe("deny");
    expect(again.reason).toContain("A bounce goes back to the worker that already ran");
    expect(again.reason).toContain(`\`SendMessage\` with \`{ to: "${W1}", message: "<the bounce>" }\``);
    expect(again.reason).not.toMatch(/children\.list|action: "resume"/);
  });

  test("SendMessage to that worker is allowed and recorded as a continuation of its role", () => {
    const dir = readyProject();
    launch(dir, "test-writer");
    finished(dir, "test-writer", W1);
    const r = send(dir, { to: W1, message: "red bounced: fix the spurious passes", summary: "bounce", type: "message", recipient: W1, content: "red bounced: fix the spurious passes" });
    expect(r.decision).toBe("allow");
    expect(phase(dir).at(-1)).toMatchObject({ verdict: "pass", detail: { kind: "resume", target: "test-writer", run: W1 } });
  });

  test("SendMessage is allowed when Claude Code's 'content' is only a preview of the message", () => {
    // What a hook receives on Claude Code 2.1.288: the host adds type and
    // recipient, and fills content with the message cut to 50 characters.
    const message = "CONTRACT-DISPUTE acknowledged: the adapter-law candidate list is a generator defect. Run the tests now.";
    const dir = readyProject();
    launch(dir, "builder");
    finished(dir, "builder", W1);
    const r = send(dir, { to: W1, message, summary: "Builder: run full suite now tests exist", type: "message", recipient: W1, content: `${message.slice(0, 49)}\u2026` });
    expect(r.decision).toBe("allow");
    expect(phase(dir).at(-1)).toMatchObject({ verdict: "pass", detail: { kind: "resume", target: "builder", run: W1 } });
  });

  test("the worker id comes only from the architect's own PostToolUse record", () => {
    const dir = readyProject();
    launch(dir, "test-writer");
    finished(dir, "test-writer", W1);
    expect(phase(dir).at(-1)).toMatchObject({ detail: { kind: "worker-started", target: "test-writer", worker: W1 } });
    // A worker's hook does not record, and a result for another role or a
    // non-pipeline agent records nothing.
    const started = () => phase(dir).filter((e) => (e.detail as { kind?: string }).kind === "worker-started").length;
    const before = started();
    hook(dir, "PostToolUse", "Agent", { subagent_type: "builder" }, { tool_response: { agentId: "a0000000000000002", agentType: "builder" } }, "builder");
    hook(dir, "PostToolUse", "Agent", { subagent_type: "builder" }, { tool_response: { agentId: "a0000000000000003", agentType: "reviewer" } });
    hook(dir, "PostToolUse", "Agent", { subagent_type: "general-purpose" }, { tool_response: { agentId: "a0000000000000004", agentType: "general-purpose" } });
    expect(started()).toBe(before);
  });

  test.each([
    ["the main conversation", { to: "main", message: "hi" }],
    ["an unknown agent", { to: "a0000000000000000", message: "hi" }],
    ["another session by name", { to: "worker [3fa9c1]", message: "hi" }],
    ["an idle subscription", { to: W1, message: "hi", notify_when_idle: true }],
    ["an empty bounce", { to: W1, message: "  " }],
    ["a recipient that differs from to", { to: W1, message: "hi", recipient: "main" }],
    ["a non-message type", { to: W1, message: "hi", type: "shutdown_request", recipient: W1 }],
  ])("SendMessage to %s is refused", (_label, input) => {
    const dir = readyProject();
    launch(dir, "test-writer");
    finished(dir, "test-writer", W1);
    const r = send(dir, input);
    expect(r.decision).toBe("deny");
    expect(phase(dir).at(-1)).toMatchObject({ verdict: "block", detail: { kind: "spawn-refused", tool: "SendMessage" } });
  });

  test.each(["test-writer", "builder", "reviewer"])("the %s may not use SendMessage at all", (role) => {
    const dir = readyProject();
    launch(dir, "test-writer");
    finished(dir, "test-writer", W1);
    const r = send(dir, { to: W1, message: "do my work" }, role);
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain(`${role} may not use 'SendMessage'`);
  });

  test("a continuation that fails licenses a fresh launch of that role only", () => {
    const dir = readyProject();
    launch(dir, "test-writer");
    finished(dir, "test-writer", W1);
    launch(dir, "builder");
    finished(dir, "builder", "ab00000000000000b");
    hook(dir, "PostToolUseFailure", "SendMessage", { to: W1, message: "bounce" }, { error: "No transcript found" });
    expect(launch(dir, "test-writer").decision).toBe("allow");
    expect(launch(dir, "builder").decision).toBe("deny");
  });

  test("a SendMessage that reports no success licenses the same way; a delivered one does not", () => {
    const dir = readyProject();
    launch(dir, "test-writer");
    finished(dir, "test-writer", W1);
    hook(dir, "PostToolUse", "SendMessage", { to: W1, message: "bounce" }, { tool_response: { success: true, message: "Resumed agent." } });
    expect(launch(dir, "test-writer").decision).toBe("deny");
    hook(dir, "PostToolUse", "SendMessage", { to: W1, message: "bounce" }, { tool_response: { success: false, message: "Failed to resume agent" } });
    expect(launch(dir, "test-writer").decision).toBe("allow");
  });

  test("a launch still running licenses nothing: two parallel launches of one role are refused", () => {
    const dir = readyProject();
    expect(launch(dir, "builder").decision).toBe("allow");
    expect(launch(dir, "builder").decision).toBe("deny"); // no Post event yet
  });

  test("a background launch is a running worker of the role asked: a second launch is refused, continuing it is allowed", () => {
    const dir = readyProject();
    launch(dir, "builder");
    hook(dir, "PostToolUse", "Agent", { subagent_type: "builder", prompt: "do it" }, { tool_response: { status: "async_launched", agentId: W1 } });
    expect(phase(dir).at(-1)).toMatchObject({ detail: { kind: "worker-started", target: "builder", worker: W1 } });
    expect(launch(dir, "builder").decision).toBe("deny");
    expect(send(dir, { to: W1, message: "bounce" }).decision).toBe("allow");
  });

  test("when recording a launch's outcome itself fails, the launch is licensed and the error logged", () => {
    const dir = readyProject();
    launch(dir, "builder");
    licenseUnknownOutcome("architect", { event: "PostToolUse", toolName: "Agent", toolInput: { subagent_type: "builder" } }, dir, new Error("boom"));
    expect(readGuardLog(dir).some((e) => e.verdict === "error" && e.summary.includes("boom"))).toBe(true);
    expect(launch(dir, "builder").decision).toBe("allow");
  });

  test("a result that proves nothing licenses nothing", () => {
    const dir = readyProject();
    launch(dir, "builder");
    hook(dir, "PostToolUse", "Agent", { subagent_type: "builder", prompt: "do it" }, { tool_response: { status: "something new" } });
    expect(launch(dir, "builder").decision).toBe("deny");
  });

  test("a launch left without an outcome by an earlier architect may be relaunched by its successor, never by itself", () => {
    const dir = readyProject();
    const first = { agent_id: "a0000000000000aaa", agent_type: "architect" };
    const next = { agent_id: "a0000000000000bbb", agent_type: "architect" };
    expect(hook(dir, "PreToolUse", "Agent", { subagent_type: "builder", prompt: "x" }, first).decision).toBe("allow");
    // The run was interrupted: no after-call hook ever ran for that launch.
    expect(hook(dir, "PreToolUse", "Agent", { subagent_type: "builder", prompt: "x" }, first).decision).toBe("deny");
    // A different id alone is not evidence: the first architect may still run.
    expect(hook(dir, "PreToolUse", "Agent", { subagent_type: "builder", prompt: "x" }, next).decision).toBe("deny");
    // The lead's own after-call hook records that the first architect ended.
    leadSawArchitectEnd(dir, "a0000000000000aaa");
    expect(hook(dir, "PreToolUse", "Agent", { subagent_type: "builder", prompt: "x" }, next).decision).toBe("allow");
    // And the successor's own launch is again unresolved to itself.
    expect(hook(dir, "PreToolUse", "Agent", { subagent_type: "builder", prompt: "x" }, next).decision).toBe("deny");
  });

  test("an end recorded for a DIFFERENT architect licenses nothing", () => {
    const dir = readyProject();
    const first = { agent_id: "a0000000000000aaa", agent_type: "architect" };
    hook(dir, "PreToolUse", "Agent", { subagent_type: "builder", prompt: "x" }, first);
    leadSawArchitectEnd(dir, "a0000000000000ccc");
    expect(hook(dir, "PreToolUse", "Agent", { subagent_type: "builder", prompt: "x" }, { agent_id: "a0000000000000bbb", agent_type: "architect" }).decision).toBe("deny");
  });

  // Regression (the re-review's race): two architects at once — the first
  // starting a builder and a nested architect in one message — must never get
  // two builders. The nested architect is refused, and even a second architect
  // that somehow runs gets no licence from its different id alone.
  test("two architects at once never get two builders", () => {
    const dir = readyProject();
    const a1 = { agent_id: "a1111111111", agent_type: "architect" };
    const a2 = { agent_id: "a2222222222", agent_type: "architect" };
    expect(hook(dir, "PreToolUse", "Agent", { subagent_type: "builder", prompt: "x" }, a1).decision).toBe("allow");
    const nested = hook(dir, "PreToolUse", "Agent", { subagent_type: "architect", prompt: "x" }, a1);
    expect(nested.decision).toBe("deny");
    expect(nested.reason).toContain("may not commission another architect");
    expect(hook(dir, "PreToolUse", "Agent", { subagent_type: "builder", prompt: "x" }, a2).decision).toBe("deny");
    expect(hook(dir, "PreToolUse", "Agent", { subagent_type: "builder", prompt: "x" }, a1).decision).toBe("deny");
    const builders = phase(dir).filter((e) => (e.detail as { kind?: string; target?: string }).kind === "spawn" &&
      (e.detail as { target?: string }).target === "builder");
    expect(builders).toHaveLength(1);
  });

  test.each(["run_in_background", "isolation", "name", "cwd", "team_name", "mode"])(
    "an architect's Agent call carrying '%s' is refused",
    (field) => {
      const dir = readyProject();
      const r = hook(dir, "PreToolUse", "Agent", { subagent_type: "builder", prompt: "x", [field]: field === "run_in_background" ? true : "v" });
      expect(r.decision).toBe("deny");
      expect(r.reason).toContain(`'${field}' is not allowed`);
    },
  );

  test("a launch that failed, or named no worker, licenses a fresh launch of that role", () => {
    const dir = readyProject();
    launch(dir, "test-writer");
    hook(dir, "PostToolUseFailure", "Agent", { subagent_type: "test-writer", prompt: "do it" }, { error: "aborted" });
    expect(launch(dir, "test-writer").decision).toBe("allow");
    launch(dir, "builder");
    hook(dir, "PostToolUse", "Agent", { subagent_type: "builder", prompt: "do it" }, { tool_response: { status: "error" } });
    expect(launch(dir, "builder").decision).toBe("allow");
  });

  test("only a role's current worker may be continued, and only its failure licenses a relaunch", () => {
    const dir = readyProject();
    const W2 = "a0000000000000222";
    launch(dir, "test-writer");
    finished(dir, "test-writer", W1);
    hook(dir, "PostToolUseFailure", "SendMessage", { to: W1, message: "bounce" }, { error: "gone" });
    expect(launch(dir, "test-writer").decision).toBe("allow");
    finished(dir, "test-writer", W2);
    // W1 was replaced by W2: continuing it is refused, and its failure licenses nothing.
    expect(send(dir, { to: W1, message: "bounce" }).decision).toBe("deny");
    hook(dir, "PostToolUseFailure", "SendMessage", { to: W1, message: "bounce" }, { error: "gone" });
    expect(launch(dir, "test-writer").decision).toBe("deny");
    expect(send(dir, { to: W2, message: "bounce" }).decision).toBe("allow");
  });

  test("a name, even one shaped like a recorded worker's, is never addressed", () => {
    expect(sendTarget({ to: "test-writer", message: "x" }).ok).toBe(false);
    expect(sendTarget({ to: "worker", message: "x" }).ok).toBe(false);
  });

  test("an Agent call cannot pose as a continuation", () => {
    const dir = readyProject();
    launch(dir, "test-writer");
    finished(dir, "test-writer", W1);
    const r = hook(dir, "PreToolUse", "Agent", { subagent_type: "test-writer", prompt: "x", continueWorker: W1 });
    expect(r.decision).toBe("deny");
  });

  test("nothing after a call is ever refused", () => {
    const dir = readyProject();
    expect(hook(dir, "PostToolUse", "Bash", { command: "cat x" }).decision).toBe("allow");
    expect(hook(dir, "PostToolUseFailure", "SendMessage", { to: "main", message: "x" }).decision).toBe("allow");
  });
});

describe("continuation.ts — the pure half", () => {
  const ev = (detail: Readonly<Record<string, unknown>>): LoggedGuardEvent =>
    ({ ts: "t", guard: "phase-gate", verdict: "pass", summary: "", detail }) as LoggedGuardEvent;

  test("sendTarget reads only a plain message to an agent id", () => {
    expect(sendTarget({ to: W1, message: "x" })).toEqual({ ok: true, to: W1 });
    expect(sendTarget({ to: "has space", message: "x" }).ok).toBe(false);
    expect(sendTarget({ to: W1, message: "x", type: "broadcast" }).ok).toBe(false);
    expect(sendTarget({ to: W1 }).ok).toBe(false);
  });

  test("launchOutcome trusts only a pipeline role started as asked, and licenses only a terminal failure", () => {
    const A = "a00000000000000a1";
    const asked = { subagent_type: "builder" };
    expect(launchOutcome(asked, { agentId: A, agentType: "builder", status: "completed" })).toEqual({ kind: "worker", role: "builder", worker: A });
    // A background launch reports an id but no type yet: a running worker, never a licence.
    expect(launchOutcome(asked, { agentId: A, status: "async_launched" })).toEqual({ kind: "worker", role: "builder", worker: A });
    expect(launchOutcome(asked, { agentId: A, status: "failed" })).toEqual({ kind: "ended", role: "builder" });
    expect(launchOutcome(asked, { status: "killed" })).toEqual({ kind: "ended", role: "builder" });
    // Anything that proves nothing either way records nothing.
    expect(launchOutcome(asked, { agentId: A })).toBeUndefined();
    expect(launchOutcome(asked, { agentId: A, status: "completed" })).toBeUndefined();
    expect(launchOutcome(asked, { agentId: A, agentType: "reviewer" })).toBeUndefined();
    expect(launchOutcome(asked, { status: "something new" })).toBeUndefined();
    expect(launchOutcome({ subagent_type: "scout" }, { agentId: A, agentType: "scout" })).toBeUndefined();
    expect(launchOutcome(asked, { agentId: "a 00000001", agentType: "builder" })).toBeUndefined();
    expect(launchOutcome(asked, A)).toBeUndefined();
  });

  test("unresolvedLaunchCaller: the caller of a launch with no outcome, if it recorded one", () => {
    const spawn = (caller?: string) => ev({ kind: "spawn", target: "builder", ...(caller ? { caller } : {}) });
    expect(unresolvedLaunchCaller("builder", [spawn("agent:x")])).toBe("agent:x");
    expect(unresolvedLaunchCaller("builder", [spawn()])).toBeUndefined();
    expect(unresolvedLaunchCaller("builder", [spawn("agent:x"), ev({ kind: "worker-started", target: "builder", worker: "a1" })])).toBeUndefined();
    expect(unresolvedLaunchCaller("builder", [spawn("agent:x"), ev({ kind: "continuation-checked", target: "builder" })])).toBeUndefined();
  });

  test("the continuable worker is the one after the role's last launch, until a continuation fails", () => {
    const spawn = ev({ kind: "spawn", target: "builder" });
    const started = (worker: string) => ev({ kind: "worker-started", target: "builder", worker });
    expect(continuableWorker("builder", [spawn, started("a00000000000000a1")])).toBe("a00000000000000a1");
    expect(continuableWorker("builder", [spawn, started("a00000000000000a1"), spawn, started("a00000000000000a2")])).toBe("a00000000000000a2");
    expect(continuableWorker("builder", [spawn, started("a00000000000000a1"), spawn])).toBeUndefined();
    expect(continuableWorker("builder", [spawn, started("a00000000000000a1"), ev({ kind: "continuation-checked", target: "builder" })])).toBeUndefined();
    expect(workerRole("a00000000000000a1", [spawn, started("a00000000000000a1")])).toBe("builder");
  });

  test("the instruction names only this host's mechanism", () => {
    const text = CLAUDE_COMMISSIONS.continueHow("builder", []);
    expect(text).toContain("SendMessage");
    expect(text).not.toMatch(/children\.list|action: "resume"/);
  });
});
