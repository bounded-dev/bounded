import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { protectedPathsPortProvisions } from "bounded/protected-paths/adapters";
import { prereqsPortProvisions } from "bounded/prereqs/adapters";
import { openProject } from "./open-project.ts";
import { fixedShellCommandReader, UNREAD_SAMPLE } from "./shell-command-reader.test-support.ts";

const CORE = resolve(import.meta.dir, "../..");
/** These tests judge no shell command by its reading: every command is read as unread. */
const unread = fixedShellCommandReader(UNREAD_SAMPLE);
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bounded-prereqs-")));
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

const writeSrc = { kind: "tool-use", role: "builder", tool: "edit", effects: [{ kind: "write", path: "src/a.ts", change: "modify" }], callId: "w1" };
const review = (callId: string) => ({ kind: "tool-use", role: null, tool: "subagent", effects: [{ kind: "delegate", agent: "plan-reviewer" }], callId });
const reviewed = (callId: string, finished: boolean) => ({ ...review(callId), kind: "tool-result", ok: true, delegatedAgentRuns: [{ finished }] });
const log = (root: string): { verdict: { kind: string }; note?: string }[] =>
  readFileSync(join(root, ".bounded", "guard-log.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));

describe("bounded/prereqs end to end: openProject with the pack's adapters", () => {
  test("the foreground path: refused, reviewed, allowed, then stale when the plan changes", async () => {
    const root = project(PREREQS);
    const { judge, afterTool, problem } = await openProject(root, { ports: prereqsPortProvisions(), shellCommandReader: unread });
    expect(problem).toBeNull();
    const refused = await judge(writeSrc);
    expect(refused.kind === "refuse" && refused.reason).toContain("has not succeeded");
    expect(refused.kind === "refuse" && refused.redirect).toBe(REDIRECT);
    expect((await judge(review("c1"))).kind).toBe("allow");
    expect((await afterTool(reviewed("c1", true))).message).toBeNull();
    expect((await judge(writeSrc)).kind).toBe("allow");
    writeFileSync(join(root, ".agent-state", "item", "plan.md"), "the plan, edited\n");
    const stale = await judge(writeSrc);
    expect(stale.kind === "refuse" && stale.reason).toContain("changed since");
    expect(log(root).map((line) => line.verdict.kind)).toEqual(["refuse", "allow", "allow", "allow", "refuse"]);
    expect(log(root)[2]?.note).toContain("plan-reviewer");
    expect(existsSync(join(root, ".bounded", "prereqs", "records.jsonl"))).toBe(true);
  });

  test("a background launch records nothing, and afterTool says why", async () => {
    const root = project(PREREQS);
    const { judge, afterTool } = await openProject(root, { ports: [...protectedPathsPortProvisions(), ...prereqsPortProvisions()], shellCommandReader: unread });
    expect((await judge(review("c1"))).kind).toBe("allow");
    const told = await afterTool(reviewed("c1", false));
    expect(told.message).toContain("plan-reviewer's run was not seen to finish (it may still be running in the background)");
    expect((await judge(writeSrc)).kind).toBe("refuse");
  });

  test("opening without the ports refuses every event naming bounded/prereqs and fileSetFingerprints", async () => {
    const root = project(PREREQS);
    const { judge, problem } = await openProject(root, { shellCommandReader: unread });
    expect(problem).toContain("bounded/prereqs");
    expect(problem).toContain("fileSetFingerprints");
    for (const event of [writeSrc, review("c1"), { kind: "tool-use", role: null, tool: "read", effects: [{ kind: "read", path: "README.md" }] }]) {
      const verdict = await judge(event);
      expect(verdict.kind === "refuse" && verdict.reason).toContain("fileSetFingerprints");
    }
  });

  test("a project that does not select bounded/prereqs leaves no trace", async () => {
    const root = project(CORE_ONLY);
    const { judge, afterTool } = await openProject(root, { ports: prereqsPortProvisions(), shellCommandReader: unread });
    expect((await judge(writeSrc)).kind).toBe("allow");
    expect((await judge(review("c1"))).kind).toBe("allow");
    expect((await afterTool(reviewed("c1", true))).message).toBeNull();
    expect(existsSync(join(root, ".bounded", "prereqs"))).toBe(false);
  });

  test("a symbolic link among the files a rule names makes the rule refuse, naming the link", async () => {
    const root = project(PREREQS);
    symlinkSync("../../src/a.ts", join(root, ".agent-state", "item", "plan.md.link"));
    mkdirSync(join(root, ".agent-state", "linked"));
    symlinkSync("../item/plan.md", join(root, ".agent-state", "linked", "plan.md"));
    const { judge } = await openProject(root, { ports: prereqsPortProvisions(), shellCommandReader: unread });
    const refused = await judge(writeSrc);
    expect(refused.kind === "refuse" && refused.reason).toContain(".agent-state/linked/plan.md is a symbolic link");
    expect((await judge(review("c1"))).kind).toBe("refuse");
  });

  test("a symbolic link created during the run is refused after it: nothing is recorded", async () => {
    const root = project(PREREQS);
    const { judge, afterTool } = await openProject(root, { ports: prereqsPortProvisions(), shellCommandReader: unread });
    expect((await judge(review("c1"))).kind).toBe("allow");
    mkdirSync(join(root, ".agent-state", "linked"));
    symlinkSync("../item/plan.md", join(root, ".agent-state", "linked", "plan.md"));
    const told = await afterTool(reviewed("c1", true));
    expect(told.message).toContain(".agent-state/linked/plan.md is a symbolic link");
    expect(existsSync(join(root, ".bounded", "prereqs", "records.jsonl"))).toBe(false);
    expect(log(root).at(-1)?.verdict.kind).toBe("refuse");
    expect((await judge(writeSrc)).kind).toBe("refuse");
  });

  test("records are per project root", async () => {
    const [first, second] = [project(PREREQS), project(PREREQS)];
    const one = await openProject(first, { ports: prereqsPortProvisions(), shellCommandReader: unread });
    expect((await one.judge(review("c1"))).kind).toBe("allow");
    await one.afterTool(reviewed("c1", true));
    expect((await one.judge(writeSrc)).kind).toBe("allow");
    const two = await openProject(second, { ports: prereqsPortProvisions(), shellCommandReader: unread });
    expect((await two.judge(writeSrc)).kind).toBe("refuse");
  });
});
