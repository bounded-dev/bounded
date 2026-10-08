import { spawnSync } from "node:child_process";
import { symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import { readGuardLog, RUN_START_GUARD } from "../../src/guard-log.ts";
import { HOST_ENV } from "../../src/host.ts";
import { errorOpenRead, runHook } from "./path-gate-hook.ts";
import { makeTempProject as makeProject, type TempProject } from "../../test/support/temp-project.ts";


const C = "contexts/m/src";

// ADR LEG-2026-034: the adapter is verified by fixture until the first live run.
// Each case spawns the hook exactly as Claude Code would — a fresh process,
// the call as JSON on stdin — in a temp project, and asserts the decision it
// prints and the guard-log lines it leaves.

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "path-gate-hook.ts");

const projects: TempProject[] = [];
function makeTempProject(
  files: Readonly<Record<string, string>>,
  // The hexagonal layout pack contributes the source roots (ADR LEG-2026-056).
  packs: readonly string[] = ["ts", "ts-hexagonal"],
): string {
  const project = makeProject(files, { prefix: "cc-hook-", packs });
  projects.push(project);
  return project.dir;
}
afterEach(() => {
  while (projects.length) projects.pop()?.cleanup();
});

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly decision: "allow" | "deny";
  readonly reason: string;
  /** The rewritten tool input an explicit allow carried, if any. */
  readonly updatedInput?: Readonly<Record<string, unknown>>;
}

interface HookOutput {
  readonly hookSpecificOutput: {
    readonly hookEventName: string;
    readonly permissionDecision: string;
    readonly permissionDecisionReason?: string;
    readonly updatedInput?: Readonly<Record<string, unknown>>;
  };
}

function run(dir: string, stdin: string, flags: readonly string[] = [], extraEnv: Readonly<Record<string, string>> = {}): Run {
  const env = { ...process.env };
  delete env["BOUNDED_GUARD_LOG"];
  delete env["BOUNDED_DEV_STAGE_ROLE"];
  // Claude Code's own Bash timeout settings, when this suite runs inside it.
  delete env["BASH_DEFAULT_TIMEOUT_MS"];
  delete env["BASH_MAX_TIMEOUT_MS"];
  Object.assign(env, extraEnv);
  const r = spawnSync(process.execPath, [HOOK, ...flags], { cwd: dir, input: stdin, encoding: "utf8", env });
  let decision: Run["decision"] = "allow";
  let reason = "";
  let updatedInput: Run["updatedInput"];
  if (r.stdout.trim() !== "") {
    // The test's own reading of the wire format; a shape mismatch fails here.
    const out = (JSON.parse(r.stdout) as HookOutput).hookSpecificOutput;
    expect(out.hookEventName).toBe("PreToolUse");
    if (out.permissionDecision === "deny") {
      decision = "deny";
      reason = out.permissionDecisionReason ?? "";
    } else {
      expect(out.permissionDecision).toBe("allow");
      expect(out.updatedInput).toBeDefined();
      updatedInput = out.updatedInput;
    }
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, decision, reason, ...(updatedInput !== undefined ? { updatedInput } : {}) };
}

/** The hook's own entry, in this process, read back exactly as `run` reads a
 *  spawned hook's output. */
function runHere(dir: string, stdin: string, flags: readonly string[] = []): Run {
  vi.stubEnv("BOUNDED_GUARD_LOG", undefined);
  vi.stubEnv("BOUNDED_DEV_STAGE_ROLE", undefined);
  try {
    const out = runHook(flags, stdin, dir);
    let decision: Run["decision"] = "allow";
    let reason = "";
    if (out.stdout.trim() !== "") {
      const parsed = (JSON.parse(out.stdout) as HookOutput).hookSpecificOutput;
      if (parsed.permissionDecision === "deny") {
        decision = "deny";
        reason = parsed.permissionDecisionReason ?? "";
      }
    }
    return { status: 0, stdout: out.stdout, stderr: out.stderr, decision, reason };
  } finally {
    vi.unstubAllEnvs();
  }
}

function payload(dir: string, tool_name: string, tool_input: unknown, extra: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    session_id: "s1",
    cwd: dir,
    hook_event_name: "PreToolUse",
    tool_name,
    tool_input,
    permission_mode: "default",
    ...extra,
  });
}

/** The prefix an allowed `bounded gates` call is given (F3): the host, the
 *  role, then the call's deadline (Claude Code's 2-minute default when the
 *  call names no timeout, issue #48). */
const prefix = (role: string, timeoutMs = 120_000): string =>
  `${HOST_ENV}=claude-code BOUNDED_DEV_STAGE_ROLE=${role} BOUNDED_COMMAND_TIMEOUT_MS=${timeoutMs}`;

/** The log minus the host declaration the hook writes as the role binds
 *  (ADR LEG-2026-034) — these tests are about the gate's own lines. */
