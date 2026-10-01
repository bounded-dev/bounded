import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  MODEL_TIER_GUARD,
  SPAWN_AGENT_KEYS,
  applyModelTier as applyTier,
  patternIsKnown,
  planModelTier,
  resetModelTierWarnings,
  spawnTarget,
  stripThinkingSuffix,
  unresolvableTier,
  type KnownModel,
} from "./model-tier.ts";
import { devStageModelsPath, parseDevStageModels } from "./dev-stage-models.ts";
import { readGuardLog } from "./guard-log.ts";
import { isResumeCall, PI_COMMISSIONS, resumeRunId } from "../hosts/pi/extensions/lib/commissions.ts";
import type { ModelTierInput } from "./model-tier.ts";

// applyModelTier reads the call through the host adapter; these cases are pi's.
const applyModelTier = (ev: ModelTierInput) => applyTier(ev, PI_COMMISSIONS);

// WHY THIS EXISTS
//
// The tier only means anything if it reaches the spawn. pi-subagents takes a
// top-level `model` parameter on the `subagent` tool and pi's `tool_call` hook
// lets an extension mutate a tool's arguments in place, so injection is one
// assignment — and one assignment is exactly the kind of thing that silently
// stops happening. These tests pin the four decisions around it: WHICH spawns
// are tiered, which are deliberately left alone (an explicit caller model, a
// non-pipeline agent, a model the registry does not know), and that every
// injection leaves a `model-tier` line in the guard log naming the seat, the
// tier and the pattern — the evidence a run's transcript is supposed to carry.

const dirs: string[] = [];
function project(config?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "model-tier-"));
  dirs.push(dir);
  if (config !== undefined) {
    const path = devStageModelsPath(dir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, config);
  }
  return dir;
}

const BOTH = '{"designModel": "anthropic/claude-opus-4:high", "workerModel": "fireworks/kimi-k3:medium"}';
const MODELS = parseDevStageModels(BOTH);

const REGISTRY: readonly KnownModel[] = [
  { provider: "anthropic", id: "claude-opus-4" },
  { provider: "fireworks", id: "kimi-k3" },
  { provider: "openai", id: "kimi-k3" }, // same bare id under a second provider
];

beforeEach(() => resetModelTierWarnings());
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** The guard log's `model-tier` lines for a project. */
function tierEvents(cwd: string) {
  return readGuardLog(cwd).filter((e) => e.guard === MODEL_TIER_GUARD);
}

describe("which calls are spawns", () => {
  test("a bare agent name, and every key pi-subagents accepts it under", () => {
    expect(SPAWN_AGENT_KEYS).toEqual(["agent", "agentName", "name", "type"]);
    for (const key of SPAWN_AGENT_KEYS) {
      expect(spawnTarget({ [key]: "builder" })).toBe("builder");
    }
  });

  // Which call is a launch is the host's reading (pi's commission host here).
  test("launch and run are spawns; every other action is not", () => {
    const cwd = project(BOTH);
    expect(applyModelTier({ toolName: "subagent", input: { action: "launch", agent: "builder" }, cwd }).kind).toBe("inject");
    expect(applyModelTier({ toolName: "subagent", input: { action: "run", agent: "builder" }, cwd }).kind).toBe("inject");
    for (const action of ["status", "resume", "stop", "steer", "children.list", "list", "get"]) {
      expect(applyModelTier({ toolName: "subagent", input: { action, agent: "builder" }, cwd }).kind, action).toBe("skip");
    }
  });

  // A retained resume keeps the child's stored model contract, so there is
  // nothing to inject.
  test("a resume is not a spawn even when it names an agent", () => {
    const cwd = project(BOTH);
    expect(applyModelTier({ toolName: "subagent", input: { action: "resume", id: "r1", agent: "builder" }, cwd }).kind).toBe("skip");
  });

  test("a call that names no agent is not a spawn", () => {
    expect(spawnTarget({})).toBeUndefined();
    expect(spawnTarget({ agent: "" })).toBeUndefined();
    expect(spawnTarget({ workflowScript: 'runs.run("a", { agent: "builder" })' })).toBeUndefined();
  });
});

