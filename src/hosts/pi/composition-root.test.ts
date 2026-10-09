import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type ShellCommandReadingJSON, ToolResult, ToolUse, Verdict } from "bounded/domain";
import type { openProject } from "bounded/open-project";
import { ReadShellCommandHandler, type ShellCommandReader } from "bounded-shell-command-reader/application";
import type { ReadShellCommand } from "bounded-shell-command-reader/shell-command-reading";
import { composeProject, shellCommandReading } from "./composition-root.ts";
import { type LoadJudge, type Pi, type PiHandler, type ProjectJudgeForPi, piExtension } from "./extension.ts";

// A project resolves `bounded` as an installed project would: from its node_modules.
const CORE = resolve(import.meta.dir, "../..");
/** A project selecting bounded/prereqs: a write under src/ needs plan-reviewer to have succeeded over the current plan. */
const PREREQS_CONFIG = `import { contribution, corePack, defineConfig } from "bounded/domain";
import { prereqs } from "bounded/prereqs";
export default defineConfig({
  packs: [corePack, prereqs],
  contributes: [contribution(prereqs.points.rules, [{ before: { write: "src/**" }, require: { delegate: "plan-reviewer", succeeded: true }, unchangedSince: ["plans/plan.md"], redirect: "Have plan-reviewer review the current plan before editing src/" }])],
});
`;
/** A project whose execute guard allows a command only when bounded read it as running tool-a alone. */
const PROGRAMS_CONFIG = `import { contribution, corePack, defineConfig, Verdict } from "bounded/domain";
export default defineConfig({
  packs: [corePack],
  contributes: [
    contribution(corePack.points.effectGuards.execute, [
      (effect) =>
        effect.reading?.outcome === "read" && effect.reading.programs.map((program) => program.name.text).join(",") === "tool-a"
          ? Verdict.allow
          : Verdict.refuse("Only tool-a runs here", "Run tool-a"),
    ]),
  ],
});
`;
/** A project whose only pack is the protected-paths pack: it refuses a shell command it cannot check. */
const PROTECTED_PATHS_CONFIG = `import { corePack, defineConfig } from "bounded/domain";
import { protectedPathsPack } from "bounded/protected-paths";
export default defineConfig({ packs: [corePack, protectedPathsPack] });
`;
/** A read reading's wire form: a command that runs tool-a from the project root, touching no file. */
const READ: ShellCommandReadingJSON = { outcome: "read", programs: [{ name: { kind: "literal", text: "tool-a" }, arguments: [], workingDirectory: "." }], fileEffects: [], unresolved: [] };

/** A temporary project resolving bounded as an installed project would, from its node_modules, configured by `config`. */
function projectWith(config: string, prefix: string): string {
  const project = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  mkdirSync(join(project, "node_modules"));
  symlinkSync(CORE, join(project, "node_modules", "bounded"), "dir");
  writeFileSync(join(project, "bounded.config.ts"), config);
  return project;
}

/** The extension over `project`, its session started there: a bash call's answer, as pi gets it. */
async function sessionIn(project: string, readShellCommand: ReadShellCommand, load: LoadJudge = () => composeProject(project)) {
  const handlers = new Map<string, PiHandler>();
  piExtension({ projectRoot: project, load, readShellCommand })({ on: (name, handler) => void handlers.set(name, handler) });
  await handlers.get("session_start")?.({ type: "session_start" }, { cwd: project });
  return (command: string) => handlers.get("tool_call")?.({ type: "tool_call", toolCallId: "1", toolName: "bash", input: { command } }, { cwd: project });
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "bounded-pi-root-")));
const parsed = ToolUse.parse({ kind: "tool-use", role: null, tool: "read", effects: [{ kind: "read", path: "a.ts" }] });
if (!parsed.ok) throw new Error(parsed.error);
const event = parsed.value;
type Open = typeof openProject;

const rejecting: Open = async () => {
  throw new Error("the log directory cannot be created");
};
const judging = (judge: (event: unknown) => Promise<never>): Open => async () => ({ judge, afterTool: async () => ({ changed: [], restored: true, message: null }), refuse: async () => Verdict.refuse("refused", "fix it"), problem: null });

