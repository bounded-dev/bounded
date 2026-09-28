import { writeProjectPacks } from "./project-composition.ts";
import { mkdirSync, mkdtempSync as createTempDir, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { logGuardEvent, readGuardLog } from "./guard-log.ts";
import { asRole, evaluatePathGate, PIPELINE_ROLES } from "./path-gate.ts";
import { devStageModelsPath } from "./dev-stage-models.ts";
import type { KnownModel } from "./model-tier.ts";

// TN-26-001 Phase 2: the path-gate's testable core — event + role + cwd →
// {block,reason} | undefined, including the guard-log side effect on a block.
// Wiring over the already-tested decide(); we assert the DECISION and the LOG.

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "path-gate-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("asRole — only the pipeline roles are recognized", () => {
  test.each(PIPELINE_ROLES)("accepts %s", (role) => {
    expect(asRole(role)).toBe(role);
  });
  test.each([undefined, null, "", "orchestrator", "ARCHITECT", "delegate", 42, {}])(
    "rejects %s → undefined (gate inactive)",
    (value) => {
      expect(asRole(value)).toBeUndefined();
    },
  );
});

describe("gate is inactive without a pipeline role (normal/orchestrator sessions)", () => {
  test.each([undefined, null, "", "orchestrator", "delegate"])(
    "role %s → undefined and writes no log",
    (role) => {
      const cwd = tmp();
      const result = evaluatePathGate({
        role,
        toolName: "write",
        input: { path: "anywhere.ts" },
        cwd,
      });
      expect(result).toBeUndefined();
      expect(readGuardLog(cwd)).toEqual([]);
    },
  );
});

// Representative allowed + blocked call per role. `allowed` must pass through
// (undefined, no log); `blocked` must return a reason AND leave one path-gate
// block entry in the target project's guard log.
type Case = {
  role: (typeof PIPELINE_ROLES)[number];
  allowed: { tool: string; path: string };
  blocked: { tool: string; path: string };
};

const CASES: Case[] = [
  {
    role: "architect",
    allowed: { tool: "write", path: "src/orders/orders.contract.ts" },
    blocked: { tool: "write", path: "src/orders/orders.ts" }, // implementation, not contract
  },
  {
    role: "test-writer",
    allowed: { tool: "write", path: "tests/orders.test.ts" },
    blocked: { tool: "read", path: "src/orders/orders.ts" }, // blind to src/
  },
  {
    role: "builder",
    allowed: { tool: "write", path: "src/orders/orders.ts" },
    blocked: { tool: "read", path: "tests/orders.test.ts" }, // blind to tests/
  },
  {
    role: "reviewer",
    allowed: { tool: "read", path: "src/orders/orders.contract.ts" }, // the design under review
    blocked: { tool: "write", path: "spec.md" }, // not even the file it is reviewing
  },
];

describe.each(CASES)("$role", ({ role, allowed, blocked }) => {
  test(`allows ${allowed.tool} ${allowed.path} → undefined, no log`, () => {
    const cwd = tmp();
    const result = evaluatePathGate({
      role,
      toolName: allowed.tool,
      input: { path: allowed.path },
      cwd,
    });
    expect(result).toBeUndefined();
    expect(readGuardLog(cwd)).toEqual([]);
  });

  test(`blocks ${blocked.tool} ${blocked.path} → reason + path-gate log entry`, () => {
    const cwd = tmp();
    const result = evaluatePathGate({
      role,
      toolName: blocked.tool,
      input: { path: blocked.path },
      cwd,
    });
    expect(result).toBeDefined();
    expect(result!.block).toBe(true);
    expect(result!.reason).toContain("path-gate");
    expect(result!.reason).toContain(role);

    const events = readGuardLog(cwd);
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event.guard).toBe("path-gate");
    expect(event.verdict).toBe("block");
    expect(event.summary).toBe(result!.reason);
    expect(event.detail).toMatchObject({
      role,
      tool: blocked.tool,
      path: blocked.path,
    });
  });
});