describe("the tier a spawn gets", () => {
  test("architect and reviewer take designModel", () => {
    for (const role of ["architect", "reviewer"]) {
      const plan = planModelTier({ agent: role, task: "x" }, MODELS, REGISTRY);
      expect(plan).toEqual({
        kind: "inject",
        role,
        tier: "design",
        key: "designModel",
        model: "anthropic/claude-opus-4:high",
      });
    }
  });

  test("test-writer and builder take workerModel", () => {
    for (const role of ["test-writer", "builder"]) {
      const plan = planModelTier({ agent: role, task: "x" }, MODELS, REGISTRY);
      expect(plan).toEqual({
        kind: "inject",
        role,
        tier: "worker",
        key: "workerModel",
        model: "fireworks/kimi-k3:medium",
      });
    }
  });

  test("every other agent is untouched", () => {
    for (const agent of ["scout", "product-expert", "delegate", "oracle", "worker"]) {
      expect(planModelTier({ agent, task: "x" }, MODELS, REGISTRY)).toEqual({
        kind: "skip",
        why: "not-a-pipeline-role",
        note: agent,
      });
    }
  });

  test("a tier the project left unset is left on the session default", () => {
    const designOnly = parseDevStageModels('{"designModel": "anthropic/claude-opus-4:high"}');
    expect(planModelTier({ agent: "architect" }, designOnly, REGISTRY).kind).toBe("inject");
    expect(planModelTier({ agent: "builder" }, designOnly, REGISTRY)).toEqual({
      kind: "skip",
      why: "no-pattern",
      note: "workerModel",
    });
  });

  // The tier is policy, not a default: a configured seat model replaces a
  // caller-passed one, loudly, or the tier would be a suggestion any spawn
  // could decline — the prose-vs-mechanism failure this harness exists to
  // close. The discarded value is carried so the attempt is visible in the log.
  test("a configured tier replaces a caller-passed model, and records it", () => {
    const plan = planModelTier({ agent: "builder", model: "x/y:low" }, MODELS, REGISTRY);
    expect(plan).toMatchObject({ kind: "inject", overrode: "x/y:low" });
  });

  test("a caller model equal to the tier is not an override", () => {
    const plan = planModelTier({ agent: "builder", model: "fireworks/kimi-k3:medium" }, MODELS, REGISTRY);
    expect(plan.kind).toBe("inject");
    expect((plan as { overrode?: string }).overrode).toBeUndefined();
  });

  test("a blank caller model is not a choice", () => {
    expect(planModelTier({ agent: "builder", model: "  " }, MODELS, REGISTRY).kind).toBe("inject");
  });
});

describe("a model the registry cannot resolve is never injected", () => {
  // pi-subagents throws `Unknown subagent model '<x>'` on an unresolvable
  // EXPLICIT model, so injecting one would turn a stale config line into a
  // dead run — the exact failure the never-fatal rule exists to prevent.
  test("an unknown pattern is skipped, not passed through", () => {
    const stale = parseDevStageModels('{"workerModel": "fireworks/kimi-k9:medium"}');
    expect(planModelTier({ agent: "builder" }, stale, REGISTRY)).toEqual({
      kind: "skip",
      why: "unknown-model",
      note: "fireworks/kimi-k9:medium",
    });
  });

  test("an empty registry snapshot means 'cannot tell', so the tier still applies", () => {
    expect(planModelTier({ agent: "builder" }, MODELS, []).kind).toBe("inject");
  });

  test("exact provider/id and unambiguous bare ids match; ambiguous ones do not", () => {
    expect(patternIsKnown("anthropic/claude-opus-4:high", REGISTRY)).toBe(true);
    expect(patternIsKnown("claude-opus-4", REGISTRY)).toBe(true); // one provider offers it
    expect(patternIsKnown("kimi-k3", REGISTRY)).toBe(false); // two providers do
    expect(patternIsKnown("nope/at-all", REGISTRY)).toBe(false);
  });

  test("only a known thinking level is stripped as a suffix", () => {
    expect(stripThinkingSuffix("a/b:high")).toBe("a/b");
    expect(stripThinkingSuffix("a/b:off")).toBe("a/b");
    expect(stripThinkingSuffix("a/b:max")).toBe("a/b");
    expect(stripThinkingSuffix("a/b")).toBe("a/b");
    expect(stripThinkingSuffix("a/b:2024")).toBe("a/b:2024"); // not a level ⇒ part of the id
  });
});

