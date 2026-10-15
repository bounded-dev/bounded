// bounded-pi with the real core: a temporary project with its own
// bounded.config.ts, driven through a fake pi, judged by openProject and
// recorded in the project's Bounded log.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Pi, PiHandler } from "./extension.ts";
import { bounded } from "./index.ts";
import { piRuntimeAvailable, reportPiRuntime, underPi } from "./pi-runtime.test-support.ts";

// The project resolves `bounded` as an installed project would: from its node_modules.
const CORE = resolve(import.meta.dir, "../..");
const CONFIG = `import { contribution, corePack, defineConfig, Verdict } from "bounded/domain";
export default defineConfig({
  packs: [corePack],
  contributes: [contribution(corePack.points.effectGuards.write, [(effect) => (effect.path.value.startsWith("generated/") ? Verdict.refuse("generated/ is written by the generator", "Change the generator's input instead") : Verdict.allow)])],
});
`;

function project(config: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bounded-pi-e2e-")));
  mkdirSync(join(root, "node_modules"));
  symlinkSync(CORE, join(root, "node_modules", "bounded"), "dir");
  mkdirSync(join(root, "generated"));
  writeFileSync(join(root, "bounded.config.ts"), config);
  return root;
}

async function session(root: string) {
  const handlers = new Map<string, PiHandler>();
  const pi: Pi = {
    on(event, handler) {
      handlers.set(event, handler);
    },
  };
  bounded(root)(pi);
  await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, { cwd: root });
  return (toolName: string, input: unknown) => handlers.get("tool_call")?.({ type: "tool_call", toolCallId: "1", toolName, input }, { cwd: root });
}

