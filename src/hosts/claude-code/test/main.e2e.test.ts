// The hook as Claude Code runs it: a subprocess given the payload on stdin,
// answering on stdout, always exiting 0.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const APP = join(import.meta.dir, "..");
// Snapshots go to the user's state directory: a temporary one here, which the hook processes inherit.
process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "bounded-cc-state-"));
let root = "";
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "bounded-cc-e2e-")));
  mkdirSync(join(root, "src"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function run(entry: string, stdin: string, at = APP, timeout = 10_000, projectRoot = root): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const child = Bun.spawn(["bun", join(at, entry)], { stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe", env: { ...process.env, CLAUDE_PROJECT_DIR: projectRoot }, timeout });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exitCode };
}
const deny = (reason: string): string => JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });

describe("main.ts as a Claude Code PreToolUse hook", () => {
  test("a refusing decide is a deny on stdout, exit 0", async () => {
    const payload = { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: join(root, "src", "new.ts"), content: "x" }, cwd: root, session_id: "s", tool_use_id: "t" };
    const { stdout, exitCode } = await run("test/fixtures/refusing-hook.ts", JSON.stringify(payload));
    expect(stdout).toBe(deny('Refused write: [{"kind":"write","path":"src/new.ts","change":"create"}]\nAsk the project\'s maintainer'));
    expect(exitCode).toBe(0);
  });

  test("garbage on stdin is a deny, exit 0: never a crash Claude Code would read as allow", async () => {
    const { stdout, exitCode } = await run("main.ts", "\u0000 not json");
    expect(stdout).toStartWith('{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"The hook\'s input is not JSON: ');
    expect(exitCode).toBe(0);
  });

  test("a project without bounded.config.ts is refused", async () => {
    const payload = { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: join(root, "src") }, cwd: root };
    const { stdout, exitCode } = await run("main.ts", JSON.stringify(payload));
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(exitCode).toBe(0);
  });

  test("if the rest of the hook cannot even load, main.ts still denies, exit 0", async () => {
    // main.ts alone in a directory: nothing it loads is there.
    const lonely = mkdtempSync(join(tmpdir(), "bounded-cc-lonely-"));
    copyFileSync(join(APP, "main.ts"), join(lonely, "main.ts"));
    try {
      const { stdout, exitCode } = await run("main.ts", JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "a" } }), lonely);
      expect(stdout).toStartWith('{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"bounded\'s Claude Code hook failed to start: ');
      expect(JSON.parse(stdout).hookSpecificOutput.permissionDecisionReason).toEndWith("\nReport this to the maintainers of bounded; the call stays refused until it is fixed");
      expect(exitCode).toBe(0);
    } finally {
      rmSync(lonely, { recursive: true, force: true });
    }
  });

  test("the process is not cut short after answering: work still pending, such as a late log line, finishes", async () => {
    const payload = { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: join(root, "src") }, cwd: root };
    const { stdout, stderr, exitCode } = await run("test/fixtures/late-writing-hook.ts", JSON.stringify(payload));
    expect(stdout).toBe(deny("No\nAsk"));
    expect(stderr).toContain("late log line");
    expect(exitCode).toBe(0);
  });

  test("a decide pending forever, with work left running, is denied at the deadline and the process still exits 0 after the drain", async () => {
    const payload = { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: join(root, "src") }, cwd: root };
    const started = Date.now();
    const { stdout, exitCode } = await run("test/fixtures/pending-forever-hook.ts", JSON.stringify(payload), APP, 4000);
    expect(stdout).toBe(deny("bounded did not decide within 200 ms\nRetry the call; if it keeps timing out, report it to the maintainers of bounded"));
    expect(exitCode).toBe(0);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("with a real bounded.config.ts: a guarded write is denied, naming the pack; another is allowed; both are logged", async () => {
    // A project resolving `bounded` to the workspace package, as the core's own end-to-end tests do.
    const project = realpathSync(mkdtempSync(join(tmpdir(), "bounded-cc-config-")));
    try {
      mkdirSync(join(project, "node_modules"));
      symlinkSync(join(APP, "..", ".."), join(project, "node_modules", "bounded"), "dir");
      writeFileSync(
        join(project, "bounded.config.ts"),
        `import { contribution, corePack, defineConfig, definePack, packIdsFor, Verdict } from "bounded/domain";
const noGenerated = definePack({
  id: packIdsFor("test-packs")("no-generated"),
  dependsOn: [corePack],
  contributes: [
    contribution(corePack.points.effectGuards.write, [
      (effect) => (effect.path.value.startsWith("generated/") ? Verdict.refuse("generated/ is written by the generator", "Change the generator's input instead") : Verdict.allow),
    ]),
  ],
});
export default defineConfig({ packs: [corePack, noGenerated] });
`,
      );
      const write = (path: string): string => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: join(project, path), content: "x" }, cwd: project });

      const refused = await run("main.ts", write("generated/api.ts"), APP, 10_000, project);
      expect(refused.stdout).toBe(deny("test-packs/no-generated refused write (create) generated/api.ts: generated/ is written by the generator\nChange the generator's input instead"));
      expect(refused.exitCode).toBe(0);

      const allowed = await run("main.ts", write("src/a.ts"), APP, 10_000, project);
      expect(allowed.stdout).toBe("");
      expect(allowed.exitCode).toBe(0);

      const lines = readFileSync(join(project, ".bounded", "log.jsonl"), "utf8").split("\n").filter((line) => line !== "");
      expect(lines.map((line) => JSON.parse(line).verdict.kind)).toEqual(["refuse", "allow"]);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("with a real bounded.config.ts under git: a command that changes a protected file and then fails is caught after the failure, and the file restored", async () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), "bounded-cc-drift-")));
    try {
      mkdirSync(join(project, "node_modules"));
      symlinkSync(join(APP, "..", ".."), join(project, "node_modules", "bounded"), "dir");
      writeFileSync(
        join(project, "bounded.config.ts"),
        `import { contribution, corePack, defineConfig } from "bounded/domain";
import { protectedPathsPack } from "bounded/protected-paths";
export default defineConfig({
  packs: [corePack, protectedPathsPack],
  contributes: [contribution(protectedPathsPack.points.protectedPaths, [{ match: "generated/**", deny: ["create", "modify", "delete"], why: "generated/ is written by the generator", redirect: "Change the generator's input" }])],
});
`,
      );
      mkdirSync(join(project, "generated"));
      writeFileSync(join(project, "generated", "a.ts"), "original\n");
      writeFileSync(join(project, ".gitignore"), "node_modules/\n.bounded/\n");
      const git = (...args: string[]) => spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd: project });
      git("init", "--quiet");
      git("add", "-A");
      git("commit", "--quiet", "-m", "base");

      const call = { tool_name: "Bash", tool_input: { command: "./regenerate.sh; exit 1" }, tool_use_id: "toolu_e2e", cwd: project };
      const before = await run("main.ts", JSON.stringify({ hook_event_name: "PreToolUse", ...call }), APP, 10_000, project);
      expect(before.stdout).toBe("");
      writeFileSync(join(project, "generated", "a.ts"), "x\n");
      const after = await run("main.ts", JSON.stringify({ hook_event_name: "PostToolUseFailure", ...call, error: "Exit code 1" }), APP, 10_000, project);
      expect(after.exitCode).toBe(0);
      const answer = JSON.parse(after.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
      expect(answer.hookSpecificOutput.hookEventName).toBe("PostToolUseFailure");
      expect(answer.hookSpecificOutput.additionalContext).toStartWith("This command changed protected files, and they were restored: generated/a.ts was modified — protected because");
      expect(readFileSync(join(project, "generated", "a.ts"), "utf8")).toBe("original\n");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe("main.ts as a Claude Code SubagentStop hook, from captured Claude Code 2.1.294 payloads", () => {
  /** A captured payload (fixtures/agent-responses/README.md), its cwd set to `project`. */
  const captured = (name: string, project: string): string => JSON.stringify({ ...JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "agent-responses", name), "utf8")), cwd: project });

  /** A git project selecting bounded/prereqs: a write under src/ needs `agent` to have succeeded over the current plan.md. */
  function prereqsProject(agent: string): string {
    const project = realpathSync(mkdtempSync(join(tmpdir(), "bounded-cc-finish-")));
    mkdirSync(join(project, "node_modules"));
    symlinkSync(join(APP, "..", ".."), join(project, "node_modules", "bounded"), "dir");
    mkdirSync(join(project, "src"));
    writeFileSync(join(project, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(project, "plan.md"), "the plan\n");
    writeFileSync(join(project, ".gitignore"), "node_modules/\n.bounded/\n");
    writeFileSync(
      join(project, "bounded.config.ts"),
      `import { contribution, corePack, defineConfig } from "bounded/domain";
import { prereqs } from "bounded/prereqs";
export default defineConfig({
  packs: [corePack, prereqs],
  contributes: [contribution(prereqs.points.rules, [{ before: { write: "src/**" }, require: { delegate: "${agent}", succeeded: true }, unchangedSince: ["plan.md"], redirect: "Have ${agent} review the current plan" }])],
});
`,
    );
    spawnSync("git", ["init", "--quiet"], { cwd: project });
    return project;
  }
  const writeSrc = (project: string): string => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: join(project, "src", "a.ts"), content: "x" }, cwd: project, tool_use_id: "toolu_write" });
  const hookIn = (project: string) => (stdin: string) => run("main.ts", stdin, APP, 10_000, project);
  const reasonOf = (stdout: string): string => (stdout === "" ? "allowed" : JSON.parse(stdout).hookSpecificOutput.permissionDecisionReason);

  test("a SubagentStop answers nothing and exits 0, even in a project without bounded.config.ts", async () => {
    const { stdout, exitCode } = await run("main.ts", captured("background-subagent-stop.json", root));
    expect(stdout).toBe("");
    expect(exitCode).toBe(0);
  });

  test("with bounded/prereqs: a background review, launched and then finished, lets the write through", async () => {
    const project = prereqsProject("plan-reviewer");
    try {
      const hook = hookIn(project);
      expect(reasonOf((await hook(writeSrc(project))).stdout)).toContain("has not succeeded");
      expect((await hook(captured("background-pre-tool-use.json", project))).stdout).toBe("");
      expect((await hook(captured("background-post-tool-use.json", project))).stdout).toBe("");
      expect(reasonOf((await hook(writeSrc(project))).stdout)).toContain("started at");
      const stop = await hook(captured("background-subagent-stop.json", project));
      expect(stop.stdout).toBe("");
      expect(stop.exitCode).toBe(0);
      expect((await hook(writeSrc(project))).stdout).toBe("");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  }, 60_000);

  test("with bounded/prereqs: a review requested as Plan-Reviewer counts once plan-reviewer finishes, in the background and in the foreground", async () => {
    const background = prereqsProject("plan-reviewer");
    const foreground = prereqsProject("plan-reviewer");
    try {
      const later = hookIn(background);
      expect((await later(captured("case-folded-background-pre-tool-use.json", background))).stdout).toBe("");
      expect((await later(captured("case-folded-background-post-tool-use.json", background))).stdout).toBe("");
      expect((await later(captured("case-folded-background-subagent-stop.json", background))).stdout).toBe("");
      expect((await later(writeSrc(background))).stdout).toBe("");

      const now = hookIn(foreground);
      expect((await now(captured("case-folded-foreground-pre-tool-use.json", foreground))).stdout).toBe("");
      // The foreground order: the finish comes before the completed result.
      expect((await now(captured("case-folded-foreground-subagent-stop.json", foreground))).stdout).toBe("");
      expect((await now(captured("case-folded-foreground-post-tool-use.json", foreground))).stdout).toBe("");
      expect((await now(writeSrc(foreground))).stdout).toBe("");
    } finally {
      rmSync(background, { recursive: true, force: true });
      rmSync(foreground, { recursive: true, force: true });
    }
  }, 60_000);

  test("with bounded/prereqs: a turn-limited background run never lets the write through", async () => {
    const project = prereqsProject("turn-limited");
    try {
      const hook = hookIn(project);
      expect((await hook(captured("turn-limited-background-pre-tool-use.json", project))).stdout).toBe("");
      expect((await hook(captured("turn-limited-background-post-tool-use.json", project))).stdout).toBe("");
      // Claude Code sends no SubagentStop for a run stopped at its turn limit.
      expect(reasonOf((await hook(writeSrc(project))).stdout)).toContain("started at");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  }, 60_000);

  test("with bounded/prereqs: a background run stopped with TaskStop never lets the write through", async () => {
    const project = prereqsProject("slow");
    try {
      const hook = hookIn(project);
      expect((await hook(captured("task-stopped-pre-tool-use.json", project))).stdout).toBe("");
      expect((await hook(captured("task-stopped-post-tool-use.json", project))).stdout).toBe("");
      expect((await hook(captured("task-stopped-task-stop-post-tool-use.json", project))).stdout).toBe("");
      // Claude Code sends no SubagentStop for a run stopped with TaskStop.
      const verdict = reasonOf((await hook(writeSrc(project))).stdout);
      expect(verdict).toContain("started at");
      expect(verdict).not.toBe("allowed");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  }, 60_000);
});