function gateEvents(dir: string) {
  return readGuardLog(dir).filter((e) => e.guard !== "host");
}

describe("path-gate-hook — the path gate, by role file", () => {
  test("test-writer reading an implementation file → deny JSON and a path-gate block in the log", () => {
    const dir = makeTempProject({ ".bounded/dev-stage-role": "test-writer\n", [`${C}/x.ts`]: "" });
    const r = runHere(dir, payload(dir, "Read", { file_path: join(dir, `${C}/x.ts`) }));
    expect(r.decision).toBe("deny");
    expect(r.reason).toBe(`path-gate: test-writer may not read '${C}/x.ts': it is an implementation file — the test-writer may list implementation names but reads only contracts, generated files and tests`);
    expect(r.stderr).toBe("");
    const log = gateEvents(dir);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ guard: "path-gate", verdict: "block", detail: { role: "test-writer", tool: "read" } });
  });

  test("test-writer reading a contract → allow, no output, no log", () => {
    const dir = makeTempProject({ ".bounded/dev-stage-role": "test-writer\n" });
    const r = runHere(dir, payload(dir, "Read", { file_path: join(dir, `${C}/x.contract.ts`) }));
    expect(r.decision).toBe("allow");
    expect(r.stdout).toBe("");
    expect(gateEvents(dir)).toEqual([]);
  });

  test("builder reading a colocated test → deny", () => {
    const dir = makeTempProject({ ".bounded/dev-stage-role": "builder\n", [`${C}/a.test.ts`]: "" });
    const r = runHere(dir, payload(dir, "Read", { file_path: join(dir, `${C}/a.test.ts`) }));
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("it is a test file (name ends with '.test.ts')");
  });

  test("builder may Glob test names, and may not Grep their content", () => {
    const dir = makeTempProject({ ".bounded/dev-stage-role": "builder\n", [`${C}/a.test.ts`]: "", [`${C}/a.ts`]: "" });
    expect(runHere(dir, payload(dir, "Glob", { pattern: "**/*.test.ts", path: join(dir, C) })).decision).toBe("allow");
    const grep = runHere(dir, payload(dir, "Grep", { pattern: "TODO", path: join(dir, C) }));
    expect(grep.decision).toBe("deny");
    expect(grep.reason).toContain("can reach test files");
    // The glob reaches the gate: a provable one is allowed, '*.ts' is not.
    expect(runHere(dir, payload(dir, "Grep", { pattern: "TODO", path: join(dir, C), glob: "*.handler.ts" })).decision).toBe("allow");
    expect(runHere(dir, payload(dir, "Grep", { pattern: "TODO", path: join(dir, C), glob: "*.ts" })).decision).toBe("deny");
    expect(runHere(dir, payload(dir, "Grep", { pattern: "TODO", path: join(dir, `${C}/a.test.ts`), glob: "*.handler.ts" })).decision).toBe("deny");
  });

  test("a Glob pattern that climbs out of the searched directory is refused", () => {
    const dir = makeTempProject({ ".bounded/dev-stage-role": "builder\n" });
    expect(runHere(dir, payload(dir, "Glob", { pattern: "../**/*.ts", path: join(dir, C) })).decision).toBe("deny");
  });

  test("builder Grep without a path searches the project root → deny", () => {
    const dir = makeTempProject({ ".bounded/dev-stage-role": "builder\n" });
    const r = run(dir, payload(dir, "Grep", { pattern: "TODO" }));
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("may not search '.'");
  });

  test("MultiEdit is denied if any path is denied", () => {
    const dir = makeTempProject({ ".bounded/dev-stage-role": "builder\n" });
    const r = runHere(
      dir,
      payload(dir, "MultiEdit", { file_path: join(dir, `${C}/a.ts`), edits: [{ file_path: join(dir, `${C}/a.contract.ts`) }] }),
    );
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain(`may not write '${C}/a.contract.ts'`);
  });

  test("with no source root composed, no role writes source (spawned, real composition)", () => {
    const dir = makeTempProject({ ".bounded/dev-stage-role": "builder\n" }, ["ts"]);
    const r = run(dir, payload(dir, "Write", { file_path: join(dir, `${C}/a.ts`), content: "x" }));
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("no composed pack declares a source root");
  });
});