const logged = (root: string): { event: string; verdict: { kind: string } }[] =>
  readFileSync(join(root, ".bounded", "log.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));

describe("bounded-pi end to end — a project's bounded.config.ts judging pi's calls", () => {
  test("blocks a write its guard refuses, allows a read, and records both decisions", async () => {
    const root = project(CONFIG);
    const call = await session(root);
    expect(await call("write", { path: "generated/api.ts", content: "x" })).toEqual({
      block: true,
      reason: "bounded/project refused write (create) generated/api.ts: generated/ is written by the generator\nChange the generator's input instead",
    });
    expect(await call("read", { path: "src/a.ts" })).toBeUndefined();
    expect(logged(root).map((line) => line.verdict.kind)).toEqual(["refuse", "allow"]);
  });

  test("a configuration that cannot be used blocks every call, saying why and what to do", async () => {
    const root = project("export default 42;\n");
    const call = await session(root);
    const result = await call("read", { path: "a.ts" });
    expect(result).toMatchObject({ block: true });
    const [reason, redirect] = (result as { reason: string }).reason.split("\n");
    expect(reason).toContain("This project's configuration cannot be used");
    expect(redirect).not.toBe("");
    expect(logged(root).map((line) => line.verdict.kind)).toEqual(["refuse"]);
  });
});

/** The same session, run as pi runs it: bounded-pi loaded through pi's jiti, under node. */
function sessionUnderPi(root: string, calls: readonly (readonly [string, unknown])[]): { results: unknown[]; log: string[] } {
  const body = `const [index, root, calls] = process.argv.slice(2);
const { bounded } = await load(index);
const handlers = {};
bounded(root)({ on(event, handler) { handlers[event] = handler; } });
await handlers.session_start({ type: "session_start", reason: "startup" }, { cwd: root });
const results = [];
for (const [toolName, input] of JSON.parse(calls)) results.push((await handlers.tool_call({ type: "tool_call", toolCallId: "1", toolName, input }, { cwd: root })) ?? null);
const { readFileSync } = await import("node:fs");
const log = readFileSync(root + "/.bounded/log.jsonl", "utf8").split("\\n").filter((line) => line !== "").map((line) => JSON.parse(line).verdict.kind);
console.log(JSON.stringify({ results, log }));`;
  return underPi(body, join(import.meta.dir, "index.ts"), root, JSON.stringify(calls)) as { results: unknown[]; log: string[] };
}

describe("bounded-pi end to end — under pi's runtime (node, through pi's jiti)", () => {
  reportPiRuntime();

  test.skipIf(!piRuntimeAvailable)("blocks a write its guard refuses, allows another write, and records both decisions", () => {
    const root = project(CONFIG);
    const { results, log } = sessionUnderPi(root, [
      ["write", { path: "generated/api.ts", content: "x" }],
      ["write", { path: "src/a.ts", content: "x" }],
    ]);
    expect(results).toEqual([
      { block: true, reason: "bounded/project refused write (create) generated/api.ts: generated/ is written by the generator\nChange the generator's input instead" },
      null,
    ]);
    expect(log).toEqual(["refuse", "allow"]);
  });

  test.skipIf(!piRuntimeAvailable)("a configuration that cannot be used blocks every call", () => {
    const root = project("export default 42;\n");
    const { results, log } = sessionUnderPi(root, [["read", { path: "a.ts" }]]);
    expect(results).toMatchObject([{ block: true }]);
    expect((results[0] as { reason: string }).reason).toContain("This project's configuration cannot be used");
    expect(log).toEqual(["refuse"]);
  });
});

/** A project selecting bounded/prereqs: a write under src/, and a delegation to builder, each need plan-reviewer to have succeeded over the current plan. */
const PREREQS_CONFIG = `import { contribution, corePack, defineConfig } from "bounded/domain";
import { prereqs } from "bounded/prereqs";
export default defineConfig({
  packs: [corePack, prereqs],
  contributes: [
    contribution(prereqs.points.rules, [
      { before: { write: "src/**" }, require: { delegate: "plan-reviewer", succeeded: true }, unchangedSince: ["plans/plan.md"], redirect: "Have plan-reviewer review the current plan before editing src/" },
      { before: { delegate: "builder" }, require: { delegate: "plan-reviewer", succeeded: true }, unchangedSince: ["plans/plan.md"], redirect: "Have plan-reviewer review the current plan before building" },
    ]),
  ],
});
`;

type Fields = Record<string, unknown>;
type ResultEvent = Fields & { toolCallId: string; input: Fields; details: Fields & { results: Fields[] } };
type Completion = Fields & { results: Fields[] };
const PI_SUBAGENTS = join(import.meta.dir, "test", "fixtures", "pi-subagents");
/** A pi-subagents fixture (derived from source, not captured; ADR 2026-028), read afresh, without its `_source` citation. */
function fixture<T extends Fields>(name: string): T {
  const read = JSON.parse(readFileSync(join(PI_SUBAGENTS, name), "utf8")) as T;
  delete read._source;
  return read;
}
const R = "5b1f0c6e-2d4a-4c8e-9f3b-7a1d2e3c4b5a";

/** A project with its plan and a source file, configured with PREREQS_CONFIG. */
function prereqsProject(): string {
  const root = project(PREREQS_CONFIG);
  mkdirSync(join(root, "plans"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "plans", "plan.md"), "the plan\n");
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  return root;
}

/** A session of bounded(root) over a fake pi with its event bus: calls and results carry their call ids, and completions are published on the bus. */
async function prereqsSession(root: string) {
  const handlers = new Map<string, PiHandler>();
  const subscribers = new Map<string, ((data: unknown) => unknown)[]>();
  const pi: Pi = {
    on(event, handler) {
      handlers.set(event, handler);
    },
    events: {
      on(channel: string, handler: (data: unknown) => unknown) {
        subscribers.set(channel, [...(subscribers.get(channel) ?? []), handler]);
        return () => {};
      },
    },
  };
  bounded(root)(pi);
  await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, { cwd: root });
  const call = (toolCallId: string, toolName: string, input: unknown) => handlers.get("tool_call")?.({ type: "tool_call", toolCallId, toolName, input }, { cwd: root });
  const result = (event: unknown) => handlers.get("tool_result")?.(event, { cwd: root });
  const complete = async (payload: unknown): Promise<void> => {
    await Promise.all((subscribers.get("subagent:async-complete") ?? []).map((handler) => handler(payload)));
  };
  const writeSrc = () => call("call-write", "write", { path: "src/a.ts", content: "export const a = 2;\n" });
  /** Launches plan-reviewer in the background, as pi-subagents does by default: its call, then its launch result. */
  const launchReview = async () => {
    const launch = fixture<ResultEvent>("async-launch.tool-result.json");
    expect(await call(launch.toolCallId, "subagent", launch.input)).toBeUndefined();
    expect(await result(launch)).toBeUndefined();
  };
  return { call, result, complete, writeSrc, launchReview };
}

const reasonOf = (answer: unknown): string => (answer as { reason: string }).reason;
const finishLines = (root: string) => logged(root).filter((line) => line.event === "agent-run-finished") as unknown as { verdict: { kind: string; reason?: string }; note: string | null }[];

describe("bounded-pi end to end — bounded/prereqs on pi (ADR 2026-028)", () => {
  test("an async review run counts at pi-subagents' completion: the write it gates is pending until then, and allowed after", async () => {
    const root = prereqsProject();
    const session = await prereqsSession(root);
    await session.launchReview();
    const pending = await session.writeSrc();
    expect(reasonOf(pending)).toContain("has not finished yet");
    await session.complete(fixture("async-complete.json"));
    expect(await session.writeSrc()).toBeUndefined();
    expect(finishLines(root).map((line) => line.verdict.kind)).toEqual(["allow"]);
  });

  test("an async review run whose completion says it was stopped does not count, and the Bounded log says why", async () => {
    const root = prereqsProject();
    const session = await prereqsSession(root);
    await session.launchReview();
    await session.complete(fixture("async-complete-stopped.json"));
    expect(await session.writeSrc()).toMatchObject({ block: true });
    const [line] = finishLines(root);
    expect(line?.verdict.kind).toBe("refuse");
    expect(JSON.stringify(line)).toContain("did not run to its end");
  });

  test("a review run whose files changed between its launch and its completion does not count", async () => {
    const root = prereqsProject();
    const session = await prereqsSession(root);
    await session.launchReview();
    writeFileSync(join(root, "plans", "plan.md"), "the plan, changed\n");
    await session.complete(fixture("async-complete.json"));
    expect(await session.writeSrc()).toMatchObject({ block: true });
    expect(JSON.stringify(finishLines(root))).toContain("changed while");
  });

  test("a completion whose run resolved to another agent does not count", async () => {
    const root = prereqsProject();
    const session = await prereqsSession(root);
    await session.launchReview();
    const scout = fixture<Completion>("async-complete.json");
    const [child] = scout.results;
    if (child !== undefined) child.agent = "scout";
    await session.complete(scout);
    expect(await session.writeSrc()).toMatchObject({ block: true });
    expect(JSON.stringify(finishLines(root))).toContain("finished as scout, not plan-reviewer");
  });

  test("a synchronous review run that ran to its end counts at its result; an interrupted one does not", async () => {
    const interruptedRoot = prereqsProject();
    const interrupted = await prereqsSession(interruptedRoot);
    const stopped = fixture<ResultEvent>("sync-interrupted.tool-result.json");
    expect(await interrupted.call(stopped.toolCallId, "subagent", stopped.input)).toBeUndefined();
    await interrupted.result(stopped);
    expect(reasonOf(await interrupted.writeSrc())).toContain("has not succeeded");

    const root = prereqsProject();
    const session = await prereqsSession(root);
    const completed = fixture<ResultEvent>("sync-completed.tool-result.json");
    expect(await session.call(completed.toolCallId, "subagent", completed.input)).toBeUndefined();
    expect(await session.result(completed)).toBeUndefined();
    expect(await session.writeSrc()).toBeUndefined();
  });

  test("a resume of a builder run is refused while the review it needs is missing, and a resume of an unseen run is refused", async () => {
    const root = prereqsProject();
    const session = await prereqsSession(root);
    const builderRun = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
    const builder = fixture<ResultEvent>("async-launch.tool-result.json");
    builder.toolCallId = "call-build-1";
    builder.input = { agent: "builder", task: "Build it" };
    builder.details = { ...builder.details, runId: builderRun, asyncId: builderRun, toolCallId: "call-build-1" };
    await session.result(builder);
    const built = fixture<Completion>("async-complete.json");
    built.id = builderRun;
    built.runId = builderRun;
    built.toolCallId = "call-build-1";
    const [child] = built.results;
    if (child !== undefined) child.agent = "builder";
    await session.complete(built);

    const resume = (id: string) => session.call("call-resume", "subagent", { action: "resume", id, message: "go on" });
    const missing = reasonOf(await resume(builderRun));
    expect(missing).toStartWith("bounded/prereqs.rules:");
    expect(missing).toContain("has not succeeded");

    await session.launchReview();
    await session.complete(fixture("async-complete.json"));
    expect(await resume(builderRun)).toBeUndefined();

    const [reason, redirect] = reasonOf(await resume("never-seen")).split("\n");
    expect(reason).toContain("cannot tell which agent");
    expect(redirect).toStartWith("Start a new run of the agent instead");
  });

  test("a resume of the reviewer some rule requires is refused at the call: a resumed run never counts", async () => {
    const root = prereqsProject();
    const session = await prereqsSession(root);
    await session.launchReview();
    await session.complete(fixture("async-complete.json"));
    const answer = await session.call("call-resume", "subagent", { action: "resume", id: R, message: "go on" });
    expect(answer).toMatchObject({ block: true });
    expect(reasonOf(answer).split("\n")[1]).toBe("Run plan-reviewer as a new run whose finish the host reports");
  });

  test("a counted review goes stale when the plan is edited: the write and the delegation to builder it allowed are refused as changed since", async () => {
    const STALE_WRITE =
      "bounded/prereqs.rules: bounded/project's rule before write 'src/**' requires a delegation to plan-reviewer that succeeded over the current 'plans/plan.md', and plan-reviewer succeeded over them, but they have changed since. This call would write (modify) src/a.ts\nHave plan-reviewer review the current plan before editing src/";
    const STALE_BUILD =
      "bounded/prereqs.rules: bounded/project's rule before delegating to 'builder' requires a delegation to plan-reviewer that succeeded over the current 'plans/plan.md', and plan-reviewer succeeded over them, but they have changed since. This call would delegate to builder\nHave plan-reviewer review the current plan before building";
    const root = prereqsProject();
    const session = await prereqsSession(root);
    await session.launchReview();
    await session.complete(fixture("async-complete.json"));
    expect(await session.writeSrc()).toBeUndefined();
    expect(await session.call("call-build-1", "subagent", { agent: "builder", task: "Build it" })).toBeUndefined();

    writeFileSync(join(root, "plans", "plan.md"), "the plan, edited\n");
    expect(await session.writeSrc()).toEqual({ block: true, reason: STALE_WRITE });
    expect(await session.call("call-build-2", "subagent", { agent: "builder", task: "Build it" })).toEqual({ block: true, reason: STALE_BUILD });
  });
});
