import { describe, expect, test } from "bun:test";
import { type AfterToolReport, type Composition, contribution, corePack, defineConfig, type EffectJSON, ToolResult, ToolUse, type Verdict } from "bounded/domain";
import type { PrerequisiteRuleJSON } from "../../domain/prerequisite-rule.contract.ts";
import { prereqs } from "../../prereqs.pack.ts";
import { CheckPrerequisitesHandler } from "./check-prerequisites.handler.ts";
import { InMemoryFileSetFingerprints } from "./check-prerequisites.in-memory-file-set-fingerprints.test-support.ts";
import { InMemoryPrerequisiteRecords } from "./check-prerequisites.in-memory-prerequisite-records.test-support.ts";

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

function use(tool: "subagent" | "edit" | "read", effects: readonly EffectJSON[], callId?: string): ToolUse {
  const parsed = ToolUse.parse({ kind: "tool-use", role: null, tool, effects, ...(callId === undefined ? {} : { callId }) });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}
const delegation = (agent: string, callId: string | null = "c1", flags: { isolated?: true; finishUnreported?: true } = {}): ToolUse => use("subagent", [{ kind: "delegate", agent, ...flags }], callId ?? undefined);
const writeTo = (path: string): ToolUse => use("edit", [{ kind: "write", path, change: "modify" }], "w1");

/** The result of `call`: whether it succeeded, and for each delegate effect whether its run finished (undefined: not said). */
function resultOf(call: ToolUse, ok: boolean, finished?: readonly boolean[]): ToolResult {
  const parsed = ToolResult.parse({ ...call.toJSON(), kind: "tool-result", ok, ...(finished === undefined ? {} : { delegatedAgentRuns: finished.map((done) => ({ finished: done })) }) });
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

  test("a delegation result that does not say the run finished records nothing", async () => {
    for (const finished of [undefined, [false]]) {
      const { handler, records } = setup();
      const call = delegation("plan-reviewer");
      expect((await handler.before(call)).kind).toBe("allow");
      const report = await handler.after(resultOf(call, true, finished));
      expect(report.message).toContain("bounded/prereqs.rules: plan-reviewer's run was not seen to finish (it may still be running in the background), so it is not recorded; run plan-reviewer so that the host reports its finish");
      expect(records.records).toEqual([]);
      expect(reasonOf(await handler.before(writeTo("src/a.ts")))).toContain("has not succeeded");
    }
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
