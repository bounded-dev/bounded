import { describe, expect, test } from "bun:test";
import { type AfterToolReport, AgentRunFinished, type Composition, contribution, corePack, defineConfig, type EffectJSON, Ports, ToolResult, ToolUse, type Verdict } from "bounded/domain";
import type { PrerequisiteRuleJSON } from "../../domain/prerequisite-rule.contract.ts";
import { prereqs } from "../../prereqs.pack.ts";
import { CheckPrerequisitesHandler } from "./check-prerequisites.handler.ts";
import { checkBeforeTool, recordAfterTool } from "./check-prerequisites.lifecycle.ts";
import { InMemoryFileSetFingerprints } from "./check-prerequisites.in-memory-file-set-fingerprints.test-support.ts";
import { InMemoryPrerequisiteRecords } from "./check-prerequisites.in-memory-prerequisite-records.test-support.ts";
import { callIdOf } from "./check-prerequisites.prerequisite-records.test-support.ts";

const PLAN = ".agent-state/prereqs/plan.md";
const beforeSrc: PrerequisiteRuleJSON = { before: { write: "src/**" }, require: { delegate: "plan-reviewer", succeeded: true }, unchangedSince: [".agent-state/*/plan.md"], redirect: "Have plan-reviewer review the current plan before editing src/" };
const beforeBuilder: PrerequisiteRuleJSON = { before: { delegate: "builder" }, require: { delegate: "plan-reviewer", succeeded: true }, unchangedSince: [".agent-state/*/plan.md"], redirect: "Have plan-reviewer review the current plan" };

/** The project's rules composed, as bounded.config.ts would contribute them. */
function composed(rules: readonly PrerequisiteRuleJSON[]): Composition {
  const config = defineConfig({ packs: [corePack, prereqs], contributes: [contribution(prereqs.points.rules, rules)] });
  const composition = config.compose();
  if (!composition.ok) throw new Error(composition.error);
  return composition.value;
}

function setup(rules: readonly PrerequisiteRuleJSON[] = [beforeSrc], files: Readonly<Record<string, string>> = { [PLAN]: "plan v1\n", "src/a.ts": "" }) {
  const fingerprints = new InMemoryFileSetFingerprints(files);
  const records = new InMemoryPrerequisiteRecords();
  return { fingerprints, records, handler: new CheckPrerequisitesHandler(composed(rules), fingerprints, records) };
}

function use(tool: "subagent" | "edit" | "read" | "shell",effects: readonly EffectJSON[], callId?: string): ToolUse {
  const parsed = ToolUse.parse({ kind: "tool-use", role: null, tool, effects, ...(callId === undefined ? {} : { callId }) });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}
const delegation = (agent: string, callId: string | null = "c1", flags: { isolated?: true; finishUnreported?: true } = {}): ToolUse => use("subagent", [{ kind: "delegate", agent, ...flags }], callId ?? undefined);
const writeTo = (path: string): ToolUse => use("edit", [{ kind: "write", path, change: "modify" }], "w1");

/**
 * The result of `call`: whether it succeeded, and for each delegate effect whether its run finished (undefined: not said).
 * A finished run names the agent the host ran as the one requested, as Claude Code reports an exact request (ADR 2026-025).
 */
