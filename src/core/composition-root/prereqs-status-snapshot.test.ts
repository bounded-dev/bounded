import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Ports } from "bounded/domain";
import { fileSetFingerprintsPort, prerequisiteRecordsPort } from "bounded/prereqs";
import { FileSystemPrerequisiteRecords, prereqsPortProvisions, prereqsStatusSnapshotPortProvisions } from "bounded/prereqs/adapters";
import { openProject } from "./open-project.ts";

// The status snapshot bounded/prereqs writes when the host provides its port (ADR 2026-026), end to end.
const CORE = resolve(import.meta.dir, "../..");
process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "bounded-state-"));
const PREREQS = `import { contribution, corePack, defineConfig } from "bounded/domain";
import { prereqs } from "bounded/prereqs";
export default defineConfig({
  packs: [corePack, prereqs],
  contributes: [contribution(prereqs.points.rules, [{ before: { write: "src/**" }, require: { delegate: "plan-reviewer", succeeded: true }, unchangedSince: [".agent-state/*/plan.md"], redirect: "Have plan-reviewer review the current plan before editing src/" }])],
});
`;

/** A git project with `config`, a plan and a source file. */
function project(config: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bounded-prereqs-status-")));
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

const statusFile = (root: string): string => join(root, ".bounded", "prereqs", "status.json");
/** The snapshot kept for the project, as the file holds it. */
const kept = (root: string): { outcome: string; projectRoot: string; why?: string; requirements?: { status: string }[] } => JSON.parse(readFileSync(statusFile(root), "utf8"));
const statuses = (root: string): string[] | undefined => kept(root).requirements?.map((requirement) => requirement.status);

const writeSrc = { kind: "tool-use", role: "builder", tool: "edit", effects: [{ kind: "write", path: "src/a.ts", change: "modify" }], callId: "w1" };
const readme = (callId: string) => ({ kind: "tool-result", role: null, tool: "read", effects: [{ kind: "read", path: "src/a.ts" }], callId, ok: true });
const review = (callId: string) => ({ kind: "tool-use", role: null, tool: "subagent", effects: [{ kind: "delegate", agent: "plan-reviewer" }], callId });
/** The result of a review: a finished run names the agent the host ran, as Claude Code reports an exact request (ADR 2026-025). */
const reviewed = (callId: string, finished: boolean) => ({ ...review(callId), kind: "tool-result", ok: true, delegatedAgentRuns: [finished ? { finished, resolvedAgent: "plan-reviewer" } : { finished }] });

describe("bounded/prereqs's status snapshot end to end: openProject with the snapshot port", () => {
  test("the snapshot follows the gate", async () => {
    const root = project(PREREQS);
    const { judge, afterTool, problem } = await openProject(root, { ports: [...prereqsPortProvisions(), ...prereqsStatusSnapshotPortProvisions()] });
    expect(problem).toBeNull();
    expect((await afterTool(readme("r1"))).message).toBeNull();
    expect(statuses(root)).toEqual(["missing"]);
    expect((await judge(writeSrc)).kind).toBe("refuse");
    expect((await judge(review("c1"))).kind).toBe("allow");
    expect((await afterTool(reviewed("c1", true))).message).toBeNull();
    expect(statuses(root)).toEqual(["holds"]);
    expect((await judge(writeSrc)).kind).toBe("allow");
    writeFileSync(join(root, ".agent-state", "item", "plan.md"), "the plan, edited\n");
    await afterTool(readme("r2"));
    expect(statuses(root)).toEqual(["stale"]);
    expect(kept(root).projectRoot).toBe(root);
  });

  test("afterTool still answers with recordAfterTool's message, on time, when the snapshot's reading hangs", async () => {
    const root = project(PREREQS);
    const hanging = Ports.provide(fileSetFingerprintsPort, () => ({ fingerprint: () => new Promise<never>(() => {}) }));
    const records = Ports.provide(prerequisiteRecordsPort, (projectRoot) => new FileSystemPrerequisiteRecords(projectRoot));
    const { afterTool, problem } = await openProject(root, { ports: [hanging, records, ...prereqsStatusSnapshotPortProvisions()] });
    expect(problem).toBeNull();
    const started = performance.now();
    const told = await afterTool(reviewed("c1", false));
    expect(performance.now() - started).toBeLessThan(2500 + 1000);
    expect(told.message).toContain("plan-reviewer's run was not seen to finish");
    expect(kept(root)).toMatchObject({ outcome: "unread", why: "bounded/prereqs.rules: reading the status did not finish within 2000 ms" });
    expect(existsSync(statusFile(root))).toBe(true);
  }, 10_000);

  test("opened without the snapshot port, nothing is written", async () => {
    const root = project(PREREQS);
    const { judge, afterTool } = await openProject(root, { ports: prereqsPortProvisions() });
    expect((await judge(review("c1"))).kind).toBe("allow");
    await afterTool(reviewed("c1", true));
    await afterTool(readme("r1"));
    expect(existsSync(join(root, ".bounded", "prereqs", "records.jsonl"))).toBe(true);
    expect(existsSync(statusFile(root))).toBe(false);
  });

  test("a project not selecting bounded/prereqs gets no status.json", async () => {
    const root = project(`import { corePack, defineConfig } from "bounded/domain";\nexport default defineConfig({ packs: [corePack] });\n`);
    const { afterTool, problem } = await openProject(root, { ports: [...prereqsPortProvisions(), ...prereqsStatusSnapshotPortProvisions()] });
    expect(problem).toBeNull();
    await afterTool(readme("r1"));
    expect(existsSync(join(root, ".bounded", "prereqs"))).toBe(false);
  });

  test("an unusable configuration writes nothing", async () => {
    const root = project("export default 5;\n");
    const { afterTool, problem } = await openProject(root, { ports: [...prereqsPortProvisions(), ...prereqsStatusSnapshotPortProvisions()] });
    expect(problem).not.toBeNull();
    await afterTool(readme("r1"));
    expect(existsSync(statusFile(root))).toBe(false);
  });
});