describe("composeProject — never fails open, whatever openProject or its judge does", () => {
  test("an openProject that rejects gives a decide that refuses every event, saying why", async () => {
    const decide = await composeProject(root, rejecting);
    const verdict = await decide(event);
    expect(verdict.kind).toBe("refuse");
    expect(verdict.kind === "refuse" && verdict.reason).toContain("the log directory cannot be created");
    expect(verdict.kind === "refuse" && verdict.redirect.trim()).not.toBe("");
  });

  test("a judge that rejects or throws refuses that event", async () => {
    const rejected = await (await composeProject(root, judging(async () => { throw new Error("log write failed"); })))(event);
    expect(rejected.kind === "refuse" && rejected.reason).toContain("log write failed");
    const thrown = await (await composeProject(root, judging(() => { throw new Error("judge broke"); })))(event);
    expect(thrown.kind === "refuse" && thrown.reason).toContain("judge broke");
  });

  test("the decide carries the project's afterTool and refuse; an openProject that rejects has neither", async () => {
    const decide = await composeProject(root);
    const result = ToolResult.parse({ kind: "tool-result", role: null, tool: "shell", effects: [{ kind: "execute", command: "ls", reading: READ }], ok: true, callId: "1" });
    if (!result.ok) throw new Error(result.error);
    expect(await decide.afterTool?.(result.value)).toMatchObject({ message: null });
    await decide.refuse?.({ hostToolName: "read", reason: "outside the project", redirect: "use a path inside it", role: null, input: {} });
    const log = join(root, ".bounded", "log.jsonl");
    expect(existsSync(log)).toBe(true);
    expect(readFileSync(log, "utf8")).toContain('"event":"adapter"');
    const failed = await composeProject(root, rejecting);
    expect(failed.afterTool).toBeUndefined();
    expect(failed.refuse).toBeUndefined();
  });

  test("the default open provides bounded/prereqs's ports", async () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), "bounded-pi-prereqs-")));
    mkdirSync(join(project, "node_modules"));
    symlinkSync(CORE, join(project, "node_modules", "bounded"), "dir");
    mkdirSync(join(project, "plans"));
    writeFileSync(join(project, "plans", "plan.md"), "the plan\n");
    writeFileSync(join(project, "bounded.config.ts"), PREREQS_CONFIG);
    const write = ToolUse.parse({ kind: "tool-use", role: null, tool: "write", effects: [{ kind: "write", path: "src/a.ts", change: "create" }], callId: "1" });
    if (!write.ok) throw new Error(write.error);
    const verdict = await (await composeProject(project))(write.value);
    // Opened with its ports: the rule itself refuses, not a missing port.
    expect(verdict.kind === "refuse" && verdict.reason).toStartWith("bounded/prereqs.rules:");
    expect(verdict.kind === "refuse" && verdict.reason).toContain("has not succeeded");
    expect(verdict.kind === "refuse" && verdict.redirect).toBe("Have plan-reviewer review the current plan before editing src/");
  });

  test("a bash call whose reader rejects is blocked: the protected-paths pack refuses its unread reading, saying why", async () => {
    const project = projectWith(PROTECTED_PATHS_CONFIG, "bounded-pi-unread-");
    const rejecting: ShellCommandReader = {
      prepare: async () => {},
      read: async () => {
        throw new Error("bounded's shell parser could not load (main.wasm is missing)");
      },
    };
    const bash = await sessionIn(project, new ReadShellCommandHandler(rejecting));
    const result = await bash("ls");
    expect(result).toMatchObject({ block: true });
    expect((result as { reason: string }).reason).toContain(
      "bounded/protected-paths refused execute `ls` in .: the protected-paths pack cannot check shell commands: bounded's shell parser could not load (main.wasm is missing)",
    );
  });

  test("a bash call whose reader does not answer in time is blocked as unread, timed out", async () => {
    const project = projectWith(PROTECTED_PATHS_CONFIG, "bounded-pi-late-");
    const hanging: ShellCommandReader = { prepare: async () => {}, read: () => new Promise(() => {}) };
    const bash = await sessionIn(project, new ReadShellCommandHandler(hanging, { readWithinMs: 50 }));
    const result = await bash("ls");
    expect(result).toMatchObject({ block: true });
    expect((result as { reason: string }).reason).toContain("reading the command did not finish within 50 ms (timed out)");
  });

  test("the extension reads shell commands with bounded's reader: the project's execute guard sees the programs bounded read", async () => {
    const project = projectWith(PROGRAMS_CONFIG, "bounded-pi-shell-");
    const seen: ToolUse[] = [];
    const load: LoadJudge = async () => {
      const decide = await composeProject(project);
      const recording: ProjectJudgeForPi = async (event) => {
        seen.push(event);
        return decide(event);
      };
      return recording;
    };
    const bash = await sessionIn(project, shellCommandReading, load);
    expect(await bash("tool-a x")).toBeUndefined();
    expect(await bash("tool-b x")).toEqual({ block: true, reason: "bounded/project refused execute `tool-b x` in .: Only tool-a runs here\nRun tool-a" });
    const [effect] = seen[0]?.effects ?? [];
    expect(effect?.kind === "execute" && effect.reading.outcome).toBe("read");
  });

  test("the refusal reaches pi as a block with a reason and a redirect", async () => {
    let handler: PiHandler | undefined;
    let start: PiHandler | undefined;
    const pi: Pi = {
      on(name, h) {
        if (name === "tool_call") handler = h;
        else if (name === "session_start") start = h;
      },
    };
    piExtension({ projectRoot: root, load: () => composeProject(root, rejecting), readShellCommand: shellCommandReading })(pi);
    await start?.({ type: "session_start" }, { cwd: root });
    const result = await handler?.({ type: "tool_call", toolName: "read", input: { path: "a.ts" } }, { cwd: root });
    expect(result).toMatchObject({ block: true });
    const lines = (result as { reason: string }).reason.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("the log directory cannot be created");
  });
});