function resultOf(call: ToolUse, ok: boolean, finished?: readonly boolean[]): ToolResult {
  const agents = call.effects.flatMap((effect) => (effect.kind === "delegate" ? [effect.agent.value] : []));
  const runs = finished?.map((done, index) => (done ? { finished: done, resolvedAgent: agents[index] ?? "" } : { finished: done }));
  const parsed = ToolResult.parse({ ...call.toJSON(), kind: "tool-result", ok, ...(runs === undefined ? {} : { delegatedAgentRuns: runs }) });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

const reasonOf = (verdict: Verdict): string => (verdict.kind === "refuse" ? verdict.reason : "allowed");
const redirectOf = (verdict: Verdict): string => (verdict.kind === "refuse" ? verdict.redirect : "allowed");

/** Delegates to `agent` and reports its result: the report afterTool gives. */
async function run(handler: CheckPrerequisitesHandler, agent = "plan-reviewer", callId = "c1", ok = true, finished: readonly boolean[] | undefined = [true]): Promise<AfterToolReport> {
  const call = delegation(agent, callId);
  expect(reasonOf(await handler.before(call))).toBe("allowed");
  return handler.after(resultOf(call, ok, finished));
}

describe("CheckPrerequisites — an action needs a delegation to have succeeded over unchanged files", () => {
  test("a write a rule comes before is refused until the required delegation has succeeded", async () => {
    const { handler } = setup();
    const verdict = await handler.before(writeTo("src/a.ts"));
    expect(reasonOf(verdict)).toStartWith("bounded/prereqs.rules:");
    expect(reasonOf(verdict)).toContain("bounded/project");
    expect(reasonOf(verdict)).toContain("before write 'src/**'");
    expect(reasonOf(verdict)).toContain("plan-reviewer");
    expect(reasonOf(verdict)).toContain("has not succeeded");
    expect(redirectOf(verdict)).toBe(beforeSrc.redirect);
  });

  test("a run the result says finished, over unchanged files, counts", async () => {
    const { handler, records } = setup();
    const report = await run(handler);
    expect(report.record?.verdict.kind).toBe("allow");
    expect(report.record?.note).toContain("plan-reviewer");
    expect(records.records).toHaveLength(1);
    expect((await handler.before(writeTo("src/a.ts"))).kind).toBe("allow");
  });

  test("a result from a host that never reports a run's finish says so plainly, without asking for a re-run, and records nothing", async () => {
    // As pi gives it: no subagent run is ever reported finished.
    const { handler, records } = setup();
    const call = delegation("plan-reviewer");
    expect((await handler.before(call)).kind).toBe("allow");
    const parsed = ToolResult.parse({ ...call.toJSON(), kind: "tool-result", ok: true, delegatedAgentRuns: [{ finished: false, finishNeverReported: true }] });
    if (!parsed.ok) throw new Error(parsed.error);
    const report = await handler.after(parsed.value);
    expect(report.message).toBe("bounded/prereqs.rules: this host does not report when plan-reviewer finishes, so plan-reviewer's run cannot meet this requirement yet; nothing is recorded");
    expect(report.message).not.toContain("run plan-reviewer");
    expect(records.records).toEqual([]);
    expect((await handler.before(writeTo("src/a.ts"))).kind).toBe("refuse");
  });

  test("a failed delegation records nothing", async () => {
    const { handler, records } = setup();
    const report = await run(handler, "plan-reviewer", "c1", false, [true]);
    expect(report.message).toContain("did not succeed");
    expect(records.records).toEqual([]);
    expect(reasonOf(await handler.before(writeTo("src/a.ts")))).toContain("has not succeeded");
  });

  test("a change to the files makes the requirement stale", async () => {
    const { handler, fingerprints } = setup();
    await run(handler);
    fingerprints.files.set(PLAN, "plan v2\n");
    const verdict = await handler.before(writeTo("src/a.ts"));
    expect(reasonOf(verdict)).toContain("changed since");
    expect(redirectOf(verdict)).toBe(beforeSrc.redirect);
    // A new matching file changes them too.
    fingerprints.files.set(PLAN, "plan v1\n");
    fingerprints.files.set(".agent-state/other/plan.md", "another plan\n");
    expect(reasonOf(await handler.before(writeTo("src/a.ts")))).toContain("changed since");
  });

  test("putting the files back as reviewed holds again", async () => {
    const { handler, fingerprints } = setup();
    await run(handler);
    fingerprints.files.set(PLAN, "plan v2\n");
    expect((await handler.before(writeTo("src/a.ts"))).kind).toBe("refuse");
    fingerprints.files.set(PLAN, "plan v1\n");
    expect((await handler.before(writeTo("src/a.ts"))).kind).toBe("allow");
  });

  test("files changed during the run: nothing is recorded, and the agent is told", async () => {
    const { handler, fingerprints, records } = setup();
    const call = delegation("plan-reviewer");
    expect((await handler.before(call)).kind).toBe("allow");
    fingerprints.files.set(PLAN, "plan edited during the review\n");
    const report = await handler.after(resultOf(call, true, [true]));
    expect(report.message).toContain("changed while plan-reviewer ran");
    expect(records.records).toEqual([]);
    expect((await handler.before(writeTo("src/a.ts"))).kind).toBe("refuse");
  });

  test("a requirement over files that match nothing is never satisfied, at the delegation and at the result", async () => {
    const { handler } = setup([{ ...beforeSrc, unchangedSince: ["missing/**"] }]);
    const atDelegation = await handler.before(delegation("plan-reviewer"));
    expect(reasonOf(atDelegation)).toContain("match no file");
    expect(reasonOf(await handler.before(writeTo("src/a.ts")))).toContain("match no file");

    const late = setup();
    const call = delegation("plan-reviewer");
    expect((await late.handler.before(call)).kind).toBe("allow");
    late.fingerprints.files.delete(PLAN);
    const report = await late.handler.after(resultOf(call, true, [true]));
    expect(report.message).toContain("match no file");
    expect(late.records.records).toEqual([]);
  });

  test("an isolated delegation of a required agent is refused", async () => {
    const { handler } = setup();
    const verdict = await handler.before(delegation("plan-reviewer", "c1", { isolated: true }));
    expect(reasonOf(verdict)).toStartWith("bounded/prereqs.rules:");
    expect(redirectOf(verdict)).toContain("without isolation");
    expect(redirectOf(verdict)).toBe("Run plan-reviewer without isolation, on the project's own files");
  });

  test("a delegation of a required agent whose finish is unreported is refused", async () => {
    const { handler } = setup();
    const verdict = await handler.before(delegation("plan-reviewer", "c1", { finishUnreported: true }));
    expect(reasonOf(verdict)).toStartWith("bounded/prereqs.rules:");
    expect(redirectOf(verdict)).toContain("whose finish the host reports");
    expect(redirectOf(verdict)).toBe("Run plan-reviewer as a run whose finish the host reports (not as a teammate or an asynchronous run)");
  });

  test("a delegation of a required agent without a call id is refused", async () => {
    const { handler } = setup();
    const verdict = await handler.before(delegation("plan-reviewer", null));
    expect(reasonOf(verdict)).toStartWith("bounded/prereqs.rules:");
    expect(reasonOf(verdict)).toContain("call id");
  });

  test("a result for an isolated delegation, or one whose finish is unreported, records nothing even when the host says it finished", async () => {
    for (const flags of [{ isolated: true as const }, { finishUnreported: true as const }]) {
      const { handler, records } = setup();
      // A start kept as for an ordinary delegation, as if before() had been bypassed.
      expect((await handler.before(delegation("plan-reviewer"))).kind).toBe("allow");
      const report = await handler.after(resultOf(delegation("plan-reviewer", "c1", flags), true, [true]));
      expect(report.message).toContain("plan-reviewer's run was not seen to finish");
      expect(records.records).toEqual([]);
      expect((await handler.before(writeTo("src/a.ts"))).kind).toBe("refuse");
    }
  });

  test("a delegation result without a call id records nothing, says so and is recorded as a refusal", async () => {
    const { handler, records } = setup();
    const report = await handler.after(resultOf(delegation("plan-reviewer", null), true, [true]));
    expect(report.message).toContain("has no call id");
    expect(report.record?.verdict.kind).toBe("refuse");
    expect(records.records).toEqual([]);
    expect(records.calls).toBe(0);
  });

  test("a result whose start is missing records nothing, and says so", async () => {
    const { handler, records } = setup();
    const report = await handler.after(resultOf(delegation("plan-reviewer"), true, [true]));
    expect(report.message).toContain("no start was kept");
    expect(records.records).toEqual([]);
    expect((await handler.before(writeTo("src/a.ts"))).kind).toBe("refuse");
  });

  test("a tampered start records nothing and says so", async () => {
    const { handler, records } = setup();
    const call = delegation("plan-reviewer");
    expect((await handler.before(call)).kind).toBe("allow");
    records.startedByCall.set("c1", [{ delegate: "plan-reviewer", unchangedSince: [".agent-state/*/plan.md"], fingerprint: { sha256: "forged", fileCount: 1 } }]);
    const report = await handler.after(resultOf(call, true, [true]));
    expect(report.message).toContain("altered");
    expect(report.record?.verdict.kind).toBe("refuse");
    expect(records.records).toEqual([]);
    expect((await handler.before(writeTo("src/a.ts"))).kind).toBe("refuse");
  });

  test("a start for another requirement set does not count", async () => {
    const { handler, records, fingerprints } = setup();
    const call = delegation("plan-reviewer");
    expect((await handler.before(call)).kind).toBe("allow");
    const other = await fingerprints.fingerprint(["src/**"]);
    records.startedByCall.set("c1", [{ delegate: "plan-reviewer", unchangedSince: ["src/**"], fingerprint: other.ok ? other.value : null }]);
    const report = await handler.after(resultOf(call, true, [true]));
    expect(report.message).toContain("no start was kept");
    expect(records.records).toEqual([]);
    expect((await handler.before(writeTo("src/a.ts"))).kind).toBe("refuse");
  });

  test("a fingerprint that cannot be computed refuses, naming the cause", async () => {
    const { handler, fingerprints } = setup();
    fingerprints.failure = "the disk is unreadable";
    const verdict = await handler.before(writeTo("src/a.ts"));
    expect(reasonOf(verdict)).toStartWith("bounded/prereqs.rules:");
    expect(reasonOf(verdict)).toContain("the disk is unreadable");
    expect(reasonOf(await handler.before(delegation("plan-reviewer")))).toContain("the disk is unreadable");
  });

  test("records that cannot be read refuse", async () => {
    const { handler, records } = setup();
    records.readFailure = "the records are locked";
    const verdict = await handler.before(writeTo("src/a.ts"));
    expect(reasonOf(verdict)).toStartWith("bounded/prereqs.rules:");
    expect(reasonOf(verdict)).toContain("the records are locked");
  });

  test("a record that cannot be written is told to the agent and recorded as a refusal", async () => {
    const { handler, records } = setup();
    const call = delegation("plan-reviewer");
    expect((await handler.before(call)).kind).toBe("allow");
    records.appendFailure = "the disk is full";
    const report = await handler.after(resultOf(call, true, [true]));
    expect(report.message).toContain("the disk is full");
    expect(report.record?.verdict.kind).toBe("refuse");
    expect((await handler.before(writeTo("src/a.ts"))).kind).toBe("refuse");
  });

  test("calls no rule concerns pass without touching the ports", async () => {
    const { handler, fingerprints, records } = setup([beforeSrc, beforeBuilder]);
    const calls = [use("read", [{ kind: "read", path: "src/a.ts" }], "r1"), writeTo("docs/a.md"), delegation("explore", "e1"), delegation("explore", null, { isolated: true })];
    for (const call of calls) {
      expect((await handler.before(call)).kind).toBe("allow");
      expect(await handler.after(resultOf(call, true, call.effects.some((effect) => effect.kind === "delegate") ? [false] : undefined))).toEqual({ message: null, record: null });
    }
    expect(fingerprints.calls).toBe(0);
    expect(records.calls).toBe(0);
  });

  test("rules with the same requirement share records", async () => {
    const { handler } = setup([beforeSrc, beforeBuilder]);
    expect((await handler.before(delegation("builder", "b0"))).kind).toBe("refuse");
    await run(handler);
    expect((await handler.before(writeTo("src/a.ts"))).kind).toBe("allow");
    expect((await handler.before(delegation("builder", "b1"))).kind).toBe("allow");
  });

  test("the first refusing rule, in contribution order, wins", async () => {
    const specFirst: PrerequisiteRuleJSON = { before: { write: "src/**" }, require: { delegate: "spec-reviewer", succeeded: true }, unchangedSince: ["spec.md"], redirect: "Have spec-reviewer review the spec" };
    const files = { [PLAN]: "plan v1\n", "spec.md": "spec\n" };
    expect(redirectOf(await setup([beforeSrc, specFirst], files).handler.before(writeTo("src/a.ts")))).toBe(beforeSrc.redirect);
    expect(redirectOf(await setup([specFirst, beforeSrc], files).handler.before(writeTo("src/a.ts")))).toBe(specFirst.redirect);
    // With the first met, the second refuses.
    const { handler } = setup([beforeSrc, specFirst], files);
    await run(handler);
    expect(redirectOf(await handler.before(writeTo("src/a.ts")))).toBe(specFirst.redirect);
  });

  test("in a pi call delegating to two agents, only the run said finished counts", async () => {
    const byA: PrerequisiteRuleJSON = { before: { write: "a-zone/**" }, require: { delegate: "a", succeeded: true }, unchangedSince: ["spec.md"], redirect: "Run a" };
    const byB: PrerequisiteRuleJSON = { before: { write: "b-zone/**" }, require: { delegate: "b", succeeded: true }, unchangedSince: ["spec.md"], redirect: "Run b" };
    const { handler, records } = setup([byA, byB], { "spec.md": "spec\n" });
    const call = use("subagent", [{ kind: "delegate", agent: "a" }, { kind: "delegate", agent: "b" }], "p1");
    expect((await handler.before(call)).kind).toBe("allow");
    const report = await handler.after(resultOf(call, true, [true, false]));
    expect(report.message).toContain("b's run was not seen to finish");
    expect(records.records).toHaveLength(1);
    expect((await handler.before(writeTo("a-zone/x.ts"))).kind).toBe("allow");
    expect(redirectOf(await handler.before(writeTo("b-zone/x.ts")))).toBe("Run b");
  });
});

/** The result of `call`, with what the host says of each delegated run as given. */
function resultWith(call: ToolUse, ok: boolean, delegatedAgentRuns: readonly object[]): ToolResult {
  const parsed = ToolResult.parse({ ...call.toJSON(), kind: "tool-result", ok, delegatedAgentRuns });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}
/** A background launch's entry: the run goes on, and its finish is reported later, as run `agentRunId`. */
const launch = (agentRunId = "a1") => ({ finished: false, agentRunId, finishReportedLater: true });
/** An agent run's finish, as the host reports it. */
function finishOf(agent: string, ranToEnd: boolean | null = null, agentRunId = "a1"): AgentRunFinished {
  const parsed = AgentRunFinished.parse({ role: null, agent, agentRunId, ranToEnd });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}
const UNREADABLE_RECORDS = "Fix what stops bounded/prereqs's records from being read; until then actions that need a prerequisite are refused";
const NO_LATER_FINISH = "bounded/prereqs.rules: plan-reviewer's run was not seen to finish, and the host will not report a later finish (as for a run stopped at its turn limit), so it is not recorded; run plan-reviewer again, to its end";

/** Delegates to `agent` as call `callId` and reports its launch: the run goes on, and its start moves to run `agentRunId`. */
async function launched(handler: CheckPrerequisitesHandler, agent = "plan-reviewer", agentRunId = "a1", callId = "c1"): Promise<AfterToolReport> {
  const call = delegation(agent, callId);
  expect(reasonOf(await handler.before(call))).toBe("allowed");
  return handler.after(resultWith(call, true, [launch(agentRunId)]));
}

describe("check-prerequisites — the resolved agent and runs that finish after their result (ADR 2026-025)", () => {
  test("a requested spelling that resolves to the required agent counts", async () => {
    const { handler, records } = setup();
    const call = delegation("Plan-Reviewer");
    expect((await handler.before(call)).kind).toBe("allow");
    const report = await handler.after(resultWith(call, true, [{ finished: true, agentRunId: "a1", resolvedAgent: "plan-reviewer" }]));
    expect(report.record?.verdict.kind).toBe("allow");
    expect(records.records).toHaveLength(1);
    expect(records.records[0]).toMatchObject({ delegate: "plan-reviewer", callId: "c1" });
    expect((await handler.before(writeTo("src/a.ts"))).kind).toBe("allow");
  });

  test("a run resolved to a name other than the required agent, even in case only, records nothing, and says so", async () => {
    const { handler, records } = setup();
    const call = delegation("plan-reviewer");
    expect((await handler.before(call)).kind).toBe("allow");
    const report = await handler.after(resultWith(call, true, [{ finished: true, agentRunId: "a1", resolvedAgent: "Plan-Reviewer" }]));
    expect(report.message).toBe("bounded/prereqs.rules: plan-reviewer ran as Plan-Reviewer, not plan-reviewer, so it is not recorded for '.agent-state/*/plan.md'");
    expect(records.records).toEqual([]);
    expect((await handler.before(writeTo("src/a.ts"))).kind).toBe("refuse");
  });

  test("a finished run whose host does not say which agent ran records nothing, and says so", async () => {
    const { handler, records } = setup();
    const call = delegation("plan-reviewer");
    expect((await handler.before(call)).kind).toBe("allow");
    const report = await handler.after(resultWith(call, true, [{ finished: true, agentRunId: "a1" }]));
    expect(report.message).toBe("bounded/prereqs.rules: the host did not say which agent plan-reviewer's run resolved to, so it is not recorded");
    expect(records.records).toEqual([]);
    expect((await handler.before(writeTo("src/a.ts"))).kind).toBe("refuse");
  });

  test("a candidate delegation is refused at the call when it is isolated, as an exact one is", async () => {
    const { handler, records } = setup();
    const isolated = await handler.before(delegation("PLAN-REVIEWER", "c1", { isolated: true }));
    expect(reasonOf(isolated)).toStartWith("bounded/prereqs.rules:");
    expect(redirectOf(isolated)).toBe("Run PLAN-REVIEWER without isolation, on the project's own files");
    expect(redirectOf(await handler.before(delegation("Plan-Reviewer", "c2", { finishUnreported: true })))).toBe("Run Plan-Reviewer as a run whose finish the host reports (not as a teammate or an asynchronous run)");
    expect(reasonOf(await handler.before(delegation(" plan-reviewer ", null)))).toContain("call id");
    expect(records.startedByCall.size).toBe(0);
  });

  test("a launch result whose run's finish is reported later moves its start to the run, and says nothing", async () => {
    const { handler, records } = setup();
    expect(await launched(handler)).toEqual({ message: null, record: null });
    expect(await records.takeStartedForCall(callIdOf("c1"))).toBeUndefined();
    const runs = await records.readStartedForRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ agentRunId: "a1", callId: "c1", startedAt: records.now });
    expect(records.records).toEqual([]);
  });

  test("a failed launch result keeps nothing for its run", async () => {
    const { handler, records } = setup();
    const call = delegation("plan-reviewer");
    expect((await handler.before(call)).kind).toBe("allow");
    const report = await handler.after(resultWith(call, false, [launch()]));
    expect(report.message).toContain("plan-reviewer's run did not succeed");
    expect(await records.readStartedForRuns()).toEqual([]);
  });

  test("while the run goes on, an action its rule comes before is refused as pending, saying when it started", async () => {
    const { handler, records } = setup();
    await launched(handler);
    const verdict = await handler.before(writeTo("src/a.ts"));
    expect(reasonOf(verdict)).toStartWith("bounded/prereqs.rules: bounded/project's rule before write 'src/**'");
    expect(reasonOf(verdict)).toContain(`plan-reviewer's run started at ${records.now} has not finished yet: wait for its finish`);
    expect(reasonOf(verdict)).toContain("This call would write (modify) src/a.ts");
    expect(redirectOf(verdict)).toBe(`Wait for plan-reviewer's run started at ${records.now} to finish (it is recorded when it does); if it stopped without finishing, ${beforeSrc.redirect}`);
  });

  test("a pending run never allows; over files changed since its launch the action is refused as not succeeded", async () => {
    const { handler, fingerprints } = setup();
    await launched(handler);
    expect((await handler.before(writeTo("src/a.ts"))).kind).toBe("refuse");
    fingerprints.files.set(PLAN, "plan v2\n");
    const verdict = await handler.before(writeTo("src/a.ts"));
    expect(verdict.kind).toBe("refuse");
    expect(reasonOf(verdict)).toContain("has not succeeded");
  });

  test("the run's finish, as the required agent over unchanged files, records it, and the action is then allowed", async () => {
    const { handler, records } = setup();
    await launched(handler);
    const report = await handler.recordAgentRunFinish(finishOf("plan-reviewer"));
    expect(report.record?.verdict.kind).toBe("allow");
    expect(report.record?.note).toBe("plan-reviewer's run a1 recorded as a prerequisite over '.agent-state/*/plan.md'");
    expect(await records.readAll()).toEqual([expect.objectContaining({ delegate: "plan-reviewer", callId: "c1" })]);
    expect(await records.readStartedForRuns()).toEqual([]);
    expect((await handler.before(writeTo("src/a.ts"))).kind).toBe("allow");
  });

  test("a requested spelling that resolves to the required agent counts at its finish too", async () => {
    const { handler, records } = setup();
    await launched(handler, "Plan-Reviewer");
    expect((await handler.recordAgentRunFinish(finishOf("plan-reviewer"))).record?.verdict.kind).toBe("allow");
    expect(records.records).toHaveLength(1);
    expect((await handler.before(writeTo("src/a.ts"))).kind).toBe("allow");
  });

  test("a finish naming another agent than the requirement's, even in case only, records nothing, and the refusal says so", async () => {
    for (const agent of ["Plan-Reviewer", "builder"]) {
      const { handler, records } = setup();
      await launched(handler);
      const report = await handler.recordAgentRunFinish(finishOf(agent));
      expect(report.record?.verdict.kind).toBe("refuse");
      const reason = report.record?.verdict.kind === "refuse" ? report.record.verdict.reason : "";
      expect(reason).toBe(`bounded/prereqs.rules: run a1 finished as ${agent}, not plan-reviewer, so it is not recorded for '.agent-state/*/plan.md'; run plan-reviewer again`);
      expect(records.records).toEqual([]);
      expect((await handler.before(writeTo("src/a.ts"))).kind).toBe("refuse");
    }
  });

  test("a finish that says the run did not run to its end records nothing, and the refusal says so", async () => {
    const { handler, records } = setup();
    await launched(handler);
    const report = await handler.recordAgentRunFinish(finishOf("plan-reviewer", false));
    expect(report.record?.verdict.kind === "refuse" && report.record.verdict.reason).toBe("bounded/prereqs.rules: plan-reviewer's run a1 did not run to its end, so it is not recorded; run plan-reviewer again");
    expect(records.records).toEqual([]);
    expect((await handler.before(writeTo("src/a.ts"))).kind).toBe("refuse");
  });

  test("a finish that says the run ran to its end counts, as one that does not say", async () => {
    const { handler, records } = setup();
    await launched(handler);
    expect((await handler.recordAgentRunFinish(finishOf("plan-reviewer", true))).record?.verdict.kind).toBe("allow");
    expect(records.records).toHaveLength(1);
    expect((await handler.before(writeTo("src/a.ts"))).kind).toBe("allow");
  });

  test("files changed while the run went on: its finish records nothing, and the refusal says so", async () => {
    const { handler, records, fingerprints } = setup();
    await launched(handler);
    fingerprints.files.set(PLAN, "plan edited during the review\n");
    const report = await handler.recordAgentRunFinish(finishOf("plan-reviewer"));
    expect(report.record?.verdict.kind === "refuse" && report.record.verdict.reason).toBe(
      "bounded/prereqs.rules: the files '.agent-state/*/plan.md' changed while plan-reviewer's run a1 ran, so it is not recorded; run plan-reviewer again over the files as they are",
    );
    expect(records.records).toEqual([]);
  });

  test("a finish for a run no start was kept for reports nothing", async () => {
    const { handler, records } = setup();
    expect(await handler.recordAgentRunFinish(finishOf("plan-reviewer"))).toEqual({ record: null });
    expect(records.records).toEqual([]);
  });

  test("a second finish for the same run reports nothing and records once", async () => {
    const { handler, records } = setup();
    await launched(handler);
    expect((await handler.recordAgentRunFinish(finishOf("plan-reviewer"))).record?.verdict.kind).toBe("allow");
    expect(await handler.recordAgentRunFinish(finishOf("plan-reviewer"))).toEqual({ record: null });
    expect(records.records).toHaveLength(1);
  });

  test("the foreground order: a finish before its completed result reports nothing, and the result records once", async () => {
    const { handler, records } = setup();
    const call = delegation("plan-reviewer");
    expect((await handler.before(call)).kind).toBe("allow");
    expect(await handler.recordAgentRunFinish(finishOf("plan-reviewer"))).toEqual({ record: null });
    const report = await handler.after(resultWith(call, true, [{ finished: true, agentRunId: "a1", resolvedAgent: "plan-reviewer" }]));
    expect(report.record?.verdict.kind).toBe("allow");
    expect(records.records).toHaveLength(1);
  });

  test("a run stopped at its turn limit keeps no run start, and is told that no later finish will be reported", async () => {
    const { handler, records } = setup();
    const call = delegation("plan-reviewer");
    expect((await handler.before(call)).kind).toBe("allow");
    const report = await handler.after(resultWith(call, true, [{ finished: false, agentRunId: "a1" }]));
    expect(report.message).toBe(NO_LATER_FINISH);
    expect(await records.readStartedForRuns()).toEqual([]);
    expect(records.records).toEqual([]);
  });

  test("a launch result with no start kept for its call keeps nothing for the run, and says so", async () => {
    const { handler, records } = setup();
    const report = await handler.after(resultWith(delegation("plan-reviewer"), true, [launch()]));
    expect(report.message).toContain("no start was kept for plan-reviewer's run");
    expect(await records.readStartedForRuns()).toEqual([]);
  });

  test("a run's start that cannot be kept is told and recorded as a refusal", async () => {
    const { handler, records } = setup();
    records.runSaveFailure = "the disk is full";
    const report = await launched(handler);
    const told = "bounded/prereqs.rules: the start of plan-reviewer's run could not be kept (the disk is full), so its finish cannot be recorded; run plan-reviewer again";
    expect(report.message).toBe(told);
    expect(report.record?.verdict.kind === "refuse" && report.record.verdict.reason).toBe(told);
  });

  test("a run's start that cannot be read, or was altered, records nothing at its finish, and the refusal says so", async () => {
    const unreadable = setup();
    await launched(unreadable.handler);
    unreadable.records.runTakeFailure = "the runs are locked";
    const locked = await unreadable.handler.recordAgentRunFinish(finishOf("plan-reviewer"));
    expect(locked.record?.verdict.kind === "refuse" && locked.record.verdict.reason).toBe(
      "bounded/prereqs.rules: the start kept for plan-reviewer's run a1 could not be read (the runs are locked), so it is not recorded; run plan-reviewer again",
    );
    const altered = setup();
    await launched(altered.handler);
    altered.records.startedByRun.set("a1", { agentRunId: "a1", callId: "c1", startedAt: altered.records.now, starts: [] });
    const report = await altered.handler.recordAgentRunFinish(finishOf("plan-reviewer"));
    const reason = report.record?.verdict.kind === "refuse" ? report.record.verdict.reason : "";
    expect(reason).toStartWith("bounded/prereqs.rules: the start kept for plan-reviewer's run a1 was altered (");
    expect(reason).toEndWith("), so it is not recorded; run plan-reviewer again");
    expect(altered.records.records).toEqual([]);
  });

  test("pending runs that cannot be read refuse the action, naming why", async () => {
    const { handler, records } = setup();
    records.runReadFailure = "the runs are locked";
    const verdict = await handler.before(writeTo("src/a.ts"));
    expect(reasonOf(verdict)).toBe("bounded/prereqs.rules: the runs still to finish could not be read: the runs are locked");
    expect(redirectOf(verdict)).toBe(UNREADABLE_RECORDS);
    records.runReadFailure = undefined;
    records.startedByRun.set("a9", { agentRunId: "a9", callId: "c9", startedAt: "never", starts: [] });
    expect(reasonOf(await handler.before(writeTo("src/a.ts")))).toStartWith("bounded/prereqs.rules: the runs still to finish could not be read: run 1 is not one: ");
  });

  test("a delegation result that does not say the run finished, nor that its finish is reported later, records nothing, and says no later finish will be reported", async () => {
    for (const finished of [undefined, [false]]) {
      const { handler, records } = setup();
      const call = delegation("plan-reviewer");
      expect((await handler.before(call)).kind).toBe("allow");
      const report = await handler.after(resultOf(call, true, finished));
      expect(report.message).toContain(NO_LATER_FINISH);
      expect(records.records).toEqual([]);
      expect(await records.readStartedForRuns()).toEqual([]);
      expect(reasonOf(await handler.before(writeTo("src/a.ts")))).toContain("has not succeeded");
    }
  });
});