describe("path-gate-hook — Bash, by role", () => {
  test.each(["architect", "test-writer", "builder", "reviewer"])("%s: `npm test` → deny with the reason, and a logged block", (role) => {
    const dir = makeTempProject({ ".bounded/dev-stage-role": `${role}\n` });
    const r = run(dir, payload(dir, "Bash", { command: "npm test" }));
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain(`path-gate: ${role} may not run 'npm': no role holds a shell`);
    const block = gateEvents(dir).find((e) => e.guard === "path-gate" && e.verdict === "block");
    expect(block).toMatchObject({ summary: r.reason, detail: { role, tool: "bash", command: "npm test" } });
  });

  test.each(["architect", "builder"])("%s: `ls` / `find` list real paths, never through a link (#35)", (role) => {
    const dir = makeTempProject({ "contexts/m/src/a.ts": "" });
    symlinkSync(join(dir, ".git"), join(dir, "contexts/m/g"));
    expect(runHere(dir, payload(dir, "Bash", { command: "ls contexts/m/src" }), ["--role", role]).decision).toBe("allow");
    expect(runHere(dir, payload(dir, "Bash", { command: "ls" }), ["--role", role]).decision).toBe("allow");
    for (const command of ["ls contexts/m/g", "find contexts/m/g -name '*'", "ls contexts/m/g/"]) {
      const r = runHere(dir, payload(dir, "Bash", { command }), ["--role", role]);
      expect(r.decision, command).toBe("deny");
    }
  });

  test("grep through Bash on a real tree: each blind role stays off the other side (#35)", () => {
    const dir = makeTempProject({
      "contexts/m/src/a.ts": "export const needle = 1;\n",
      "contexts/m/src/a.test.ts": "needle\n",
      "contexts/m/src/b.handler.ts": "needle\n",
    });
    const as = (role: string, command: string) => runHere(dir, payload(dir, "Bash", { command }), ["--role", role]).decision;
    expect(as("builder", "grep -rn --include='*.handler.ts' -e 'needle' contexts/m/src")).toBe("allow");
    expect(as("builder", "grep -rn -e 'needle' contexts/m/src")).toBe("deny");
    expect(as("builder", "grep -n 'needle' contexts/m/src/a.test.ts")).toBe("deny");
    expect(as("builder", "grep -n 'needle' contexts/m/src/a.ts")).toBe("allow");
    expect(as("test-writer", "grep -n 'needle' contexts/m/src/a.ts")).toBe("deny");
    expect(as("test-writer", "grep -rn --include='*.test.ts' -e 'needle' contexts/m/src")).toBe("allow");
    symlinkSync(join(dir, "contexts/m/src/a.test.ts"), join(dir, "contexts/m/src/c.handler.ts"));
    // A link in the tree, or as the path, now refuses the directory search.
    expect(as("builder", "grep -rn --include='*.handler.ts' -e 'needle' contexts/m/src")).toBe("deny");
    expect(as("builder", "grep -n 'needle' contexts/m/src/c.handler.ts")).toBe("deny");
  });

  test("`bounded gates red-gate`: architect allow, builder deny", () => {
    const a = makeTempProject({ ".bounded/dev-stage-role": "architect\n" });
    const ok = run(a, payload(a, "Bash", { command: "bounded gates red-gate" }));
    expect(ok.decision).toBe("allow");
    expect(ok.updatedInput?.["command"]).toBe(`${prefix("architect")} bounded gates red-gate`);
    const b = makeTempProject({ ".bounded/dev-stage-role": "builder\n" });
    const r = run(b, payload(b, "Bash", { command: "bounded gates red-gate" }));
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("'red_gate' is the architect's");
  });

  test("`bounded gates typecheck`: builder allow, with the host and the bound role handed to the CLI through the env", () => {
    const dir = makeTempProject({ ".bounded/dev-stage-role": "builder\n" });
    const r = run(dir, payload(dir, "Bash", { command: "bounded gates typecheck", description: "typecheck", timeout: 60000 }));
    expect(r.status).toBe(0);
    expect(r.decision).toBe("allow");
    expect(r.updatedInput).toEqual({ command: "BOUNDED_HOST=claude-code BOUNDED_DEV_STAGE_ROLE=builder BOUNDED_COMMAND_TIMEOUT_MS=60000 bounded gates typecheck", description: "typecheck", timeout: 60000 });
    expect(gateEvents(dir)).toEqual([]);
  });

  // Issue #48: Claude Code killed a mutation-score call at its 10-minute
  // limit. The gate can only stay inside a deadline it is told.
  test("an allowed gate call carries the call's deadline to the gate", () => {
    const dir = makeTempProject({ ".bounded/dev-stage-role": "builder\n" });
    const long = run(dir, payload(dir, "Bash", { command: "bounded gates run-tests", timeout: 600000 }));
    expect(long.decision).toBe("allow");
    const command = String(long.updatedInput?.["command"]);
    expect(command).toMatch(/BOUNDED_COMMAND_TIMEOUT_MS=600000 .*bounded gates run-tests$/);
    expect(command.indexOf("BOUNDED_COMMAND_TIMEOUT_MS=600000")).toBeLessThan(command.indexOf("bounded gates"));
    expect(long.updatedInput?.["timeout"]).toBe(600000);
    const plain = run(dir, payload(dir, "Bash", { command: "bounded gates run-tests" }));
    expect(String(plain.updatedInput?.["command"])).toContain("BOUNDED_COMMAND_TIMEOUT_MS=120000 ");
    expect(plain.updatedInput?.["timeout"]).toBeUndefined();
  });

  test("the env prefix carries the BOUND role, not the file's", () => {
    const dir = makeTempProject({ ".bounded/dev-stage-role": "builder\n" });
    const r = run(dir, payload(dir, "Bash", { command: "bounded gates typecheck" }), ["--role", "reviewer"]);
    expect(r.updatedInput?.["command"]).toBe(`${prefix("reviewer")} bounded gates typecheck`);
  });

  test("a model-typed BOUNDED_HOST or BOUNDED_DEV_STAGE_ROLE prefix is refused; only the hook adds them", () => {
    const dir = makeTempProject({ ".bounded/dev-stage-role": "builder\n" });
    for (const command of ["BOUNDED_HOST=claude-code bounded gates typecheck", "BOUNDED_DEV_STAGE_ROLE=builder bounded gates typecheck", `${prefix("builder")} bounded gates typecheck`]) {
      const r = run(dir, payload(dir, "Bash", { command }));
      expect(r.decision).toBe("deny");
      expect(r.reason).toContain("an env assignment prefix");
    }
  });

  // The deadline is the host's to state: a model that typed a long one could
  // have the measurement outlive the call and be killed mid-mutant.
  // Claude Code reads its Bash default and maximum from BASH_DEFAULT_TIMEOUT_MS
  // and BASH_MAX_TIMEOUT_MS; the deadline handed to the gate must be the one
  // Claude Code will actually enforce.
  test("the deadline follows Claude Code's own BASH_DEFAULT_TIMEOUT_MS and BASH_MAX_TIMEOUT_MS when they are set", () => {
    const dir = makeTempProject({ ".bounded/dev-stage-role": "builder\n" });
    const deadline = (input: Record<string, unknown>, env: Record<string, string> = {}): string => {
      const r = run(dir, payload(dir, "Bash", { command: "bounded gates run-tests", ...input }), [], env);
      expect(r.decision).toBe("allow");
      return /BOUNDED_COMMAND_TIMEOUT_MS=(\d+) /.exec(String(r.updatedInput?.["command"]))?.[1] ?? "none";
    };
    expect(deadline({}, { BASH_DEFAULT_TIMEOUT_MS: "300000" })).toBe("300000");
    expect(deadline({ timeout: 800000 })).toBe("600000");
    expect(deadline({ timeout: 800000 }, { BASH_MAX_TIMEOUT_MS: "900000" })).toBe("800000");
    expect(deadline({}, { BASH_DEFAULT_TIMEOUT_MS: "900000", BASH_MAX_TIMEOUT_MS: "700000" })).toBe("700000");
    expect(deadline({}, { BASH_DEFAULT_TIMEOUT_MS: "abc" })).toBe("120000");
  });

  test("a model-typed BOUNDED_COMMAND_TIMEOUT_MS prefix is refused", () => {
    const dir = makeTempProject({ ".bounded/dev-stage-role": "builder\n" });
    const r = run(dir, payload(dir, "Bash", { command: "BOUNDED_COMMAND_TIMEOUT_MS=1 bounded gates typecheck" }));
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("an env assignment prefix");
  });

  test("a model-supplied --role is refused; the host supplies the role", () => {
    const dir = makeTempProject({ ".bounded/dev-stage-role": "builder\n" });
    const r = run(dir, payload(dir, "Bash", { command: "bounded gates typecheck --role architect" }));
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("may not pass '--role' to bounded gates");
  });

  test("git, sleep and rm allows stay silent: no updatedInput", () => {
    const a = makeTempProject({ ".bounded/dev-stage-role": "architect\n" });
    for (const command of ["git status", "sleep 1"]) {
      const r = run(a, payload(a, "Bash", { command }));
      expect(r.decision).toBe("allow");
      expect(r.stdout).toBe("");
    }
  });

  // rm is judged by decide() with the same context the file tools get
  // (pathGateCtx): the layout places the file, so each blind role may remove
  // its own side's files and no other.
  test("rm follows the layout: own side allowed and silent, other side and generated refused", () => {
    const files = { [`${C}/a.test.ts`]: "", [`${C}/a.ts`]: "", [`${C}/x.laws.test.ts`]: "" };
    const t = makeTempProject({ ".bounded/dev-stage-role": "test-writer\n", ...files });
    const own = runHere(t, payload(t, "Bash", { command: `rm ${C}/a.test.ts` }));
    expect(own.decision).toBe("allow");
    expect(own.stdout).toBe("");
    expect(runHere(t, payload(t, "Bash", { command: `rm ${C}/a.ts` })).reason).toContain("it is an implementation file");
    expect(runHere(t, payload(t, "Bash", { command: `rm ${C}/x.laws.test.ts` })).reason).toContain("it is a generated file");
    const b = makeTempProject({ ".bounded/dev-stage-role": "builder\n", ...files });
    expect(runHere(b, payload(b, "Bash", { command: `rm ${join(b, C, "a.ts")}` })).decision).toBe("allow");
    expect(runHere(b, payload(b, "Bash", { command: `rm ${C}/a.test.ts` })).reason).toContain("it is a test file");
  });

  test("a Bash call with no command string is refused, not crashed on", () => {
    const dir = makeTempProject({ ".bounded/dev-stage-role": "builder\n" });
    const r = run(dir, payload(dir, "Bash", {}));
    expect(r.decision).toBe("deny");
    expect(r.stderr).toBe("");
  });
});