describe("injection, in place, with the transcript to prove it", () => {
  test("the spawn's arguments carry the tier's pattern afterwards", () => {
    const cwd = project(BOTH);
    const input: Record<string, unknown> = { agent: "builder", task: "implement" };
    const plan = applyModelTier({ toolName: "subagent", input, cwd, known: REGISTRY });
    expect(plan.kind).toBe("inject");
    expect(input["model"]).toBe("fireworks/kimi-k3:medium");
    expect(input["agent"]).toBe("builder"); // nothing else disturbed
    expect(input["task"]).toBe("implement");
  });

  test("one guard event per injected spawn, naming role, tier and pattern", () => {
    const cwd = project(BOTH);
    applyModelTier({ toolName: "subagent", input: { agent: "architect" }, cwd, known: REGISTRY });
    applyModelTier({ toolName: "subagent", input: { agent: "builder" }, cwd, known: REGISTRY });

    const events = tierEvents(cwd);
    expect(events).toHaveLength(2);
    expect(events[0]!.verdict).toBe("pass");
    expect(events[0]!.summary).toBe("architect → designModel (anthropic/claude-opus-4:high)");
    expect(events[0]!.detail).toEqual({
      role: "architect",
      tier: "design",
      key: "designModel",
      model: "anthropic/claude-opus-4:high",
    });
    expect(events[1]!.detail).toMatchObject({ role: "builder", tier: "worker" });
  });

  test("a spawn that gets no tier leaves no line — silence means session default", () => {
    const cwd = project(BOTH);
    applyModelTier({ toolName: "subagent", input: { agent: "scout" }, cwd, known: REGISTRY });
    applyModelTier({ toolName: "subagent", input: { action: "status" }, cwd, known: REGISTRY });
    expect(tierEvents(cwd)).toEqual([]);
  });

  test("a project with no config is untouched and unlogged", () => {
    const cwd = project();
    const input: Record<string, unknown> = { agent: "builder" };
    expect(applyModelTier({ toolName: "subagent", input, cwd, known: REGISTRY })).toEqual({
      kind: "skip",
      why: "no-pattern",
      note: "workerModel",
    });
    expect(input["model"]).toBeUndefined();
    expect(tierEvents(cwd)).toEqual([]);
  });

  test("no other tool is ever touched", () => {
    const cwd = project(BOTH);
    const input: Record<string, unknown> = { agent: "builder", path: "src/x.ts" };
    expect(applyModelTier({ toolName: "read", input, cwd, known: REGISTRY }).kind).toBe("skip");
    expect(input["model"]).toBeUndefined();
  });
});

describe("a broken config costs speed, never the run", () => {
  test("malformed JSON: no injection, no throw, one warning line and one event", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cwd = project("{ not json");
    const input: Record<string, unknown> = { agent: "builder" };

    expect(() => applyModelTier({ toolName: "subagent", input, cwd, known: REGISTRY })).not.toThrow();
    expect(input["model"]).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);

    const events = tierEvents(cwd);
    expect(events).toHaveLength(1);
    expect(events[0]!.verdict).toBe("error");
    expect(events[0]!.summary).toContain("not valid JSON");
  });

  // A malformed config is one mistake; repeating it at every spawn would bury
  // the run's real output under the same line.
  test("the warning is emitted once per project, not once per spawn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cwd = project('{"designmodel": "a/b:high"}');
    for (let i = 0; i < 4; i++) {
      applyModelTier({ toolName: "subagent", input: { agent: "architect" }, cwd, known: REGISTRY });
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(tierEvents(cwd)).toHaveLength(1);
  });

  test("a stale model warns once and the seat falls back to the session default", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cwd = project('{"workerModel": "fireworks/kimi-k9:medium"}');
    const input: Record<string, unknown> = { agent: "builder" };
    expect(applyModelTier({ toolName: "subagent", input, cwd, known: REGISTRY }).kind).toBe("skip");
    expect(input["model"]).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(tierEvents(cwd)[0]!.summary).toContain("not in this session's model registry");
  });

  test("the guard log stays one JSON object per line", () => {
    const cwd = project(BOTH);
    applyModelTier({ toolName: "subagent", input: { agent: "builder" }, cwd, known: REGISTRY });
    const raw = readFileSync(join(cwd, ".bounded", "guard-log.jsonl"), "utf8").trimEnd();
    expect(raw.split("\n")).toHaveLength(1);
    expect(JSON.parse(raw).guard).toBe("model-tier");
  });
});

