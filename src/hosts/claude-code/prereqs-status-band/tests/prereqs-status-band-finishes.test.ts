// The prereqs status band and the finishes it sees (ADR 2026-027), run by
// `claude plugin test` through `bun run check:prereqs-status-band`. A finished
// tool call or agent run moves the band's one value, lastFinishSeenAt,
// forward; a reading started before it is not shown as fresh. The test's
// bottom classic hooks stand for bounded's own hook, writing the status file.
import { expect, mock, test } from "claude-code/testing";
import type { TestBody } from "claude-code/testing";

type On = Parameters<TestBody>[1];
type Engine = Parameters<TestBody>[0];

const PLUGIN = "bounded-prereqs-status-band";
const SURFACES = ["terminal", "desktop"] as const;
const ROOT = "/work/project";
const STATUS = `${ROOT}/.bounded/prereqs/status.json`;
const CONFIG = `${ROOT}/bounded.config.ts`;
const PROPS = { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 100, scroll: { offset: 0, bodyRows: 11 }, view: {} };
const MARKS = /[✓✗·◷]/;
const T0 = Date.parse("2026-10-08T14:00:00.000Z");
const at = (ms: number): string => new Date(ms).toISOString();

const key = (agent: string, patterns: readonly string[]): string => JSON.stringify([agent, [...new Set(patterns)].sort()]);
const requirement = (agent: string, patterns: string[], status: string, filesMatched: number) => ({ key: key(agent, patterns), requiredAgent: agent, unchangedSince: patterns, status, filesMatched, pendingRun: null });
const planHolds = requirement("plan-reviewer", [".agent-state/*/plan.md"], "holds", 1);
const specStale = requirement("spec-reviewer", ["spec.md"], "stale", 1);
const infraMissing = requirement("infra-reviewer", ["infra/**"], "missing", 3);
const rule = (before: object, requirementKey: string, allows: boolean) => ({ contributedBy: "bounded/project", before, requirementKey, allows });

/** The canonical read snapshot in the file form, its reading started at `startedAt`. */
function readSnapshot(startedAt: number): string {
  const rules = [rule({ delegate: "builder" }, planHolds.key, true), rule({ delegate: "test-writer" }, specStale.key, false), rule({ execute: "terraform apply" }, infraMissing.key, false)];
  return JSON.stringify({ format: "bounded-prereqs-status/1", outcome: "read", readingStartedAt: at(startedAt), requirements: [planHolds, specStale, infraMissing], rules, projectRoot: ROOT });
}

/** The engine beneath the band: the session's root, the files, the clock and the engine's own band. */
function world(on: On, files: Map<string, string>) {
  const clock = mock.clock(on, { now: T0 });
  on("session.root", () => ({ value: ROOT }));
  on("fs.exists", (_$, e) => ({ value: files.has(e.path) }));
  on("fs.read", (_$, e) => {
    const text = files.get(e.path);
    return text === undefined ? { deny: `ENOENT: no such file, open '${e.path}'` } : { value: text };
  });
  on("fs.stat", (_$, e) => ({ value: { kind: "dir" as const, size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }));
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: "the engine's own band" });
  });
  return clock;
}

/** The band mounted on every surface, read again on each call. */
async function mountAll($: Engine) {
  const mounted = await Promise.all(SURFACES.map((surface) => $.ui.mount({ plugin: PLUGIN, surface, component: "AbovePrompt", props: PROPS })));
  return async (): Promise<string[]> => {
    const all: string[] = [];
    for (const ui of mounted) all.push((await ui.findAll({ type: "Text" })).map((element) => element.text).join("\n"));
    expect(all[0]).toBe(all[1]);
    return (all[0] ?? "").split("\n");
  };
}

const postToolUse = ($: Engine, id = "toolu_1") => $.classic.PostToolUse({ tool_name: "Read", tool_input: { file_path: "plan.md" }, tool_response: {}, tool_use_id: id });
const freshCanonical = (lines: string[]) => {
  expect(lines).toContain("✓ plan-reviewer  over .agent-state/*/plan.md as they are now");
  expect(lines).toContain("✗ spec-reviewer  stale: spec.md changed since");
  expect(lines).toContain("· infra-reviewer  not yet run");
  expect(lines.at(-1)).toBe("→ next: delegating to builder needs plan-reviewer ✓   delegating to test-writer needs spec-reviewer ✗");
};
const noMarks = (lines: string[]) => {
  for (const line of lines) expect([line, MARKS.test(line)]).toEqual([line, false]);
};

test("after a finished call whose snapshot bounded wrote, it shows each requirement and the next action", async ($, on) => {
  const files = new Map<string, string>([[CONFIG, ""]]);
  const clock = world(on, files);
  on("classic.PostToolUse", () => {
    files.set(STATUS, readSnapshot(clock.now() + 5));
    return {};
  });
  const read = await mountAll($);
  await postToolUse($);
  const lines = await read();
  expect(lines[0]).toBe("prereqs status as of 14:00:00 UTC");
  freshCanonical(lines);
});