describe("forbidden tools (bash/subagent) block for a pipeline role and are logged", () => {
  test("builder may not use bash", () => {
    const cwd = tmp();
    const result = evaluatePathGate({
      role: "builder",
      toolName: "bash",
      input: { command: "ls tests/" },
      cwd,
    });
    expect(result?.block).toBe(true);
    const events = readGuardLog(cwd);
    expect(events).toHaveLength(1);
    expect(events[0].guard).toBe("path-gate");
    expect(events[0].detail).toMatchObject({ role: "builder", tool: "bash" });
  });
});

describe("ungated tools pass through untouched", () => {
  test("a non-path, non-forbidden tool → undefined, no log", () => {
    const cwd = tmp();
    const result = evaluatePathGate({
      role: "architect",
      toolName: "web_search",
      input: { query: "anything" },
      cwd,
    });
    expect(result).toBeUndefined();
    expect(readGuardLog(cwd)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Commissioning: the wiring around checkSubagentCall.
// ---------------------------------------------------------------------------
//
// The decision lives in phase-gate.ts and is tested there. What is tested here
// is the half a pure core may not do: writing what happened to the target
// project's guard log, so a run that jammed — or one that quietly fanned out —
// is inspectable afterwards.

/** Evidence of a completed design, written into the project the gate reads. */
function readyProject(): string {
  const cwd = tmp();
  writeFileSync(
    join(cwd, "spec.md"),
    "## Intake\n\nNothing stripped.\n\n## Rules\n\n" + "x".repeat(4000),
  );
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "src", "money.contract.ts"), "export type Money = number;\n");
  for (const guard of ["contract-purity", "scaffold", "checksum-gate"]) {
    logGuardEvent(cwd, { guard, verdict: "pass", summary: "step passed" });
  }
  return cwd;
}

const phaseEvents = (cwd: string) => readGuardLog(cwd).filter((e) => e.guard === "phase-gate");

describe("commissioning a worker", () => {
  test("the builder is allowed straight after the freeze, with no red, and is recorded", () => {
    const cwd = readyProject();
    const result = evaluatePathGate({
      role: "architect",
      toolName: "subagent",
      input: { agent: "builder", task: "implement the contract" },
      cwd,
    });
    expect(result).toBeUndefined();
    expect(phaseEvents(cwd).at(-1)).toMatchObject({
      verdict: "pass",
      summary: "commissioned builder",
      detail: { kind: "spawn", target: "builder" },
    });
  });

  test("both workers may be live at once", () => {
    const cwd = readyProject();
    for (const agent of ["test-writer", "builder"]) {
      expect(
        evaluatePathGate({ role: "architect", toolName: "subagent", input: { agent }, cwd }),
      ).toBeUndefined();
    }
    expect(phaseEvents(cwd).map((e) => e.summary)).toEqual([
      "commissioned test-writer",
      "commissioned builder",
    ]);
  });

  test("an unmet precondition blocks and is logged as a phase-gate refusal", () => {
    const cwd = tmp(); // nothing designed at all
    const result = evaluatePathGate({
      role: "architect",
      toolName: "subagent",
      input: { agent: "test-writer" },
      cwd,
    });
    expect(result?.block).toBe(true);
    expect(phaseEvents(cwd).at(-1)).toMatchObject({
      verdict: "block",
      detail: { kind: "spawn-refused", role: "architect", target: "test-writer" },
    });
  });
});

describe("multi-spawn forms", () => {
  test("a workflowScript naming a worker is blocked and logged with the form", () => {
    const cwd = readyProject(); // fully designed: the refusal is about the SHAPE
    const result = evaluatePathGate({
      role: "architect",
      toolName: "subagent",
      input: {
        workflowScript:
          'return runs.all([{key:"tw", agent:"test-writer"}, {key:"b", agent:"builder"}])',
      },
      cwd,
    });
    expect(result?.block).toBe(true);
    expect(result!.reason).toContain("workflowScript");
    expect(phaseEvents(cwd).at(-1)).toMatchObject({
      verdict: "block",
      detail: { kind: "spawn-refused", form: "workflowScript", roles: ["test-writer", "builder"] },
    });
  });

  test("a fan-out of non-pipeline agents passes through and logs one pass", () => {
    const cwd = readyProject();
    const result = evaluatePathGate({
      role: "architect",
      toolName: "subagent",
      input: { workflowScript: 'return runs.all([{key:"a", agent:"scout", task:"survey"}])' },
      cwd,
    });
    expect(result).toBeUndefined();
    const events = phaseEvents(cwd);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      verdict: "pass",
      summary: "workflowScript fan-out (no pipeline role)",
      detail: { kind: "fan-out", role: "architect", form: "workflowScript" },
    });
  });
});

describe("delegate is refused inside the pipeline only", () => {
  test("a bound role may not spawn it", () => {
    const cwd = readyProject();
    const result = evaluatePathGate({
      role: "architect",
      toolName: "subagent",
      input: { agent: "delegate", task: "clean up the generated files" },
      cwd,
    });
    expect(result?.block).toBe(true);
    expect(result!.reason).toContain("delegate holds no role binding");
    expect(phaseEvents(cwd).at(-1)).toMatchObject({
      verdict: "block",
      detail: { kind: "spawn-refused", target: "delegate" },
    });
  });

  test("an unbound session spawns it freely — the gate is inactive there", () => {
    const cwd = readyProject();
    const result = evaluatePathGate({
      role: undefined,
      toolName: "subagent",
      input: { agent: "delegate", task: "clean up the generated files" },
      cwd,
    });
    expect(result).toBeUndefined();
    expect(phaseEvents(cwd)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Resumes are recorded here, because nothing else was recording them (r15)
// ---------------------------------------------------------------------------

describe("resuming a child", () => {
  test("a resume passes and lands in the log as a commissioned seat", () => {
    const cwd = readyProject();
    const result = evaluatePathGate({
      role: "architect",
      toolName: "subagent",
      input: { action: "resume", id: "run-42", message: "the red gate says X" },
      cwd,
    });
    expect(result).toBeUndefined();
    expect(phaseEvents(cwd).at(-1)).toMatchObject({
      verdict: "pass",
      summary: "resumed unknown (run-42)",
      detail: { kind: "resume", target: "unknown", run: "run-42" },
    });
  });

  test("a resume that names a role records it", () => {
    const cwd = readyProject();
    evaluatePathGate({
      role: "architect",
      toolName: "subagent",
      input: { action: "resume", agent: "builder", id: "run-9" },
      cwd,
    });
    expect(phaseEvents(cwd).at(-1)).toMatchObject({
      summary: "resumed builder (run-9)",
      detail: { kind: "resume", target: "builder", run: "run-9" },
    });
  });

  test("resuming delegate is refused and logged like any other spawn refusal", () => {
    const cwd = readyProject();
    const result = evaluatePathGate({
      role: "architect",
      toolName: "subagent",
      input: { action: "resume", agent: "delegate", id: "run-3" },
      cwd,
    });
    expect(result?.block).toBe(true);
    expect(phaseEvents(cwd).at(-1)).toMatchObject({
      verdict: "block",
      detail: { kind: "spawn-refused", target: "delegate" },
    });
  });

  // status/steer/wait remain untouched: they inspect, they do not commission.
  test("the other management actions still write nothing", () => {
    const cwd = readyProject();
    for (const action of ["status", "steer", "wait", "interrupt"]) {
      evaluatePathGate({
        role: "architect",
        toolName: "subagent",
        input: { action, id: "run-1" },
        cwd,
      });
    }
    expect(phaseEvents(cwd)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The seat's model is policy: an unresolvable tier refuses the spawn (r15)
// ---------------------------------------------------------------------------

describe("a tier the registry cannot resolve", () => {
  const REGISTRY: readonly KnownModel[] = [{ provider: "anthropic", id: "claude-opus-4" }];

  function tiered(config: string): string {
    const cwd = readyProject();
    const path = devStageModelsPath(cwd);
    mkdirSync(join(cwd, ".bounded"), { recursive: true });
    writeFileSync(path, config);
    return cwd;
  }

  test("the spawn is refused, and the refusal names the file and the pattern", () => {
    const cwd = tiered('{"designModel": "kimi-k3:high"}');
    const result = evaluatePathGate({
      role: "architect",
      toolName: "subagent",
      input: { agent: "reviewer", task: "read the design" },
      cwd,
      known: REGISTRY,
    });
    expect(result?.block).toBe(true);
    expect(result!.reason).toContain(".bounded/dev-stage-models.json");
    expect(result!.reason).toContain("kimi-k3:high");
    expect(phaseEvents(cwd).at(-1)).toMatchObject({
      verdict: "block",
      detail: { kind: "spawn-refused", target: "reviewer" },
    });
  });

  test("a resolvable tier commissions normally", () => {
    const cwd = tiered('{"designModel": "anthropic/claude-opus-4:high"}');
    const result = evaluatePathGate({
      role: "architect",
      toolName: "subagent",
      input: { agent: "reviewer", task: "read the design" },
      cwd,
      known: REGISTRY,
    });
    expect(result).toBeUndefined();
    expect(phaseEvents(cwd).at(-1)).toMatchObject({ summary: "commissioned reviewer" });
  });

  // Never fatal: no snapshot, no config, and a broken config all commission.
  test("without a registry snapshot the same bad config commissions", () => {
    const cwd = tiered('{"designModel": "kimi-k3:high"}');
    expect(
      evaluatePathGate({
        role: "architect",
        toolName: "subagent",
        input: { agent: "reviewer" },
        cwd,
      }),
    ).toBeUndefined();
  });

  test("a malformed config is ignored, not fatal", () => {
    const cwd = tiered("{ this is not json");
    expect(
      evaluatePathGate({
        role: "architect",
        toolName: "subagent",
        input: { agent: "reviewer" },
        cwd,
        known: REGISTRY,
      }),
    ).toBeUndefined();
  });
});

// Existing fixtures exercise the previously installed language and web rules.
function mkdtempSync(prefix: string): string {
  const dir = createTempDir(prefix);
  writeProjectPacks(dir, ["ts", "ts-web"]);
  return dir;
}

// decide() judges the path as written; a link inside the project can point
// anywhere. The gate judges an allowed path again on what it resolves to.
describe("links inside the project", () => {
  function linked(): string {
    const cwd = tmp();
    const outside = tmp();
    writeFileSync(join(outside, "passwd"), "secret\n");
    mkdirSync(join(cwd, "src"), { recursive: true });
    mkdirSync(join(cwd, "tests"), { recursive: true });
    mkdirSync(join(cwd, ".git"), { recursive: true });
    writeFileSync(join(cwd, "src", "a.ts"), "export {};\n");
    writeFileSync(join(cwd, ".git", "config"), "[core]\n");
    symlinkSync(outside, join(cwd, "src", "out"));
    symlinkSync(join(cwd, ".git"), join(cwd, "src", "g"));
    symlinkSync(join(cwd, "tests"), join(cwd, "src", "t"));
    return cwd;
  }

  test.each(["architect", "reviewer", "builder", "test-writer"])("%s cannot read out of the project or into .git through a link", (role) => {
    const cwd = linked();
    for (const path of ["src/out/passwd", "src/g/config"]) {
      expect(evaluatePathGate({ role, toolName: "read", input: { path }, cwd })?.block, path).toBe(true);
    }
    if (role !== "test-writer") expect(evaluatePathGate({ role, toolName: "read", input: { path: "src/a.ts" }, cwd })).toBeUndefined();
  });

  test("a write through a link is held to the zone it lands in", () => {
    const cwd = linked();
    expect(evaluatePathGate({ role: "builder", toolName: "write", input: { path: "src/b.ts" }, cwd })).toBeUndefined();
    expect(evaluatePathGate({ role: "builder", toolName: "write", input: { path: "src/t/x.test.ts" }, cwd })?.block).toBe(true);
    expect(evaluatePathGate({ role: "builder", toolName: "write", input: { path: "src/out/x.ts" }, cwd })?.block).toBe(true);
  });
});
