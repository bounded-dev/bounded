import { describe, expect, test } from "bun:test";
import { type AfterToolReport, AgentRunFinished, type Composition, contribution, corePack, defineConfig, type EffectJSON, Ports, ToolResult, ToolUse, type Verdict } from "bounded/domain";
import { FileSetFingerprint } from "../../domain/file-set-fingerprint.ts";
import type { PrerequisiteRuleJSON, PrerequisiteStatus } from "../../domain/prerequisite-rule.contract.ts";
import { PrerequisiteRule } from "../../domain/prerequisite-rule.ts";
import { prereqs } from "../../prereqs.pack.ts";
import { fileSetFingerprintsPort, type PrerequisiteStatusSnapshotJSON, prerequisiteRecordsPort, prerequisiteStatusSnapshotsPort } from "./check-prerequisites.contract.ts";
import { CheckPrerequisitesHandler } from "./check-prerequisites.handler.ts";
import { checkBeforeTool, recordAfterTool, recordRunAtFinish, writeStatusAfterTool, writeStatusAtFinish } from "./check-prerequisites.lifecycle.ts";
import { InMemoryFileSetFingerprints } from "./check-prerequisites.in-memory-file-set-fingerprints.test-support.ts";
import { InMemoryPrerequisiteRecords } from "./check-prerequisites.in-memory-prerequisite-records.test-support.ts";
import { InMemoryPrerequisiteStatusSnapshots } from "./check-prerequisites.in-memory-prerequisite-status-snapshots.test-support.ts";
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

