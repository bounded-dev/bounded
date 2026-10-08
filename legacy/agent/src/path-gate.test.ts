import { writeProjectPacks } from "./project-composition.ts";
import { mkdirSync, mkdtempSync as createTempDir, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { resolvedProjectPath } from "./setup-state.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { logGuardEvent, readGuardLog } from "./guard-log.ts";
import { asRole, evaluatePathGate, expandSourceRoots, PIPELINE_ROLES, projectPathFacts } from "./path-gate.ts";
import { PI_COMMISSIONS } from "../hosts/pi/extensions/lib/commissions.ts";


const C = "contexts/orders/src";
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
    allowed: { tool: "write", path: `${C}/domain/orders.contract.ts` },
    blocked: { tool: "write", path: `${C}/domain/orders.ts` }, // implementation, not contract
  },
  {
    role: "test-writer",
    allowed: { tool: "write", path: `${C}/domain/orders.test.ts` },
    blocked: { tool: "read", path: `${C}/domain/orders.ts` }, // blind to implementation
  },
  {
    role: "builder",
    allowed: { tool: "write", path: `${C}/domain/orders.ts` },
    blocked: { tool: "read", path: `${C}/domain/orders.test.ts` }, // blind to tests
  },
  {
    role: "reviewer",
    allowed: { tool: "read", path: `${C}/domain/orders.contract.ts` }, // the design under review
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
  mkdirSync(join(cwd, C), { recursive: true });
  writeFileSync(join(cwd, C, "money.contract.ts"), "export type Money = number;\n");
  for (const guard of ["contract-purity", "scaffold", "checksum-gate"]) {
    logGuardEvent(cwd, { guard, verdict: "pass", summary: "step passed" });
  }
  return cwd;
}

const phaseEvents = (cwd: string) => readGuardLog(cwd).filter((e) => e.guard === "phase-gate");