describe("path-gate-hook — the phase gate on Agent", () => {
  test("architect spawning the builder with no contracts → deny, logged as a phase-gate block", () => {
    const dir = makeTempProject({});
    const r = run(dir, payload(dir, "Agent", { subagent_type: "builder", prompt: "implement it" }), ["--role", "architect"]);
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("phase-gate: cannot commission the builder — no *.contract.ts exists yet");
    const block = gateEvents(dir).find((e) => e.guard === "phase-gate");
    expect(block).toMatchObject({ verdict: "block", detail: { kind: "spawn-refused", role: "architect", target: "builder" } });
  });

  test("contract evidence is searched under the source roots only: with none composed, nothing is a contract", () => {
    const dir = makeTempProject({
      "node_modules/pkg/x.contract.ts": "export {};\n",
      "lib/y.contract.ts": "export {};\n",
      "src/.hidden/z.contract.ts": "export {};\n",
    });
    const r = run(dir, payload(dir, "Agent", { subagent_type: "builder", prompt: "implement it" }), ["--role", "architect"]);
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("no *.contract.ts exists yet");
  });

  test("a worker holding no `subagent` is refused by the tool policy, not the phase", () => {
    const dir = makeTempProject({ ".bounded/dev-stage-role": "builder\n" });
    const r = run(dir, payload(dir, "Agent", { subagent_type: "reviewer", prompt: "look" }));
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("builder may not use 'subagent'");
  });

  // F1: on this host only the generated definitions carry a strip and a
  // bound hook; any other subagent_type is a full-toolset proxy.
  describe("an unbound subagent_type is refused before the phase gate", () => {
    test.each([
      ["general-purpose", { subagent_type: "general-purpose", prompt: "do it" }],
      ["Explore", { subagent_type: "Explore", prompt: "look around" }],
      ["delegate", { subagent_type: "delegate", prompt: "implement it" }],
      ["(missing subagent_type)", { prompt: "do it" }],
    ])("architect Agent %s → deny, logged as a phase-gate spawn-refused block", (_label, input) => {
      const dir = makeTempProject({});
      const r = run(dir, payload(dir, "Agent", input), ["--role", "architect"]);
      expect(r.decision).toBe("deny");
      expect(r.reason).toContain("holds no role binding");
      expect(r.reason).toContain("only the generated definitions (architect, test-writer, builder, reviewer)");
      const block = gateEvents(dir).find((e) => e.guard === "phase-gate");
      const target = "subagent_type" in input ? { target: input.subagent_type } : {};
      expect(block).toMatchObject({ verdict: "block", summary: r.reason, detail: { kind: "spawn-refused", role: "architect", ...target } });
    });

    test("Task, the older name, is judged the same", () => {
      const dir = makeTempProject({});
      const r = run(dir, payload(dir, "Task", { subagent_type: "general-purpose", prompt: "do it" }), ["--role", "architect"]);
      expect(r.decision).toBe("deny");
      expect(r.reason).toContain("'general-purpose' holds no role binding");
    });

    test("the reviewer (no preconditions) → allow", () => {
      const dir = makeTempProject({});
      const r = run(dir, payload(dir, "Agent", { subagent_type: "reviewer", prompt: "review the spec" }), ["--role", "architect"]);
      expect(r.decision).toBe("allow");
      expect(gateEvents(dir).filter((e) => e.verdict === "block")).toEqual([]);
    });
  });
});