const beforeApply: PrerequisiteRuleJSON = { before: { execute: "terraform apply" }, require: { delegate: "infra-reviewer", succeeded: true }, unchangedSince: ["infra/**"], redirect: "Have infra-reviewer review the current infra/ changes" };
const INFRA_FILES = { "infra/main.tf": "", [PLAN]: "plan v1\n", "src/a.ts": "" };
/** A word only the shell can resolve, as the reader reports it. */
const unresolvedWord = (text: string) => ({ kind: "unresolved" as const, text });
type Word = string | ReturnType<typeof unresolvedWord>;
const wordOf = (word: Word) => (typeof word === "string" ? { kind: "literal" as const, text: word } : word);
const ran = (name: Word, args: readonly Word[] = []) => ({ name: wordOf(name), arguments: args.map(wordOf), workingDirectory: "." });
type Part = { readonly text: string; readonly role: "read" | "list" | "write" | "directory" | "code" };
/** A shell call running `command`, read as running `programs`, writing `writes` and leaving `parts` unresolved. */
const shellCall = (command: string, programs: readonly ReturnType<typeof ran>[], writes: readonly string[] = [], parts: readonly Part[] = []): ToolUse =>
  use("shell", [{ kind: "execute", command, reading: { outcome: "read", programs, fileEffects: writes.map((path) => ({ effect: { kind: "write", path, change: "modify" } })), unresolved: parts } }], "x1");
