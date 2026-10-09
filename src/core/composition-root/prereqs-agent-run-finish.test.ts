import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { protectedPathsPortProvisions } from "bounded/protected-paths/adapters";
import { prereqsPortProvisions } from "bounded/prereqs/adapters";
import { openProject } from "./open-project.ts";

const CORE = resolve(import.meta.dir, "../..");
process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "bounded-state-"));
const REDIRECT = "Have plan-reviewer review the current plan before editing src/";
const PREREQS = `import { contribution, corePack, defineConfig } from "bounded/domain";
import { prereqs } from "bounded/prereqs";
export default defineConfig({
  packs: [corePack, prereqs],
  contributes: [contribution(prereqs.points.rules, [{ before: { write: "src/**" }, require: { delegate: "plan-reviewer", succeeded: true }, unchangedSince: [".agent-state/*/plan.md"], redirect: "${REDIRECT}" }])],
});
`;
const CORE_ONLY = `import { corePack, defineConfig } from "bounded/domain";
export default defineConfig({ packs: [corePack] });
`;

/** A git project with `config`, a plan and a source file. */
function project(config: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bounded-prereqs-finish-")));
  mkdirSync(join(root, "node_modules"));
  symlinkSync(CORE, join(root, "node_modules", "bounded"), "dir");
  mkdirSync(join(root, ".agent-state", "item"), { recursive: true });
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, ".agent-state", "item", "plan.md"), "the plan\n");
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, ".gitignore"), "node_modules/\n.bounded/\n.agent-state/\n");
  writeFileSync(join(root, "bounded.config.ts"), config);
  spawnSync("git", ["init", "--quiet"], { cwd: root });
  return root;
}