describe("path-gate-hook — role source", () => {
  test("--role beats the role file", () => {
    const dir = makeTempProject({ ".bounded/dev-stage-role": "builder\n" });
    // As builder this read is denied; as the bound test-writer it is its own zone.
    expect(runHere(dir, payload(dir, "Read", { file_path: join(dir, `${C}/a.test.ts`) }), ["--role", "test-writer"]).decision).toBe("allow");
    expect(runHere(dir, payload(dir, "Read", { file_path: join(dir, `${C}/x.ts`) }), ["--role", "test-writer"]).decision).toBe("deny");
    expect(runHere(dir, payload(dir, "Read", { file_path: join(dir, `${C}/a.test.ts`) })).decision).toBe("deny");
  });

  test("no role anywhere → inactive: allow, no log", () => {
    const dir = makeTempProject({});
    const r = run(dir, payload(dir, "Read", { file_path: join(dir, "tests/a.test.ts") }));
    expect(r.decision).toBe("allow");
    expect(r.stdout).toBe("");
    expect(gateEvents(dir)).toEqual([]);
  });

  test("a --role that is not a pipeline role fails open, loudly", () => {
    const dir = makeTempProject({});
    const r = run(dir, payload(dir, "Read", { file_path: join(dir, "src/x.ts") }), ["--role", "wizard"]);
    expect(r.status).toBe(0);
    expect(r.decision).toBe("allow");
    expect(r.stderr).toContain("--role 'wizard' is not a pipeline role");
    expect(gateEvents(dir)[0]).toMatchObject({ guard: "path-gate", verdict: "error" });
  });

  test("a tool the gate has no opinion on passes through", () => {
    const dir = makeTempProject({ ".bounded/dev-stage-role": "builder\n" });
    expect(run(dir, payload(dir, "WebFetch", { url: "https://example.com" })).decision).toBe("allow");
  });

  test("a non-PreToolUse event is ignored", () => {
    const dir = makeTempProject({ ".bounded/dev-stage-role": "builder\n" });
    const evt = JSON.stringify({ cwd: dir, hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: join(dir, "tests/a.test.ts") } });
    expect(run(dir, evt).decision).toBe("allow");
  });
});