// ---------------------------------------------------------------------------
// The extension wiring
// ---------------------------------------------------------------------------
//
// The decision above is worthless if the hook never fires or reads the wrong
// context field, and that wiring is exactly the part that breaks silently: a
// run simply comes back on the session default and nobody notices for a week.
// So the extension is installed against a stub pi and driven through the hook.

interface FakeHook {
  (
    event: { toolName: string; input: Record<string, unknown> },
    ctx: { cwd: string; modelRegistry?: { getAvailable(): { provider: string; id: string }[] } },
  ): unknown;
}

async function installed(): Promise<FakeHook> {
  const hooks: FakeHook[] = [];
  const pi = {
    on(event: string, handler: FakeHook) {
      if (event === "tool_call") hooks.push(handler);
    },
    registerTool() {
      throw new Error("model-tier registers no tools");
    },
  };
  const install = (await import("../hosts/pi/extensions/model-tier.ts")).default;
  install(pi as never);
  if (hooks.length !== 1) throw new Error(`expected one tool_call hook, got ${hooks.length}`);
  return hooks[0]!;
}

describe("hosts/pi/extensions/model-tier.ts", () => {
  test("installs exactly one tool_call hook and registers no tools", async () => {
    await expect(installed()).resolves.toBeTypeOf("function");
  });

  test("the hook patches a pipeline spawn and never blocks", async () => {
    const hook = await installed();
    const cwd = project(BOTH);
    const input: Record<string, unknown> = { agent: "test-writer", task: "write the suite" };
    const verdict = hook(
      { toolName: "subagent", input },
      { cwd, modelRegistry: { getAvailable: () => [...REGISTRY] } },
    );
    expect(verdict).toBeUndefined(); // tiering is a speed decision, not a gate
    expect(input["model"]).toBe("fireworks/kimi-k3:medium");
    expect(tierEvents(cwd)).toHaveLength(1);
  });

  test("a registry that throws degrades to no validation rather than no run", async () => {
    const hook = await installed();
    const cwd = project(BOTH);
    const input: Record<string, unknown> = { agent: "builder" };
    hook(
      { toolName: "subagent", input },
      {
        cwd,
        modelRegistry: {
          getAvailable: () => {
            throw new Error("registry unavailable");
          },
        },
      },
    );
    expect(input["model"]).toBe("fireworks/kimi-k3:medium");
  });

  test("tools other than subagent never reach the planner", async () => {
    const hook = await installed();
    const cwd = project(BOTH);
    const input: Record<string, unknown> = { path: "src/x.ts", agent: "builder" };
    expect(hook({ toolName: "read", input }, { cwd })).toBeUndefined();
    expect(input["model"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Resumes: untierable by pi-subagents' own rule, and therefore worth a line
// ---------------------------------------------------------------------------
//
// `action: "resume"` refuses a model override outright — `resumeAsyncRun` in
// pi-subagents 0.52.1 returns "action='resume' reuses the persisted child model
// and does not accept a model override" before doing anything else — so there
// is nothing this module can inject. What it CAN do is stop the seat being
// invisible: r15 resumed children twelve times and left no record of any of it.

describe("resumes", () => {
  test("a resume is recognised whatever else the call carries", () => {
    expect(isResumeCall({ action: "resume", id: "r1" })).toBe(true);
    expect(isResumeCall({ action: "launch", agent: "builder" })).toBe(false);
    expect(isResumeCall({ agent: "builder" })).toBe(false);
  });

  test("the run is read from id, then runId, then dir", () => {
    expect(resumeRunId({ id: "a", runId: "b", dir: "c" })).toBe("a");
    expect(resumeRunId({ runId: "b", dir: "c" })).toBe("b");
    expect(resumeRunId({ dir: "c" })).toBe("c");
    expect(resumeRunId({})).toBeUndefined();
    expect(resumeRunId({ id: "   " })).toBeUndefined();
  });

  test("a resume logs one untierable note and injects nothing", () => {
    const cwd = project(BOTH);
    const input: Record<string, unknown> = { action: "resume", id: "run-7", message: "carry on" };
    const plan = applyModelTier({ toolName: "subagent", input, cwd, known: REGISTRY });
    expect(plan).toEqual({ kind: "skip", why: "untierable-resume", note: "run-7" });
    expect(input["model"]).toBeUndefined();
    const events = tierEvents(cwd);
    expect(events).toHaveLength(1);
    expect(events[0]!.verdict).toBe("pass");
    expect(events[0]!.summary).toContain("run-7");
    expect(events[0]!.summary).toMatch(/untierable/);
    expect(events[0]!.detail).toMatchObject({ kind: "untierable-resume", role: "unknown" });
  });

  test("a resume that names a role records it, so the seat is accountable", () => {
    const cwd = project(BOTH);
    applyModelTier({
      toolName: "subagent",
      input: { action: "resume", agent: "builder", id: "run-8" },
      cwd,
      known: REGISTRY,
    });
    expect(tierEvents(cwd)[0]!.detail).toMatchObject({ role: "builder", run: "run-8" });
  });

  test("the note says WHY", () => {
    const cwd = project(BOTH);
    applyModelTier({ toolName: "subagent", input: { action: "resume", id: "r" }, cwd });
    expect((tierEvents(cwd)[0]!.detail as { why: string }).why).toContain(
      "accepts no model override",
    );
  });

  test("every resume gets its own line — twelve seats are twelve entries", () => {
    const cwd = project(BOTH);
    for (const id of ["a", "b", "c"]) {
      applyModelTier({ toolName: "subagent", input: { action: "resume", id }, cwd });
    }
    expect(tierEvents(cwd)).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// unresolvableTier: the facts a refusal is written from
// ---------------------------------------------------------------------------
//
// The prose lives in phase-gate.ts with every other spawn refusal; this is the
// pure predicate it is written from. `undefined` is "nothing to report", and it
// has to cover every ordinary case, because a false positive here refuses a
// spawn that should have gone ahead.

describe("unresolvableTier", () => {
  test("a configured tier the registry does not know is reported, with its key", () => {
    const stale = parseDevStageModels('{"designModel": "kimi-k3:high"}');
    expect(unresolvableTier("reviewer", stale, REGISTRY)).toEqual({
      key: "designModel",
      model: "kimi-k3:high",
    });
    // Same config, a seat on the other tier: nothing to say.
    expect(unresolvableTier("builder", stale, REGISTRY)).toBeUndefined();
  });

  test("a resolvable pattern, an unset tier, and a non-pipeline agent are all silent", () => {
    expect(unresolvableTier("builder", MODELS, REGISTRY)).toBeUndefined();
    expect(unresolvableTier("builder", parseDevStageModels("{}"), REGISTRY)).toBeUndefined();
    expect(unresolvableTier("scout", parseDevStageModels('{"designModel": "nope/nope"}'), REGISTRY)).toBeUndefined();
  });

  // No snapshot is not evidence of a bad model. Refusing on an empty registry
  // would make every session that cannot read one unable to spawn at all.
  test("an empty registry snapshot reports nothing", () => {
    const stale = parseDevStageModels('{"designModel": "kimi-k3:high"}');
    expect(unresolvableTier("reviewer", stale, [])).toBeUndefined();
  });
});