const unreadCall = (command: string, why: string, cause?: "too-complex"): ToolUse => use("shell", [{ kind: "execute", command, reading: { outcome: "unread", why, ...(cause === undefined ? {} : { cause }) } }], "x1");
const runsApply = (action = "run 'terraform apply'") => ({
  readable: ` (or, if this command does not ${action}, write it so that bounded can read it: no words only the shell can resolve where a program, its leading arguments or a written path stand)`,
  reinstall: ` (or, if this command does not ${action}, reinstall bounded's dependencies if its shell parser cannot load, then retry)`,
  simplify: ` (or, if this command does not ${action}, split it into simpler commands, or simplify it, and run each on its own)`,
  insideProject: ` (or, if this command does not ${action}, leave out its writes outside the project)`,
});
const APPLY = runsApply();
const WRITE_SRC = runsApply("write a path 'src/**' matches");
const terraformApply = () => shellCall("terraform apply", [ran("terraform", ["apply"])]);
const tfApply = () => shellCall("$TF apply", [ran(unresolvedWord("$TF"), ["apply"])]);

describe("CheckPrerequisites — before an execute, and shell writes (ADR 2026-019, amended)", () => {
  test("a command that runs the rule's program and words is refused until the required delegation has succeeded, and allowed after", async () => {
    const { handler } = setup([beforeApply], INFRA_FILES);
    const call = shellCall("terraform apply -auto-approve", [ran("terraform", ["apply", "-auto-approve"])]);
    const verdict = await handler.before(call);
    expect(reasonOf(verdict)).toStartWith("bounded/prereqs.rules:");
    expect(reasonOf(verdict)).toContain("before executing 'terraform apply'");
    expect(reasonOf(verdict)).toContain("has not succeeded");
    expect(reasonOf(verdict)).toContain("This call would execute `terraform apply -auto-approve`, which runs 'terraform apply'");
    expect(redirectOf(verdict)).toBe(beforeApply.redirect);
    await run(handler, "infra-reviewer");
    expect(reasonOf(await handler.before(call))).toBe("allowed");
  });

  test("a shell command writing a path a write rule matches is refused as a file tool's write is, naming the write", async () => {
    const { handler } = setup([beforeSrc], INFRA_FILES);
    const verdict = await handler.before(shellCall("echo x > src/a.ts", [ran("echo", ["x"])], ["src/a.ts"]));
    expect(reasonOf(verdict)).toStartWith("bounded/prereqs.rules: bounded/project's rule before write 'src/**'");
    expect(reasonOf(verdict)).toEndWith("This call would execute `echo x > src/a.ts`, which writes 'src/a.ts'");
    expect(redirectOf(verdict)).toBe(beforeSrc.redirect);
  });

  test("a command bounded cannot see through is refused while the rule does not hold, saying it cannot see, why, and what would let it see", async () => {
    const { handler } = setup([beforeApply], INFRA_FILES);
    const cannotSee = "and bounded cannot see whether it runs 'terraform apply': ";
    const named = await handler.before(tfApply());
    expect(reasonOf(named)).toContain(`This call would execute \`$TF apply\`, ${cannotSee}it runs a program whose name only the shell can resolve ('$TF')`);
    expect(redirectOf(named)).toBe(`${beforeApply.redirect}${APPLY.readable}`);
    const input = await handler.before(shellCall("echo apply | xargs terraform", [ran("echo", ["apply"]), ran("xargs", ["terraform"]), ran("terraform", [unresolvedWord("(input)")])]));
    expect(reasonOf(input)).toContain(`${cannotSee}'(input)', which only the shell can resolve, stands before terraform's argument 'apply' could be found`);
    expect(redirectOf(input)).toBe(`${beforeApply.redirect}${APPLY.readable}`);
    const code = await handler.before(shellCall('sh -c "$X"', [ran("sh", ["-c", unresolvedWord('"$X"')])], [], [{ text: '"$X"', role: "code" }]));
    expect(reasonOf(code)).toContain(`${cannotSee}it runs code bounded cannot read ('"$X"')`);
    expect(redirectOf(code)).toBe(beforeApply.redirect);
    const passed = await handler.before(shellCall("echo terraform", [ran("echo", ["terraform"])]));
    expect(reasonOf(passed)).toContain(`${cannotSee}it passes 'terraform' to echo, which may run terraform`);
    expect(redirectOf(passed)).toBe(beforeApply.redirect);
  });

  test("an unread command's redirect follows its cause", async () => {
    const { handler } = setup([beforeApply], INFRA_FILES);
    const parser = await handler.before(unreadCall("terraform apply", "bounded's shell parser could not load (x)"));
    expect(reasonOf(parser)).toContain("This call would execute `terraform apply`, and bounded cannot see whether it runs 'terraform apply': the command could not be read (bounded's shell parser could not load (x))");
    expect(redirectOf(parser)).toBe(`${beforeApply.redirect}${APPLY.reinstall}`);
    const complex = await handler.before(unreadCall("terraform apply", "the command is too complex", "too-complex"));
    expect(redirectOf(complex)).toBe(`${beforeApply.redirect}${APPLY.simplify}`);
  });

  test("a write only the shell can name, or one bounded cannot place in the project, is refused under a write rule; the device paths are not", async () => {
    const { handler } = setup([beforeSrc], INFRA_FILES);
    const named = await handler.before(shellCall('echo x > "$OUT"', [ran("echo", ["x"])], [], [{ text: '"$OUT"', role: "write" }]));
    expect(reasonOf(named)).toContain("and bounded cannot see whether it writes a path 'src/**' matches: it writes a path only the shell can resolve ('\"$OUT\"')");
    expect(redirectOf(named)).toBe(`${beforeSrc.redirect}${WRITE_SRC.readable}`);
    const outside = await handler.before(shellCall("echo x > /tmp/x", [ran("echo", ["x"])], [], [{ text: "/tmp/x", role: "write" }]));
    expect(reasonOf(outside)).toContain("it writes a path bounded cannot place in the project ('/tmp/x')");
    expect(redirectOf(outside)).toBe(`${beforeSrc.redirect}${WRITE_SRC.insideProject}`);
    expect(reasonOf(await handler.before(shellCall("ls 2>/dev/null", [ran("ls")], [], [{ text: "/dev/null", role: "write" }])))).toBe("allowed");
    expect(reasonOf(await handler.before(shellCall("echo x > /dev/stderr", [ran("echo", ["x"])], [], [{ text: "/dev/stderr", role: "write" }])))).toBe("allowed");
  });

  test("a pending run's refusal keeps its head and redirect, with this item's tail", async () => {
    const { handler, records } = setup([beforeApply], INFRA_FILES);
    records.now = "2026-10-09T10:00:00.000Z";
    await launched(handler, "infra-reviewer");
    const head =
      "bounded/prereqs.rules: bounded/project's rule before executing 'terraform apply' requires a delegation to infra-reviewer that succeeded over the current 'infra/**', and infra-reviewer's run started at 2026-10-09T10:00:00.000Z has not finished yet: wait for its finish.";
    const wait = "Wait for infra-reviewer's run started at 2026-10-09T10:00:00.000Z to finish (it is recorded when it does); if it stopped without finishing, Have infra-reviewer review the current infra/ changes";
    const runs = await handler.before(terraformApply());
    expect(reasonOf(runs)).toBe(`${head} This call would execute \`terraform apply\`, which runs 'terraform apply'`);
    expect(redirectOf(runs)).toBe(wait);
    const unseen = await handler.before(tfApply());
    expect(reasonOf(unseen)).toBe(`${head} This call would execute \`$TF apply\`, and bounded cannot see whether it runs 'terraform apply': it runs a program whose name only the shell can resolve ('$TF')`);
    expect(redirectOf(unseen)).toBe(`${wait}${APPLY.readable}`);
  });

  test("once the rule holds, a command it cannot see through is allowed", async () => {
    const apply = setup([beforeApply], INFRA_FILES);
    await run(apply.handler, "infra-reviewer");
    for (const call of [tfApply(), shellCall("echo terraform", [ran("echo", ["terraform"])]), unreadCall("terraform apply", "the parser could not load")]) expect(reasonOf(await apply.handler.before(call))).toBe("allowed");
    const src = setup([beforeSrc], INFRA_FILES);
    await run(src.handler);
    expect(reasonOf(await src.handler.before(shellCall('echo x > "$OUT"', [ran("echo", ["x"])], [], [{ text: '"$OUT"', role: "write" }])))).toBe("allowed");
  });

  test("a command that neither runs the rule's program and words, passes it, nor writes a matching path is allowed, whatever the rule's state", async () => {
    const { handler, fingerprints, records } = setup([beforeApply, beforeSrc], INFRA_FILES);
    for (const call of [
      shellCall("terraform plan", [ran("terraform", ["plan"])]),
      shellCall("echo x > docs/a.md", [ran("echo", ["x"])], ["docs/a.md"]),
      shellCall('cat "$X"', [ran("cat", [unresolvedWord('"$X"')])], [], [{ text: '"$X"', role: "read" }]),
    ]) {
      expect(reasonOf(await handler.before(call))).toBe("allowed");
    }
    expect(fingerprints.calls).toBe(0);
    expect(records.calls).toBe(0);
  });

  test("rules are checked in contribution order across a call's effects and readings: the first that does not hold refuses", async () => {
    const both = () => shellCall("terraform apply && echo x > src/a.ts", [ran("terraform", ["apply"]), ran("echo", ["x"])], ["src/a.ts"]);
    const applyFirst = setup([beforeApply, beforeSrc], INFRA_FILES);
    expect(redirectOf(await applyFirst.handler.before(both()))).toBe(beforeApply.redirect);
    await run(applyFirst.handler, "infra-reviewer");
    expect(redirectOf(await applyFirst.handler.before(both()))).toBe(beforeSrc.redirect);
    await run(applyFirst.handler, "plan-reviewer", "c2");
    expect(reasonOf(await applyFirst.handler.before(both()))).toBe("allowed");
    expect(redirectOf(await setup([beforeSrc, beforeApply], INFRA_FILES).handler.before(both()))).toBe(beforeSrc.redirect);
  });

  test("without the pack's ports, a command a rule cannot see through is refused before the call, and its result records nothing", async () => {
    const ports = Ports.forProject("/work/project", []);
    if (!ports.ok) throw new Error(ports.error);
    const context = { composition: composed([beforeApply]), ports: ports.value };
    const verdict = await checkBeforeTool(tfApply(), context);
    expect(reasonOf(verdict)).toStartWith("bounded/prereqs.rules: prerequisites cannot be checked: ");
    expect(redirectOf(verdict)).toBe("Open the project with bounded/prereqs's ports (prereqsPortProvisions()); until then actions that need a prerequisite are refused");
    expect((await checkBeforeTool(shellCall("terraform plan", [ran("terraform", ["plan"])]), context)).kind).toBe("allow");
    expect(await recordAfterTool(resultOf(tfApply(), true), context)).toEqual({ message: null, record: null });
  });
});