// F6: a mitigation for the ambient-hook + bound-subagent stack, unverified
// live — it assumes a subagent's PreToolUse payload carries `agent_type` or
// `agent_id` the way SubagentStart's does.
describe("path-gate-hook — the ambient hook stands down for a bound subagent's call", () => {
  const npmTest = { command: "npm test" }; // refused for every role, so an allow is the stand-down

  test("ambient (role file architect) + agent_type in the payload → allow, and nothing logged", () => {
    const dir = makeTempProject({ ".bounded/dev-stage-role": "architect\n" });
    const r = run(dir, payload(dir, "Bash", npmTest, { agent_type: "builder" }));
    expect(r.decision).toBe("allow");
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    expect(readGuardLog(dir)).toEqual([]);
  });

  test("agent_id alone is enough", () => {
    const dir = makeTempProject({ ".bounded/dev-stage-role": "architect\n" });
    expect(run(dir, payload(dir, "Bash", npmTest, { agent_id: "a-1" })).decision).toBe("allow");
    expect(readGuardLog(dir)).toEqual([]);
  });

  test("without the field the ambient hook judges as before", () => {
    const dir = makeTempProject({ ".bounded/dev-stage-role": "architect\n" });
    const r = run(dir, payload(dir, "Bash", npmTest));
    expect(r.decision).toBe("deny");
    expect(gateEvents(dir).some((e) => e.verdict === "block")).toBe(true);
  });

  test("a BOUND hook never stands down", () => {
    const dir = makeTempProject({});
    const r = run(dir, payload(dir, "Bash", npmTest, { agent_type: "builder" }), ["--role", "builder"]);
    expect(r.decision).toBe("deny");
  });
});