const open = (root: string) => openProject(root, { ports: [...protectedPathsPortProvisions(), ...prereqsPortProvisions()] });
const writeSrc = { kind: "tool-use", role: "builder", tool: "edit", effects: [{ kind: "write", path: "src/a.ts", change: "modify" }], callId: "w1" };
const review = (callId: string, agent = "plan-reviewer") => ({ kind: "tool-use", role: null, tool: "subagent", effects: [{ kind: "delegate", agent }], callId });
/** A background launch's result: the run goes on, and its finish is reported later. */
const launched = (callId: string, agentRunId: string, agent = "plan-reviewer") => ({ ...review(callId, agent), kind: "tool-result", ok: true, delegatedAgentRuns: [{ finished: false, agentRunId, finishReportedLater: true }] });
/** A foreground run's result: finished, with the agent the host ran. */
const completed = (callId: string, agentRunId: string, agent = "plan-reviewer", resolvedAgent = "plan-reviewer") => ({
  ...review(callId, agent),
  kind: "tool-result",
  ok: true,
  delegatedAgentRuns: [{ finished: true, agentRunId, resolvedAgent }],
});
const finished = (agentRunId: string, agent = "plan-reviewer") => ({ kind: "agent-run-finished", role: null, agent, agentRunId, ranToEnd: null });
const log = (root: string): { event: string; tool: string | null; verdict: { kind: string }; note: string | null }[] =>
  existsSync(join(root, ".bounded", "log.jsonl"))
    ? readFileSync(join(root, ".bounded", "log.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line))
    : [];
const records = (root: string): unknown[] =>
  existsSync(join(root, ".bounded", "prereqs", "records.jsonl"))
    ? readFileSync(join(root, ".bounded", "prereqs", "records.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line))
    : [];

describe("bounded/prereqs end to end: runs that finish after their result (ADR 2026-025)", () => {
  test("the background path: launched, pending, finished, then allowed", async () => {
    const root = project(PREREQS);
    const { judge, afterTool, recordAgentRunFinish } = await open(root);
    expect((await judge(review("c1"))).kind).toBe("allow");
    expect((await afterTool(launched("c1", "a1"))).message).toBeNull();
    const pending = await judge(writeSrc);
    expect(pending.kind === "refuse" && pending.reason).toContain("started at");
    expect(pending.kind === "refuse" && pending.reason).toContain("wait for its finish");
    expect(pending.kind === "refuse" && pending.redirect).toContain(REDIRECT);
    expect(await recordAgentRunFinish(finished("a1"))).toBeUndefined();
    expect((await judge(writeSrc)).kind).toBe("allow");
    const finishLines = log(root).filter((line) => line.event === "agent-run-finished");
    expect(finishLines).toHaveLength(1);
    expect(finishLines[0]?.verdict.kind).toBe("allow");
    expect(finishLines[0]?.tool).toBeNull();
    expect(finishLines[0]?.note).toContain("plan-reviewer");
    expect(finishLines[0]?.note).toContain("a1");
    expect(records(root)).toHaveLength(1);
  });

  test("a requested spelling that resolves to the required agent counts, in the background and the foreground", async () => {
    const background = project(PREREQS);
    const later = await open(background);
    expect((await later.judge(review("c1", "Plan-Reviewer"))).kind).toBe("allow");
    expect((await later.afterTool(launched("c1", "a1", "Plan-Reviewer"))).message).toBeNull();
    await later.recordAgentRunFinish(finished("a1", "plan-reviewer"));
    expect((await later.judge(writeSrc)).kind).toBe("allow");

    const foreground = project(PREREQS);
    const now = await open(foreground);
    expect((await now.judge(review("c2", "Plan-Reviewer"))).kind).toBe("allow");
    await now.recordAgentRunFinish(finished("a2", "plan-reviewer"));
    expect((await now.afterTool(completed("c2", "a2", "Plan-Reviewer", "plan-reviewer"))).message).toBeNull();
    expect((await now.judge(writeSrc)).kind).toBe("allow");
  });

  test("the foreground order: a finish before the completed result records once, and writes no line of its own", async () => {
    const root = project(PREREQS);
    const { judge, afterTool, recordAgentRunFinish } = await open(root);
    expect((await judge(review("c1"))).kind).toBe("allow");
    await recordAgentRunFinish(finished("a1"));
    expect(log(root).filter((line) => line.event === "agent-run-finished")).toEqual([]);
    expect((await afterTool(completed("c1", "a1"))).message).toBeNull();
    expect(records(root)).toHaveLength(1);
    expect((await judge(writeSrc)).kind).toBe("allow");
    expect(log(root).map((line) => line.event)).toEqual(["tool-use", "tool-result", "tool-use"]);
  });

  test("a finish no pack contributes to writes nothing to the Bounded log", async () => {
    const root = project(CORE_ONLY);
    const { recordAgentRunFinish, problem } = await open(root);
    expect(problem).toBeNull();
    expect(await recordAgentRunFinish(finished("a1"))).toBeUndefined();
    expect(log(root)).toEqual([]);
  });

  test("an unreadable finish is recorded as invalid", async () => {
    const root = project(PREREQS);
    const { recordAgentRunFinish } = await open(root);
    expect(await recordAgentRunFinish({ kind: "agent-run-finished", role: null, agent: "plan-reviewer", agentRunId: null, ranToEnd: null })).toBeUndefined();
    expect(log(root).map((line) => [line.event, line.verdict.kind])).toEqual([["invalid", "refuse"]]);
  });

  test("a background run whose finish never comes never counts", async () => {
    const root = project(PREREQS);
    const { judge, afterTool, recordAgentRunFinish } = await open(root);
    expect((await judge(review("c1"))).kind).toBe("allow");
    expect((await afterTool(launched("c1", "a1"))).message).toBeNull();
    // Another run's finish does not stand in for it.
    await recordAgentRunFinish(finished("a-other"));
    for (let attempt = 0; attempt < 2; attempt++) {
      const verdict = await judge(writeSrc);
      expect(verdict.kind === "refuse" && verdict.reason).toContain("has not finished yet");
    }
    expect(records(root)).toEqual([]);
  });

  test("a result neither finished nor reported later records nothing, and afterTool says no later finish will be reported", async () => {
    const root = project(PREREQS);
    const { judge, afterTool } = await open(root);
    expect((await judge(review("c1"))).kind).toBe("allow");
    const told = await afterTool({ ...review("c1"), kind: "tool-result", ok: true, delegatedAgentRuns: [{ finished: false }] });
    expect(told.message).toContain("plan-reviewer's run was not seen to finish, and the host will not report a later finish");
    expect((await judge(writeSrc)).kind).toBe("refuse");
    expect(records(root)).toEqual([]);
  });
});