test("a finished call whose snapshot has not come shows updating with no marks, then unavailable after 30 s", async ($, on) => {
  const files = new Map<string, string>([[CONFIG, ""], [STATUS, readSnapshot(T0 - 60_000)]]);
  const clock = world(on, files);
  on("classic.PostToolUse", () => ({}));
  const read = await mountAll($);
  await postToolUse($);
  const updating = await read();
  expect(updating.join("\n")).toContain("prereqs status updating");
  noMarks(updating);
  await clock.advance(30_001);
  const unavailable = await read();
  expect(unavailable.join("\n")).toContain("prereqs status unavailable");
  noMarks(unavailable);
});

test("PostToolUseFailure is a finish too", async ($, on) => {
  const files = new Map<string, string>([[CONFIG, ""], [STATUS, readSnapshot(T0 - 60_000)]]);
  world(on, files);
  on("classic.PostToolUseFailure", () => ({}));
  const read = await mountAll($);
  expect((await read()).join("\n")).toContain("no reading yet");
  await $.classic.PostToolUseFailure({ tool_name: "Bash", tool_input: { command: "false" }, tool_use_id: "toolu_2", error: "exit 1" });
  expect((await read()).join("\n")).toContain("prereqs status updating");
});

test("a SubagentStop with an empty agent_type is no finish; with one it is", async ($, on) => {
  const files = new Map<string, string>([[CONFIG, ""], [STATUS, readSnapshot(T0 - 60_000)]]);
  world(on, files);
  on("classic.SubagentStop", () => ({}));
  const read = await mountAll($);
  const stop = (agentType: string) => $.classic.SubagentStop({ stop_hook_active: false, agent_id: "a6eef1505a0b443a2", agent_transcript_path: "", agent_type: agentType });
  await stop("");
  expect((await read()).join("\n")).toContain("no reading yet");
  await stop("plan-reviewer");
  expect((await read()).join("\n")).toContain("prereqs status updating");
});

test("the classic hooks pass the chain's answer through unchanged", async ($, on) => {
  world(on, new Map([[CONFIG, ""]]));
  on("classic.PostToolUse", () => ({ additionalContext: ["x"] }));
  on("classic.PostToolUseFailure", () => ({ additionalContext: ["y"] }));
  on("classic.SubagentStop", () => ({ additionalContext: ["z"] }));
  expect(await postToolUse($)).toEqual({ additionalContext: ["x"] });
  expect(await $.classic.PostToolUseFailure({ tool_name: "Bash", tool_input: {}, tool_use_id: "toolu_2", error: "exit 1" })).toEqual({ additionalContext: ["y"] });
  expect(await $.classic.SubagentStop({ stop_hook_active: false, agent_id: "a1", agent_transcript_path: "", agent_type: "plan-reviewer" })).toEqual({ additionalContext: ["z"] });
});

test("a band whose state write fails still passes the answer through", async ($, on) => {
  world(on, new Map([[CONFIG, ""], [STATUS, readSnapshot(T0 + 5)]]));
  // Refused, $.state.set rejects, and the band's hook fails after marking nothing.
  on("state.set", () => ({ deny: "the session's state is unavailable" }));
  on("classic.PostToolUse", () => ({ additionalContext: ["x"] }));
  const read = await mountAll($);
  expect(await postToolUse($)).toEqual({ additionalContext: ["x"] });
  expect((await read()).join("\n")).toContain("no reading yet");
});

test("without session.start, the first finished call starts the 2-second redraw", async ($, on) => {
  const files = new Map<string, string>([[CONFIG, ""]]);
  const clock = world(on, files);
  on("classic.PostToolUse", () => ({}));
  const read = await mountAll($);
  await postToolUse($);
  expect((await read()).join("\n")).toContain("no status file");
  files.set(STATUS, readSnapshot(clock.now() + 5));
  await clock.advance(2_000);
  freshCanonical(await read());
});

test("two finishes whose marks land out of order leave the later one", async ($, on) => {
  const files = new Map<string, string>([[CONFIG, ""]]);
  const clock = world(on, files);
  let writes = 0;
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  on("state.set", async (_$, e, next) => {
    writes += 1;
    if (writes === 1) await released;
    return next(e);
  });
  on("classic.PostToolUse", () => ({}));
  const read = await mountAll($);
  await clock.advance(1_000);
  const first = postToolUse($, "toolu_first");
  await clock.settle();
  await clock.advance(1_000);
  await postToolUse($, "toolu_second");
  release();
  await first;
  files.set(STATUS, readSnapshot(T0 + 1_500));
  await clock.advance(2_000);
  expect((await read()).join("\n")).toContain("prereqs status updating");
  files.set(STATUS, readSnapshot(T0 + 2_000));
  await clock.advance(2_000);
  freshCanonical(await read());
});