describe("path-gate-hook — failure mode: open only for local reads, closed for everything else", () => {
  test("malformed stdin → deny, exit 0, one stderr line, an error event in the cwd's log", () => {
    const dir = makeTempProject({ ".bounded/dev-stage-role": "builder\n" });
    const r = run(dir, "this is not json");
    expect(r.status).toBe(0);
    expect(r.decision).toBe("deny");
    expect(r.stderr.split("\n").filter((l) => l !== "")).toHaveLength(1);
    expect(r.stderr).toContain("path-gate-hook: error, refusing the unreadable call");
    const log = gateEvents(dir);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ guard: "path-gate", verdict: "error", detail: { host: "claude-code", kind: "hook-error" } });
  });

  test("empty stdin and a payload without tool_name are the same failure", () => {
    const dir = makeTempProject({});
    expect(run(dir, "").decision).toBe("deny");
    const r = run(dir, JSON.stringify({ cwd: dir }));
    expect(r.decision).toBe("deny");
    expect(r.stderr).toContain("no tool_name");
  });

  // An errored hook must not wave through tools it never judged: MCP tools,
  // skills and web tools reach outside the project as surely as a write does.
  test.each(["mcp__server__tool", "Skill", "WebFetch", "WebSearch", "TodoWrite", "SomeFutureTool"])(
    "%s with an input the hook cannot narrow → DENY", (tool) => {
      const dir = makeTempProject({ ".bounded/dev-stage-role": "builder\n" });
      const r = run(dir, payload(dir, tool, "not an object"));
      expect(r.decision).toBe("deny");
      expect(r.reason).toContain(`${tool} call is refused`);
    });

  // F5: a present, non-object tool_input is malformed — narrowing throws
  // after the tool name is known, so the failure mode is chosen by tool.
  test.each(["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "Agent", "Task"])(
    "%s with an input the hook cannot narrow → DENY whose reason says the hook errored, plus the error event",
    (tool) => {
      const dir = makeTempProject({ ".bounded/dev-stage-role": "builder\n" });
      const r = run(dir, payload(dir, tool, "not an object"));
      expect(r.status).toBe(0);
      expect(r.decision).toBe("deny");
      expect(r.reason).toContain("the hook errored (payload tool_input is not an object)");
      expect(r.reason).toContain(`${tool} call is refused`);
      expect(r.stderr).toContain(`refusing the ${tool} call`);
      const log = gateEvents(dir);
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ guard: "path-gate", verdict: "error", detail: { host: "claude-code", kind: "hook-error", tool } });
      expect(log[0]?.summary).toContain("call refused");
    },
  );

  // A read whose target cannot be checked is refused like any other call.
  test.each(["Read", "Grep", "Glob", "LS"])("%s with the same bad input is refused: its target cannot be checked", (tool) => {
    const dir = makeTempProject({ ".bounded/dev-stage-role": "builder\n" });
    const r = run(dir, payload(dir, tool, "not an object"));
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain(`${tool} call is refused`);
    expect(gateEvents(dir)[0]).toMatchObject({ verdict: "error", detail: { kind: "hook-error", tool } });
  });
});

describe("path-gate-hook — what an errored hook still lets through", () => {
  const saved = process.env["CLAUDE_PROJECT_DIR"];
  afterEach(() => {
    if (saved === undefined) delete process.env["CLAUDE_PROJECT_DIR"];
    else process.env["CLAUDE_PROJECT_DIR"] = saved;
  });
  const call = (dir: string, tool: string, input: object) => ({ tool_name: tool, cwd: dir, tool_input: input });

  test.each([
    ["Read", { file_path: "src/a.ts" }],
    ["Grep", { pattern: "x", path: "src" }],
    ["Glob", { pattern: "**/*.ts", path: "src" }],
    ["LS", { path: "src" }],
  ])("a contained %s %j is allowed", (tool, input) => {
    const dir = makeTempProject({ "src/a.ts": "", ".git/config": "" });
    process.env["CLAUDE_PROJECT_DIR"] = dir;
    expect(errorOpenRead(tool, call(dir, tool, input), dir)).toBe(true);
  });

  test.each([
    ["Read", { file_path: "/etc/hosts" }],
    ["Read", { file_path: ".git/config" }],
    ["Read", { file_path: ".GIT/config" }],
    ["Read", { file_path: ".Git/HEAD" }],
    ["Grep", { pattern: "url" }],
    ["Grep", { pattern: "url", path: "." }],
    ["Glob", { pattern: ".GIT/**", path: "src" }],
    ["Glob", { pattern: "[.]git/*", path: "src" }],
    ["LS", { path: ".git" }], // a one-level listing of the root is allowed (#35); .git is not
    ["Write", { file_path: "src/a.ts", content: "x" }],
    ["Read", "not an object"],
  ])("%s %j outside the project, into .git, or unreadable is refused", (tool, input) => {
    const dir = makeTempProject({ "src/a.ts": "", ".git/config": "", ".git/HEAD": "" });
    process.env["CLAUDE_PROJECT_DIR"] = dir;
    expect(errorOpenRead(tool, call(dir, tool, input as object), dir)).toBe(false);
  });
});

describe("path-gate-hook — run start", () => {
  test("the architect's first call stamps run-start once; later calls do not add another", () => {
    const dir = makeTempProject({});
    const call = payload(dir, "Read", { file_path: join(dir, "spec.md") });
    run(dir, call, ["--role", "architect"]);
    run(dir, call, ["--role", "architect"]);
    run(dir, payload(dir, "Bash", { command: "npm test" }), ["--role", "architect"]);
    const starts = readGuardLog(dir).filter((e) => e.guard === RUN_START_GUARD);
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ verdict: "pass", summary: "first gated tool call (architect: Read)", detail: { kind: "run-start", role: "architect", tool: "Read" } });
  });

  test("a worker stamps no run-start", () => {
    const dir = makeTempProject({ ".bounded/dev-stage-role": "builder\n" });
    run(dir, payload(dir, "Read", { file_path: join(dir, "tests/a.test.ts") }));
    expect(readGuardLog(dir).filter((e) => e.guard === RUN_START_GUARD)).toEqual([]);
  });
});