function use(tool: "subagent" | "edit" | "read" | "shell", effects: readonly EffectJSON[], callId?: string): ToolUse {
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
    expect(redirectOf(verdict)).toBe("Run plan-reviewer as a new run whose finish the host reports");
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
    expect(redirectOf(await handler.before(delegation("Plan-Reviewer", "c2", { finishUnreported: true })))).toBe("Run Plan-Reviewer as a new run whose finish the host reports");
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

const beforeTestWriter: PrerequisiteRuleJSON = { before: { delegate: "test-writer" }, require: { delegate: "spec-reviewer", succeeded: true }, unchangedSince: ["spec.md", "src/**/*.contract.ts"], redirect: "Have spec-reviewer review the current spec and contracts" };
/** The four canonical rules, as prereqs.pack.test.ts lists them: three requirements, the first named twice. */
const CANONICAL: readonly PrerequisiteRuleJSON[] = [beforeBuilder, beforeSrc, beforeTestWriter, { ...beforeApply }];
const CANONICAL_FILES = { [PLAN]: "plan v1\n", "spec.md": "spec v1\n", "src/a.contract.ts": "export {};\n", "infra/main.tf": "", "src/a.ts": "" };
type ReadSnapshotJSON = Extract<PrerequisiteStatusSnapshotJSON, { readonly outcome: "read" }>;

/** The key of the requirement `rule` needs, as the rule gives it. */
function keyOf(rule: PrerequisiteRuleJSON): string {
  const parsed = PrerequisiteRule.parse(rule);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value.requirementKey();
}

/** Writes the status snapshot to `snapshots` and gives the last one saved, as its wire form. */
async function snapshotOf(handler: CheckPrerequisitesHandler, snapshots = new InMemoryPrerequisiteStatusSnapshots()): Promise<PrerequisiteStatusSnapshotJSON | undefined> {
  await handler.writeStatusSnapshot(snapshots, { withinMs: 2000 });
  return snapshots.saved.at(-1)?.toJSON();
}

/** The snapshot written now, which must be read; a test failure when it is not. */
async function readSnapshot(handler: CheckPrerequisitesHandler): Promise<ReadSnapshotJSON> {
  const snapshot = await snapshotOf(handler);
  if (snapshot?.outcome !== "read") throw new Error(`the snapshot is not read: ${JSON.stringify(snapshot)}`);
  return snapshot;
}

/** Why the snapshot written now is unread; a test failure when it is read. */
async function unreadWhy(handler: CheckPrerequisitesHandler): Promise<string> {
  const snapshot = await snapshotOf(handler);
  if (snapshot?.outcome !== "unread") throw new Error(`the snapshot is not unread: ${JSON.stringify(snapshot)}`);
  return snapshot.why;
}

/** How many files `patterns` match now, as their fingerprint counts them. */
async function filesMatched(fingerprints: InMemoryFileSetFingerprints, patterns: readonly string[]): Promise<number> {
  const given = await fingerprints.fingerprint(patterns);
  const fingerprint = given.ok ? FileSetFingerprint.parse(given.value) : given;
  if (!fingerprint.ok) throw new Error(fingerprint.error);
  return fingerprint.value.fileCount;
}

describe("check-prerequisites — the status snapshot (ADR 2026-026)", () => {
  test("each requirement once, in the order rules name it, with its status", async () => {
    const { handler, fingerprints } = setup(CANONICAL, CANONICAL_FILES);
    await run(handler);
    await run(handler, "spec-reviewer", "c2");
    fingerprints.files.set("spec.md", "spec v2\n");
    const snapshot = await readSnapshot(handler);
    expect(snapshot.format).toBe("bounded-prereqs-status/1");
    expect(snapshot.requirements).toEqual([
      { key: keyOf(beforeBuilder), requiredAgent: "plan-reviewer", unchangedSince: [".agent-state/*/plan.md"], status: "holds", filesMatched: await filesMatched(fingerprints, [".agent-state/*/plan.md"]), pendingRun: null },
      { key: keyOf(beforeTestWriter), requiredAgent: "spec-reviewer", unchangedSince: ["spec.md", "src/**/*.contract.ts"], status: "stale", filesMatched: await filesMatched(fingerprints, ["spec.md", "src/**/*.contract.ts"]), pendingRun: null },
      { key: keyOf(beforeApply), requiredAgent: "infra-reviewer", unchangedSince: ["infra/**"], status: "missing", filesMatched: await filesMatched(fingerprints, ["infra/**"]), pendingRun: null },
    ]);
    expect(snapshot.requirements.map((requirement) => requirement.filesMatched)).toEqual([1, 2, 1]);
    expect(snapshot.rules).toEqual(CANONICAL.map((rule) => ({ contributedBy: "bounded/project", before: rule.before, requirementKey: keyOf(rule), allows: rule.require.delegate === "plan-reviewer" })));
  });

  test("two rules with the same agent and patterns in another order share one requirement", async () => {
    const first: PrerequisiteRuleJSON = { ...beforeSrc, unchangedSince: ["spec.md", ".agent-state/*/plan.md"] };
    const second: PrerequisiteRuleJSON = { ...beforeBuilder, unchangedSince: [".agent-state/*/plan.md", "spec.md"] };
    const { handler } = setup([first, second], CANONICAL_FILES);
    const snapshot = await readSnapshot(handler);
    expect(snapshot.requirements).toHaveLength(1);
    expect(snapshot.requirements[0]?.unchangedSince).toEqual(["spec.md", ".agent-state/*/plan.md"]);
    expect(snapshot.rules.map((rule) => rule.requirementKey)).toEqual([keyOf(first), keyOf(first)]);
    expect(keyOf(second)).toBe(keyOf(first));
  });

  test("a run started and not finished reads pending, with its run and when it started", async () => {
    const { handler, records } = setup(CANONICAL, CANONICAL_FILES);
    records.now = "2026-10-09T10:00:00.000Z";
    await launched(handler, "plan-reviewer", "a6eef1505a0b443a2");
    const snapshot = await readSnapshot(handler);
    expect(snapshot.requirements[0]).toMatchObject({ requiredAgent: "plan-reviewer", status: "pending", pendingRun: { agentRunId: "a6eef1505a0b443a2", startedAt: "2026-10-09T10:00:00.000Z" } });
    expect(snapshot.requirements.slice(1).map((requirement) => [requirement.status, requirement.pendingRun])).toEqual([
      ["missing", null],
      ["missing", null],
    ]);
    expect(snapshot.rules.map((rule) => rule.allows)).toEqual([false, false, false, false]);
  });

  test("each rule's allows is what the gate decides, whatever the action's match kind", async () => {
    // For each rule in CANONICAL's order, actions it comes before, or cannot see through.
    const actionsOf = (): readonly (readonly ToolUse[])[] => [
      [delegation("builder", "b1")],
      [writeTo("src/a.ts"), shellCall("echo x > src/a.ts", [ran("echo", ["x"])], ["src/a.ts"]), shellCall('echo x > "$OUT"', [ran("echo", ["x"])], [], [{ text: '"$OUT"', role: "write" }])],
      [delegation("test-writer", "t1")],
      [terraformApply(), tfApply()],
    ];
    const reviewAll = async (handler: CheckPrerequisitesHandler) => {
      await run(handler, "plan-reviewer", "c1");
      await run(handler, "spec-reviewer", "c2");
      await run(handler, "infra-reviewer", "c3");
    };
    const scenarios: readonly [PrerequisiteStatus, (handler: CheckPrerequisitesHandler, fingerprints: InMemoryFileSetFingerprints) => Promise<void>][] = [
      ["missing", async () => {}],
      ["holds", reviewAll],
      [
        "stale",
        async (handler, fingerprints) => {
          await reviewAll(handler);
          for (const path of [PLAN, "spec.md", "infra/main.tf"]) fingerprints.files.set(path, "changed\n");
        },
      ],
      [
        "pending",
        async (handler) => {
          await launched(handler, "plan-reviewer", "a1", "c1");
          await launched(handler, "spec-reviewer", "a2", "c2");
          await launched(handler, "infra-reviewer", "a3", "c3");
        },
      ],
    ];
    for (const [status, arrange] of scenarios) {
      const { handler, fingerprints } = setup(CANONICAL, CANONICAL_FILES);
      await arrange(handler, fingerprints);
      const snapshot = await readSnapshot(handler);
      expect(snapshot.requirements.map((requirement) => requirement.status)).toEqual([status, status, status]);
      const actions = actionsOf();
      for (const [index, rule] of snapshot.rules.entries()) {
        for (const action of actions[index] ?? []) {
          const allowed = (await handler.before(action)).kind === "allow";
          expect({ status, rule: index, allowed }).toEqual({ status, rule: index, allowed: rule.allows });
        }
      }
    }
  });

  test("patterns that match no file read missing, with no file matched", async () => {
    const { handler } = setup([{ ...beforeSrc, unchangedSince: ["missing/**"] }], CANONICAL_FILES);
    const snapshot = await readSnapshot(handler);
    expect(snapshot.requirements).toEqual([{ key: keyOf({ ...beforeSrc, unchangedSince: ["missing/**"] }), requiredAgent: "plan-reviewer", unchangedSince: ["missing/**"], status: "missing", filesMatched: 0, pendingRun: null }]);
    expect(snapshot.rules.map((rule) => rule.allows)).toEqual([false]);
  });

  test("reading changes nothing kept: records and pending runs are read once each, and nothing is appended or saved", async () => {
    const { handler, records } = setup(CANONICAL, CANONICAL_FILES);
    await run(handler);
    await launched(handler, "spec-reviewer", "a2", "c2");
    expect((await handler.before(delegation("infra-reviewer", "c9"))).kind).toBe("allow");
    const kept = { records: await records.readAll(), runs: await records.readStartedForRuns(), calls: [...records.startedByCall.keys()] };
    const callsBefore = records.calls;
    await readSnapshot(handler);
    expect(records.calls - callsBefore).toBe(2);
    expect({ records: await records.readAll(), runs: await records.readStartedForRuns(), calls: [...records.startedByCall.keys()] }).toEqual(kept);
    expect(await records.takeStartedForCall(callIdOf("c9"))).toBeDefined();
  });

  test("the time is taken before the reading begins, and each requirement is fingerprinted once", async () => {
    const { handler, fingerprints, records } = setup(CANONICAL, CANONICAL_FILES);
    const snapshots = new InMemoryPrerequisiteStatusSnapshots();
    const before = [fingerprints.calls, records.calls];
    const atNow: number[] = [];
    snapshots.onNow = () => atNow.push(fingerprints.calls, records.calls);
    await handler.writeStatusSnapshot(snapshots, { withinMs: 2000 });
    expect(atNow).toEqual(before);
    expect(fingerprints.calls - (before[0] ?? 0)).toBe(3);
    expect(snapshots.saved).toHaveLength(1);
    expect(snapshots.saved[0]?.readingStartedAt.value).toBe("2026-10-10T12:00:00.000Z");
  });

  test("a reading that fails is saved unread, naming why", async () => {
    const lockedRecords = setup(CANONICAL, CANONICAL_FILES);
    lockedRecords.records.readFailure = "the records are locked";
    expect(await unreadWhy(lockedRecords.handler)).toBe("bounded/prereqs.rules: the prerequisites recorded so far could not be read: the records are locked");

    const lockedRuns = setup(CANONICAL, CANONICAL_FILES);
    lockedRuns.records.runReadFailure = "the runs are locked";
    expect(await unreadWhy(lockedRuns.handler)).toBe("bounded/prereqs.rules: the runs still to finish could not be read: the runs are locked");

    const unreadableFiles = setup(CANONICAL, CANONICAL_FILES);
    unreadableFiles.fingerprints.failure = "the disk is unreadable";
    expect(await unreadWhy(unreadableFiles.handler)).toBe(
      "bounded/prereqs.rules: the files of bounded/project's rule before delegating to 'builder' requires a delegation to plan-reviewer that succeeded over the current '.agent-state/*/plan.md' could not be fingerprinted: the disk is unreadable",
    );

    const tampered = setup(CANONICAL, CANONICAL_FILES);
    tampered.records.records.push({ delegate: "plan-reviewer" });
    expect(await unreadWhy(tampered.handler)).toStartWith("bounded/prereqs.rules: the prerequisites recorded so far could not be read: record 1 is not one: ");
  });

  test("pending runs are read only when a requirement does not hold by its records: unreadable, they do not stop a reading where every one holds", async () => {
    const { handler, records } = setup([beforeSrc]);
    await run(handler);
    records.runReadFailure = "the runs are locked";
    const snapshot = await readSnapshot(handler);
    expect(snapshot.requirements.map((requirement) => requirement.status)).toEqual(["holds"]);
  });

  test("a reading over its bound is saved unread, and the write still ends on time", async () => {
    const hanging = { fingerprint: () => new Promise<never>(() => {}) };
    const handler = new CheckPrerequisitesHandler(composed(CANONICAL), hanging, new InMemoryPrerequisiteRecords());
    const snapshots = new InMemoryPrerequisiteStatusSnapshots();
    const started = performance.now();
    await handler.writeStatusSnapshot(snapshots, { withinMs: 50 });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(45);
    expect(elapsed).toBeLessThan(50 + 500 + 250);
    expect(snapshots.saved.map((snapshot) => snapshot.toJSON())).toEqual([
      { format: "bounded-prereqs-status/1", outcome: "unread", readingStartedAt: "2026-10-10T12:00:00.000Z", why: "bounded/prereqs.rules: reading the status did not finish within 50 ms" },
    ]);
  });

  test("a save that never settles is abandoned at its bound; one that rejects is swallowed", async () => {
    const { handler } = setup(CANONICAL, CANONICAL_FILES);
    const hangs = new InMemoryPrerequisiteStatusSnapshots();
    hangs.saveHangs = true;
    const started = performance.now();
    await handler.writeStatusSnapshot(hangs, { withinMs: 2000 });
    expect(performance.now() - started).toBeLessThan(500 + 250);
    expect(hangs.saved).toHaveLength(1);
    const rejects = new InMemoryPrerequisiteStatusSnapshots();
    rejects.saveFailure = "the disk is full";
    expect(await handler.writeStatusSnapshot(rejects, { withinMs: 2000 })).toBeUndefined();
    expect(rejects.saved).toHaveLength(1);
    expect(rejects.kept).toBeUndefined();
  });

  test("a store time that does not parse saves nothing, and the write never rejects", async () => {
    const { handler, fingerprints } = setup(CANONICAL, CANONICAL_FILES);
    for (const time of ["yesterday", undefined, 5, "2026-10-10T12:00:00Z"]) {
      const snapshots = new InMemoryPrerequisiteStatusSnapshots();
      snapshots.time = time;
      expect(await handler.writeStatusSnapshot(snapshots, { withinMs: 2000 })).toBeUndefined();
      expect(snapshots.saved).toEqual([]);
    }
    const throwing = new InMemoryPrerequisiteStatusSnapshots();
    throwing.nowFailure = "no clock";
    expect(await handler.writeStatusSnapshot(throwing, { withinMs: 2000 })).toBeUndefined();
    expect(throwing.saved).toEqual([]);
    expect(fingerprints.calls).toBe(0);
  });
});

/** A lifecycle context over doubles: the pack's two ports, and the snapshot port when `withSnapshots`. */
function lifecycleWith(rules: readonly PrerequisiteRuleJSON[], files: Readonly<Record<string, string>>, ports: { readonly required?: boolean; readonly snapshots?: boolean } = {}) {
  const fingerprints = new InMemoryFileSetFingerprints(files);
  const records = new InMemoryPrerequisiteRecords();
  const snapshots = new InMemoryPrerequisiteStatusSnapshots();
  const provisions = [
    ...(ports.required === false ? [] : [Ports.provide(fileSetFingerprintsPort, () => fingerprints), Ports.provide(prerequisiteRecordsPort, () => records)]),
    ...(ports.snapshots === false ? [] : [Ports.provide(prerequisiteStatusSnapshotsPort, () => snapshots)]),
  ];
  const opened = Ports.forProject("/work/project", provisions);
  if (!opened.ok) throw new Error(opened.error);
  return { fingerprints, records, snapshots, context: { composition: composed(rules), ports: opened.value } };
}

/** The statuses of the snapshot kept, in its file form. */
function keptStatuses(snapshots: InMemoryPrerequisiteStatusSnapshots): unknown {
  const kept: unknown = snapshots.kept;
  const parsed = typeof kept === "object" && kept !== null && "requirements" in kept && Array.isArray(kept.requirements) ? kept.requirements : undefined;
  return parsed?.map((requirement: { readonly status?: unknown }) => requirement.status);
}

describe("check-prerequisites — the status snapshot's lifecycle checks (ADR 2026-026)", () => {
  test("after each tool call, once its records are made, the snapshot is written", async () => {
    const { snapshots, context } = lifecycleWith([beforeSrc], CANONICAL_FILES);
    const call = delegation("plan-reviewer");
    expect((await checkBeforeTool(call, context)).kind).toBe("allow");
    const result = resultOf(call, true, [true]);
    expect((await recordAfterTool(result, context)).record?.verdict.kind).toBe("allow");
    expect(await writeStatusAfterTool(result, context)).toEqual({ message: null, record: null });
    expect(keptStatuses(snapshots)).toEqual(["holds"]);
    expect(snapshots.kept).toMatchObject({ projectRoot: "/work/project", outcome: "read" });
  });

  test("after an agent run's finish, the snapshot is written", async () => {
    const { snapshots, context } = lifecycleWith([beforeSrc], CANONICAL_FILES);
    const call = delegation("plan-reviewer");
    expect((await checkBeforeTool(call, context)).kind).toBe("allow");
    const launchResult = resultWith(call, true, [launch()]);
    await recordAfterTool(launchResult, context);
    await writeStatusAfterTool(launchResult, context);
    expect(keptStatuses(snapshots)).toEqual(["pending"]);
    const finish = finishOf("plan-reviewer");
    expect((await recordRunAtFinish(finish, context)).record?.verdict.kind).toBe("allow");
    expect(await writeStatusAtFinish(finish, context)).toEqual({ record: null });
    expect(keptStatuses(snapshots)).toEqual(["holds"]);
  });

  test("the write checks tell nothing and record nothing, even when the pack's own ports are missing or the save fails", async () => {
    const result = resultOf(writeTo("docs/a.md"), true);
    const finish = finishOf("plan-reviewer");
    const withoutRequired = lifecycleWith([beforeSrc], CANONICAL_FILES, { required: false });
    expect(await writeStatusAfterTool(result, withoutRequired.context)).toEqual({ message: null, record: null });
    expect(await writeStatusAtFinish(finish, withoutRequired.context)).toEqual({ record: null });
    expect(withoutRequired.snapshots.kept).toMatchObject({ outcome: "unread" });
    const why: unknown = withoutRequired.snapshots.saved.at(-1)?.toJSON();
    expect(why).toMatchObject({ why: "bounded/prereqs.rules: prerequisites cannot be read: bounded/prereqs needs the port 'fileSetFingerprints', which this host does not provide: pass it to openProject({ ports })" });
    const failing = lifecycleWith([beforeSrc], CANONICAL_FILES);
    failing.snapshots.saveFailure = "the disk is full";
    expect(await writeStatusAfterTool(result, failing.context)).toEqual({ message: null, record: null });
    expect(await writeStatusAtFinish(finish, failing.context)).toEqual({ record: null });
  });

  test("without the snapshot port, the write checks touch no port", async () => {
    const { fingerprints, records, context } = lifecycleWith([beforeSrc], CANONICAL_FILES, { snapshots: false });
    expect(await writeStatusAfterTool(resultOf(writeTo("docs/a.md"), true), context)).toEqual({ message: null, record: null });
    expect(await writeStatusAtFinish(finishOf("plan-reviewer"), context)).toEqual({ record: null });
    expect(fingerprints.calls).toBe(0);
    expect(records.calls).toBe(0);
  });

  test("verdicts and records are the same with and without the snapshot port", async () => {
    const scenarios: readonly [string, (context: ReturnType<typeof lifecycleWith>) => Promise<void>][] = [
      ["missing", async () => {}],
      [
        "holds",
        async ({ context }) => {
          const call = delegation("plan-reviewer", "c1");
          await checkBeforeTool(call, context);
          const result = resultOf(call, true, [true]);
          await recordAfterTool(result, context);
          await writeStatusAfterTool(result, context);
        },
      ],
      [
        "stale",
        async ({ context, fingerprints }) => {
          const call = delegation("plan-reviewer", "c1");
          await checkBeforeTool(call, context);
          const result = resultOf(call, true, [true]);
          await recordAfterTool(result, context);
          await writeStatusAfterTool(result, context);
          fingerprints.files.set(PLAN, "plan v2\n");
        },
      ],
    ];
    for (const [status, arrange] of scenarios) {
      const outcomes: unknown[] = [];
      for (const snapshots of [true, false]) {
        const given = lifecycleWith([beforeSrc, beforeBuilder], CANONICAL_FILES, { snapshots });
        await arrange(given);
        const write = await checkBeforeTool(writeTo("src/a.ts"), given.context);
        const review = delegation("plan-reviewer", "c5");
        const delegated = await checkBeforeTool(review, given.context);
        const result = resultOf(review, true, [true]);
        const report = await recordAfterTool(result, given.context);
        await writeStatusAfterTool(result, given.context);
        if (snapshots) expect({ status, kept: keptStatuses(given.snapshots) }).toEqual({ status, kept: ["holds"] });
        outcomes.push(JSON.parse(JSON.stringify({ write, delegated, report })));
      }
      expect({ status, outcome: outcomes[0] }).toEqual({ status, outcome: outcomes[1] });
    }
  });
});