describe("commissioning a worker", () => {
  test("a commission with no host to read it is refused, not guessed at", () => {
    const cwd = readyProject();
    const result = evaluatePathGate({ role: "architect", toolName: "subagent", input: { agent: "builder" }, cwd });
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("this host supplied no commission policy");
  });

  test("pi's children.list is recorded as the continuation check that licenses a relaunch", () => {
    const cwd = readyProject();
    expect(evaluatePathGate({ role: "architect", toolName: "subagent", commissions: PI_COMMISSIONS, input: { action: "children.list" }, cwd })).toBeUndefined();
    expect(phaseEvents(cwd).at(-1)).toMatchObject({ verdict: "pass", summary: "children.list", detail: { kind: "continuation-checked" } });
  });

  test("the builder is allowed straight after the freeze, with no red, and is recorded", () => {
    const cwd = readyProject();
    const result = evaluatePathGate({
      role: "architect",
      toolName: "subagent", commissions: PI_COMMISSIONS,
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
        evaluatePathGate({ role: "architect", toolName: "subagent", commissions: PI_COMMISSIONS, input: { agent }, cwd }),
      ).toBeUndefined();
    }
    expect(phaseEvents(cwd).map((e) => e.summary)).toEqual([
      "commissioned test-writer",
      "commissioned builder",
    ]);
  });

  test("contracts are found under the source roots only (ADR LEG-2026-056)", () => {
    const cwd = readyProject();
    rmSync(join(cwd, C), { recursive: true, force: true });
    mkdirSync(join(cwd, "lib"), { recursive: true });
    writeFileSync(join(cwd, "lib", "money.contract.ts"), "export type Money = number;\n");
    expect(evaluatePathGate({ role: "architect", toolName: "subagent", commissions: PI_COMMISSIONS, input: { agent: "builder" }, cwd })?.block).toBe(true);
    mkdirSync(join(cwd, "apps/web/src/deep/er"), { recursive: true });
    writeFileSync(join(cwd, "apps/web/src/deep/er/money.contract.ts"), "export type Money = number;\n");
    expect(evaluatePathGate({ role: "architect", toolName: "subagent", commissions: PI_COMMISSIONS, input: { agent: "builder" }, cwd })).toBeUndefined();
  });

  test("an unmet precondition blocks and is logged as a phase-gate refusal", () => {
    const cwd = tmp(); // nothing designed at all
    const result = evaluatePathGate({
      role: "architect",
      toolName: "subagent", commissions: PI_COMMISSIONS,
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
      toolName: "subagent", commissions: PI_COMMISSIONS,
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
      toolName: "subagent", commissions: PI_COMMISSIONS,
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
      toolName: "subagent", commissions: PI_COMMISSIONS,
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
      toolName: "subagent", commissions: PI_COMMISSIONS,
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
      toolName: "subagent", commissions: PI_COMMISSIONS,
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
      toolName: "subagent", commissions: PI_COMMISSIONS,
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
      toolName: "subagent", commissions: PI_COMMISSIONS,
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
        toolName: "subagent", commissions: PI_COMMISSIONS,
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
      toolName: "subagent", commissions: PI_COMMISSIONS,
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
      toolName: "subagent", commissions: PI_COMMISSIONS,
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
        toolName: "subagent", commissions: PI_COMMISSIONS,
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
        toolName: "subagent", commissions: PI_COMMISSIONS,
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
  writeProjectPacks(dir, ["ts", "ts-hexagonal", "ts-trpc", "ts-web"]);
  return dir;
}

// decide() judges the path as written; a link inside the project can point
// anywhere. The gate judges an allowed path again on what it resolves to.
describe("links inside the project", () => {
  function linked(): string {
    const cwd = tmp();
    const outside = tmp();
    writeFileSync(join(outside, "passwd"), "secret\n");
    mkdirSync(join(cwd, C, "domain"), { recursive: true });
    mkdirSync(join(cwd, "docs"), { recursive: true });
    mkdirSync(join(cwd, ".git"), { recursive: true });
    writeFileSync(join(cwd, C, "a.ts"), "export {};\n");
    writeFileSync(join(cwd, C, "domain", "a.test.ts"), "test('x', () => {});\n");
    writeFileSync(join(cwd, C, "domain", "a.handler.ts"), "export {};\n");
    writeFileSync(join(cwd, ".git", "config"), "[core]\n");
    symlinkSync(outside, join(cwd, C, "out"));
    symlinkSync(join(cwd, ".git"), join(cwd, C, "g"));
    // Innocent names that resolve onto the other side.
    symlinkSync(join(cwd, C, "domain", "a.test.ts"), join(cwd, C, "innocent.ts"));
    symlinkSync(join(cwd, C, "domain", "a.handler.ts"), join(cwd, C, "innocent.test.ts"));
    symlinkSync(join(cwd, C, "domain"), join(cwd, "docs", "domain-link"));
    return cwd;
  }

  test.each(["architect", "reviewer", "builder", "test-writer"])("%s cannot read out of the project or into .git through a link", (role) => {
    const cwd = linked();
    for (const path of [`${C}/out/passwd`, `${C}/g/config`]) {
      expect(evaluatePathGate({ role, toolName: "read", input: { path }, cwd })?.block, path).toBe(true);
    }
    if (role !== "test-writer") expect(evaluatePathGate({ role, toolName: "read", input: { path: `${C}/a.ts` }, cwd })).toBeUndefined();
  });

  test("a write through a link is held to the zone it lands in", () => {
    const cwd = linked();
    expect(evaluatePathGate({ role: "builder", toolName: "write", input: { path: `${C}/b.ts` }, cwd })).toBeUndefined();
    expect(evaluatePathGate({ role: "builder", toolName: "write", input: { path: `${C}/innocent.ts` }, cwd })?.block).toBe(true);
    expect(evaluatePathGate({ role: "builder", toolName: "write", input: { path: `${C}/out/x.ts` }, cwd })?.block).toBe(true);
  });

  test("an innocent name linked to the other side is judged by what it resolves to", () => {
    const cwd = linked();
    const read = (role: string, path: string) => evaluatePathGate({ role, toolName: "read", input: { path }, cwd });
    expect(read("builder", `${C}/innocent.ts`)?.reason).toContain("it is a test file");
    expect(read("test-writer", `${C}/innocent.test.ts`)?.reason).toContain("it is an implementation file");
    const grep = evaluatePathGate({ role: "builder", toolName: "grep", input: { path: `${C}/innocent.ts`, pattern: "x" }, cwd });
    expect(grep?.block).toBe(true);
  });

  test("a directory outside every root that links into one needs the glob proof", () => {
    const cwd = linked();
    const grep = (glob?: string) => evaluatePathGate({
      role: "builder", toolName: "grep", cwd,
      input: { path: "docs/domain-link", pattern: "x", ...(glob === undefined ? {} : { glob }) },
    });
    expect(grep()?.reason).toContain("can reach test files");
    expect(grep("*.handler.ts")).toBeUndefined();
    // Searching the directory that HOLDS the link is refused whatever the
    // glob: whether a tool follows the link is the tool's business.
    expect(evaluatePathGate({ role: "builder", toolName: "grep", input: { path: "docs", pattern: "x", glob: "*.handler.ts" }, cwd })?.reason)
      .toContain("'docs/domain-link' is a link");
  });
});

// The gate hands decide() what the filesystem says, so a content search can
// be judged on what it would really read.
describe("content search on the real tree", () => {
  function tree(): string {
    const cwd = tmp();
    mkdirSync(join(cwd, C, "domain"), { recursive: true });
    writeFileSync(join(cwd, C, "domain", "money.ts"), "export {};\n");
    writeFileSync(join(cwd, C, "domain", "money.test.ts"), "test('x', () => {});\n");
    return cwd;
  }
  const grep = (cwd: string, role: string, path: string, glob?: string) => evaluatePathGate({
    role, toolName: "grep", cwd, input: { path, pattern: "x", ...(glob === undefined ? {} : { glob }) },
  });

  test("a grep of one implementation file needs no glob; of a directory it does", () => {
    const cwd = tree();
    expect(grep(cwd, "builder", `${C}/domain/money.ts`)).toBeUndefined();
    expect(grep(cwd, "builder", `${C}/domain`)?.block).toBe(true);
    expect(grep(cwd, "builder", `${C}/domain`, "*.money.ts")).toBeUndefined();
    expect(grep(cwd, "test-writer", `${C}/domain`, "*.test.ts")).toBeUndefined();
    expect(grep(cwd, "test-writer", `${C}/domain/money.ts`)?.block).toBe(true);
  });

  test("the refusal is logged with the path the role asked for", () => {
    const cwd = tree();
    const result = grep(cwd, "builder", C);
    expect(result?.reason).toContain("pass a glob naming the files you want");
    expect(readGuardLog(cwd).at(-1)).toMatchObject({ guard: "path-gate", verdict: "block", detail: { role: "builder", tool: "grep", path: C } });
  });

  test("an unreadable composition refuses every blind read inside a would-be root", () => {
    const cwd = tree();
    rmSync(join(cwd, ".bounded", "composed-packs.json"));
    expect(evaluatePathGate({ role: "builder", toolName: "read", input: { path: `${C}/domain/money.test.ts` }, cwd })?.block).toBe(true);
    expect(evaluatePathGate({ role: "test-writer", toolName: "read", input: { path: `${C}/domain/money.ts` }, cwd })?.block).toBe(true);
    expect(evaluatePathGate({ role: "builder", toolName: "write", input: { path: `${C}/domain/money.ts` }, cwd })?.block).toBe(true);
    expect(evaluatePathGate({ role: "builder", toolName: "ls", input: { path: C }, cwd })).toBeUndefined();
  });
});

describe("projectPathFacts.asWritten — the real location is the path as written", () => {
  test("plain paths, the root and absent paths are as written; links and paths through them are not", () => {
    const cwd = tmp();
    mkdirSync(join(cwd, ".git"), { recursive: true });
    mkdirSync(join(cwd, "src/sub"), { recursive: true });
    writeFileSync(join(cwd, "src/a.ts"), "");
    symlinkSync(join(cwd, ".git"), join(cwd, "src/g"));
    symlinkSync("/etc", join(cwd, "src/out"));
    symlinkSync(join(cwd, "nowhere"), join(cwd, "src/dangling"));
    const facts = projectPathFacts(cwd);
    for (const p of [".", "src", "src/", "src/sub", "src/a.ts", "src/missing", "missing/deeper"]) {
      expect(facts.asWritten?.(p), p).toBe(true);
    }
    for (const p of ["src/g", "src/g/", "src/g/objects", "src/out", "src/out/hosts", "src/dangling", "../x", "/etc"]) {
      expect(facts.asWritten?.(p), p).toBe(false);
    }
  });
});

describe("projectPathFacts", () => {
  test("kind follows links and never looks outside the project", () => {
    const cwd = tmp();
    const outside = tmp();
    mkdirSync(join(cwd, "d"));
    writeFileSync(join(cwd, "d", "f.ts"), "");
    symlinkSync(join(cwd, "d"), join(cwd, "dl"));
    const facts = projectPathFacts(cwd);
    expect(facts.kind("d")).toBe("directory");
    expect(facts.kind("dl")).toBe("directory");
    expect(facts.kind("d/f.ts")).toBe("file");
    expect(facts.kind("d/none")).toBe("absent");
    expect(facts.kind(`../${outside.split("/").at(-1)}`)).toBe("absent");
  });

  test("tree lists every name below and every link, skips .git, follows no nested link", () => {
    const cwd = tmp();
    const outside = tmp();
    writeFileSync(join(outside, "hidden.TEST.ts"), "");
    mkdirSync(join(cwd, "d", "e", ".git"), { recursive: true });
    mkdirSync(join(cwd, "d", ".hidden"), { recursive: true });
    writeFileSync(join(cwd, "d", "a.ts"), "");
    writeFileSync(join(cwd, "d", "e", "b.Test.ts"), "");
    writeFileSync(join(cwd, "d", ".hidden", "c.ts"), "");
    writeFileSync(join(cwd, "d", "e", ".git", "HEAD"), "");
    symlinkSync(outside, join(cwd, "d", "out"));
    symlinkSync(join(cwd, "d", "a.ts"), join(cwd, "d", "e", "alias.ts"));
    const tree = projectPathFacts(cwd).tree("d")!;
    expect([...tree.fileNames].sort()).toEqual(["a.ts", "b.Test.ts", "c.ts"]);
    expect(tree.links).toEqual(["d/e/alias.ts", "d/out"]);
    expect(projectPathFacts(cwd).tree("missing")).toBeUndefined();
    expect(projectPathFacts(cwd).tree("..")).toBeUndefined();
  });
});

// Adversarial review, round 1: the reviewer's probes, on a real tree.
describe("attacks through the real filesystem and the hosts' path rewriting", () => {
  function tree(): string {
    const cwd = tmp();
    mkdirSync(join(cwd, C, "domain"), { recursive: true });
    writeFileSync(join(cwd, C, "domain", "a.ts"), "export {};\n");
    writeFileSync(join(cwd, C, "domain", "a.test.ts"), "test('x', () => {});\n");
    return cwd;
  }
  const gate = (cwd: string, role: string, toolName: string, input: Record<string, unknown>, host?: "pi" | "claude-code") =>
    evaluatePathGate({ role, toolName, input, cwd, ...(host !== undefined ? { host } : {}) });
  // Whether this filesystem folds 'ſ' onto 's' (APFS does; most Linux file
  // systems do not). The refusal holds either way; the fold is what made it
  // an attack.
  const folds = (cwd: string) => {
    try {
      return statSync(join(cwd, C.replace("contexts", "contextſ"), "domain", "a.test.ts")).isFile();
    } catch {
      return false;
    }
  };

  test("a Unicode-folded spelling of a test or implementation is refused on every tool", () => {
    const cwd = tree();
    const test = `${C.replace("contexts", "contextſ")}/domain/a.test.ts`;
    const impl = `${C}/domain/a.tſ`;
    for (const tool of ["read", "write", "edit", "remove"]) {
      expect(gate(cwd, "builder", tool, { path: test })?.reason, tool).toContain("non-ASCII character");
    }
    expect(gate(cwd, "builder", "grep", { path: C.replace("contexts", "contextſ"), pattern: "x", glob: "*.ts" })?.block).toBe(true);
    expect(gate(cwd, "test-writer", "read", { path: impl })?.reason).toContain("non-ASCII character");
    expect(gate(cwd, "test-writer", "grep", { path: "contextſ", pattern: "x", glob: "*.test.ts" })?.block).toBe(true);
    if (folds(cwd)) {
      // The canonical spelling is what the gate would judge even without the
      // ASCII rule: realpath.native names the real file.
      expect(resolvedProjectPath(cwd, test)).toBe(`${C}/domain/a.test.ts`);
    }
  });

  test("a case-folded spelling resolves to the real name and is judged as it", () => {
    const cwd = tree();
    const upper = `${C.toUpperCase()}/DOMAIN/A.TEST.TS`;
    expect(gate(cwd, "builder", "read", { path: upper })?.block).toBe(true);
    if (folds(cwd)) expect(resolvedProjectPath(cwd, upper)).toBe(`${C}/domain/a.test.ts`);
  });

  test("the tree walk lists the canonical directory, and a non-ASCII name in it refuses a grep", () => {
    const cwd = tree();
    writeFileSync(join(cwd, C, "domain", "b.teſt.ts"), "");
    const r = gate(cwd, "builder", "grep", { path: C, pattern: "x", glob: "*.handler.ts" });
    expect(r?.reason).toContain("has a non-ASCII name");
    if (folds(cwd)) {
      const listed = projectPathFacts(cwd).tree(C.toUpperCase())!;
      expect(listed.oddNames.every((name) => name.startsWith(`${C}/`))).toBe(true);
    }
  });

  test("pi: '@', '~/' and file:// are rewritten as pi rewrites them, then judged", () => {
    const cwd = tree();
    const test = `${C}/domain/a.test.ts`;
    for (const path of [`@${test}`, `file://${join(cwd, test)}`, `@file://${join(cwd, test)}`]) {
      expect(gate(cwd, "builder", "read", { path })?.reason, path).toContain("it is a test file");
    }
    expect(gate(cwd, "builder", "read", { path: `@${C}/domain/a.ts` })).toBeUndefined();
    expect(gate(cwd, "test-writer", "read", { path: `@${C}/domain/a.ts` })?.reason).toContain("it is an implementation file");
    // '~' is the home directory, never the project's own '~' folder.
    expect(gate(cwd, "builder", "read", { path: "~/anything.ts" })?.block).toBe(true);
    expect(gate(cwd, "builder", "grep", { path: `@${C}`, pattern: "x", glob: "*.ts" })?.reason).toContain("could match a test file name");
  });

  test("pi: a read pi would redirect to another spelling is refused", () => {
    const cwd = tree();
    writeFileSync(join(cwd, C, "domain", "it’s.test.ts"), "");
    const r = gate(cwd, "builder", "read", { path: `${C}/domain/it's.test.ts` });
    expect(r?.reason).toContain("pi would open");
  });

  test("Claude Code: '~', 'file:' and '@' are refused, not guessed", () => {
    const cwd = tree();
    for (const path of ["~/x.ts", `file://${join(cwd, C, "domain/a.ts")}`, `@${C}/domain/a.ts`]) {
      expect(gate(cwd, "builder", "read", { path }, "claude-code")?.reason, path).toMatch(/pass the (absolute project )?path/);
    }
    expect(gate(cwd, "builder", "read", { path: join(cwd, C, "domain/a.ts") }, "claude-code")).toBeUndefined();
  });

  test("a glob with a comma or whitespace is refused on both hosts", () => {
    const cwd = tree();
    for (const host of ["pi", "claude-code"] as const) {
      for (const glob of ["*.handler.ts,*.test.ts", "*.handler.ts *.test.ts"]) {
        expect(gate(cwd, "builder", "grep", { path: join(cwd, C), pattern: "x", glob }, host)?.reason).toContain("whitespace or a comma");
      }
    }
  });
});

describe("expandSourceRoots", () => {
  test("each '*' expands to real, non-hidden directories; case is ignored; links are not followed", () => {
    const cwd = tmp();
    for (const dir of ["contexts/a/src", "contexts/b/src", "contexts/c/lib", "contexts/.x/src", "Apps/web/SRC"]) {
      mkdirSync(join(cwd, dir), { recursive: true });
    }
    writeFileSync(join(cwd, "contexts", "file"), "");
    symlinkSync(join(cwd, "contexts", "a"), join(cwd, "contexts", "linked"));
    expect(expandSourceRoots(cwd, ["contexts/*/src", "apps/*/src"])).toEqual(["Apps/web/SRC", "contexts/a/src", "contexts/b/src"]);
    expect(expandSourceRoots(cwd, [])).toEqual([]);
  });
});