describe("host declaration (ADR LEG-2026-034)", () => {
  test("a bound role declares claude-code with every constraint — the definition's tools: is the strip", () => {
    const dir = makeTempProject({});
    run(dir, payload(dir, "Read", { file_path: join(dir, "spec.md") }), ["--role", "architect"]);
    const hosts = readGuardLog(dir).filter((e) => e.guard === "host");
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.summary).toBe(
      "host claude-code: enforces tool-strip, path-gate, phase-gate, scoped-views",
    );
    // Declared before the run starts, so the host line explains what follows.
    const order = readGuardLog(dir).map((e) => e.guard);
    expect(order.indexOf("host")).toBeLessThan(order.indexOf(RUN_START_GUARD));
  });

  test("an ambient role (from the role file) declares claude-code WITHOUT the strip", () => {
    const dir = makeTempProject({ ".bounded/dev-stage-role": "builder\n" });
    run(dir, payload(dir, "Read", { file_path: join(dir, "src", "x.ts") }));
    const hosts = readGuardLog(dir).filter((e) => e.guard === "host");
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.summary).toBe(
      "host claude-code: enforces path-gate, phase-gate, scoped-views; unenforced: tool-strip",
    );
  });

  test("recorded on change: two calls under the same binding leave one line", () => {
    const dir = makeTempProject({});
    run(dir, payload(dir, "Read", { file_path: join(dir, "spec.md") }), ["--role", "architect"]);
    run(dir, payload(dir, "Read", { file_path: join(dir, "spec.md") }), ["--role", "architect"]);
    expect(readGuardLog(dir).filter((e) => e.guard === "host")).toHaveLength(1);
  });
});

describe("path-gate-hook — the model tier on Agent (ADR LEG-2026-022)", () => {
  // The reviewer is freely commissionable (it reads the design before the
  // freeze), so these fixtures need no contracts or spec to reach the tier.
  const MODELS = ".bounded/dev-stage-models.json";

  test("a configured designModel is injected, translated to this host's vocabulary", () => {
    const dir = makeTempProject({
      ".bounded/dev-stage-role": "architect\n",
      [MODELS]: '{"designModel": "anthropic/claude-opus-5:high"}\n',
    });
    const r = run(dir, payload(dir, "Agent", { subagent_type: "reviewer", prompt: "read it" }));
    expect(r.decision).toBe("allow");
    // Every worker also runs in the foreground (ADR LEG-2026-066).
    expect(r.updatedInput).toEqual({ subagent_type: "reviewer", prompt: "read it", model: "opus", run_in_background: false });
    const event = gateEvents(dir).find((e) => e.guard === "model-tier");
    expect(event).toMatchObject({ verdict: "pass", detail: { kind: "tier-injected", key: "designModel", hostModel: "opus" } });
  });

  test("the tier is policy: a caller-passed model is replaced, loudly", () => {
    const dir = makeTempProject({
      ".bounded/dev-stage-role": "architect\n",
      [MODELS]: '{"designModel": "anthropic/claude-opus-5"}\n',
    });
    const r = run(dir, payload(dir, "Agent", { subagent_type: "reviewer", prompt: "read it", model: "haiku" }));
    expect(r.decision).toBe("allow");
    expect(r.updatedInput).toMatchObject({ model: "opus" });
    const event = gateEvents(dir).find((e) => e.guard === "model-tier");
    expect(event?.summary).toContain("replaced caller's 'haiku'");
  });

  test("a tier this host cannot run refuses the spawn rather than seating a model nobody chose", () => {
    const dir = makeTempProject({
      ".bounded/dev-stage-role": "architect\n",
      [MODELS]: '{"designModel": "fireworks/kimi-k3-fast:medium"}\n',
    });
    const r = run(dir, payload(dir, "Agent", { subagent_type: "reviewer", prompt: "read it" }));
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("names no model this host can run");
    const event = gateEvents(dir).find((e) => e.guard === "model-tier");
    expect(event).toMatchObject({ verdict: "block", detail: { kind: "unresolvable-tier" } });
  });

  test("no config, or this tier unset: the spawn keeps its model, runs in the foreground, and nothing is logged", () => {
    const cases: readonly Readonly<Record<string, string>>[] = [{}, { [MODELS]: '{"workerModel": "anthropic/claude-sonnet-5"}\n' }];
    for (const files of cases) {
      const dir = makeTempProject({ ".bounded/dev-stage-role": "architect\n", ...files });
      const r = run(dir, payload(dir, "Agent", { subagent_type: "reviewer", prompt: "read it" }));
      expect(r.decision).toBe("allow");
      expect(r.updatedInput).toEqual({ subagent_type: "reviewer", prompt: "read it", run_in_background: false });
      expect(gateEvents(dir).some((e) => e.guard === "model-tier")).toBe(false);
    }
  });
});
