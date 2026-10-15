// The prereqs status band's drawing (ADR 2026-027), run by `claude plugin test`
// through `bun run check:prereqs-status-band`. The test's hooks stand for the
// engine beneath the band: the session's root, a file table for $.fs, the
// clock, and the engine's own band.
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
const ENGINE_OWN = "the engine's own band";
const MARKS = /[✓✗·◷]/;
const T0 = Date.parse("2026-10-08T14:00:00.000Z");
const at = (ms: number): string => new Date(ms).toISOString();

const key = (agent: string, patterns: readonly string[]): string => JSON.stringify([agent, [...new Set(patterns)].sort()]);
const planHolds = { key: key("plan-reviewer", ["plan.md"]), requiredAgent: "plan-reviewer", unchangedSince: ["plan.md"], status: "holds", filesMatched: 1, pendingRun: null };

/** A read snapshot in the file form, its reading started at `startedAt`. */
function readSnapshot(startedAt: number, projectRoot = ROOT): string {
  const rules = [{ contributedBy: "bounded/project", before: { delegate: "builder" }, requirementKey: planHolds.key, allows: true }];
  return JSON.stringify({ format: "bounded-prereqs-status/1", outcome: "read", readingStartedAt: at(startedAt), requirements: [planHolds], rules, projectRoot });
}

/** The engine beneath the band: the session's root, the files, the clock and the engine's own band. */
function world(on: On, files: Map<string, string>, unreadable: Set<string> = new Set()) {
  const clock = mock.clock(on, { now: T0 });
  on("session.root", () => ({ value: ROOT }));
  on("fs.exists", (_$, e) => ({ value: files.has(e.path) }));
  on("fs.read", (_$, e) => {
    const text = files.get(e.path);
    if (text === undefined) return { deny: `ENOENT: no such file, open '${e.path}'` };
    if (unreadable.has(e.path)) return { deny: `EACCES: permission denied, open '${e.path}'` };
    return { value: text };
  });
  on("fs.stat", (_$, e) => (e.path.startsWith("/") ? { value: { kind: "dir" as const, size: 0, mtimeMs: 0, isLink: false, realPath: e.path } } : { deny: `ENOENT: ${e.path}` }));
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: ENGINE_OWN });
  });
  return clock;
}

/** The texts the band draws on each surface, mounted afresh. */
async function drawn($: Engine, props: typeof PROPS = PROPS): Promise<string[][]> {
  const out: string[][] = [];
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: "AbovePrompt", props });
    out.push((await ui.findAll({ type: "Text" })).map((element) => element.text));
    await ui.unmount();
  }
  return out;
}

const finish = ($: Engine) => $.classic.PostToolUse({ tool_name: "Read", tool_input: { file_path: "plan.md" }, tool_response: {}, tool_use_id: "toolu_1" });

test("with no bounded configuration at the session root, the band draws nothing of its own", async ($, on) => {
  world(on, new Map([[STATUS, readSnapshot(T0)]]));
  for (const texts of await drawn($)) expect(texts).toEqual([ENGINE_OWN]);
});

test("a survey keeps the band", async ($, on) => {
  world(on, new Map([[CONFIG, ""], [STATUS, readSnapshot(T0)]]));
  for (const texts of await drawn($, { ...PROPS, hasSurvey: true })) expect(texts).toEqual([ENGINE_OWN]);
});

test("before any finished call it says no reading yet, even over a valid file", async ($, on) => {
  world(on, new Map([[CONFIG, ""], [STATUS, readSnapshot(T0 + 60_000)]]));
  for (const texts of await drawn($)) {
    expect(texts.join("\n")).toContain("no reading yet");
    for (const text of texts) expect([text, MARKS.test(text)]).toEqual([text, false]);
  }
});

test("a file that is missing, unreadable, not JSON, of another format, malformed, or for another project, is unavailable, saying which", async ($, on) => {
  const files = new Map<string, string>([[CONFIG, ""]]);
  const unreadable = new Set<string>();
  world(on, files, unreadable);
  const cases: { set: () => void; says: string[] }[] = [
    { set: () => files.delete(STATUS), says: ["no status file at .bounded/prereqs/status.json"] },
    {
      set: () => {
        files.set(STATUS, readSnapshot(T0));
        unreadable.add(STATUS);
      },
      says: ["cannot be read", "EACCES"],
    },
    {
      set: () => {
        unreadable.clear();
        files.set(STATUS, "{");
      },
      says: ["not JSON"],
    },
    { set: () => files.set(STATUS, JSON.stringify({ format: "bounded-prereqs-status/2", outcome: "read" })), says: ["bounded-prereqs-status/2", "bounded-prereqs-status/1", "node_modules/bounded/dist/hosts/claude-code/prereqs-status-band"] },
    { set: () => files.set(STATUS, JSON.stringify({ ...JSON.parse(readSnapshot(T0)), outcome: "partial" })), says: ["outcome"] },
    { set: () => files.set(STATUS, readSnapshot(T0, "/elsewhere/project")), says: ["/elsewhere/project", ROOT] },
  ];
  for (const { set, says } of cases) {
    set();
    for (const texts of await drawn($)) {
      const all = texts.join("\n");
      expect(all).toContain("prereqs status unavailable");
      for (const said of says) expect(all).toContain(said);
      for (const text of texts) expect([text, MARKS.test(text)]).toEqual([text, false]);
    }
  }
});

test("an unread snapshot is unavailable with its why", async ($, on) => {
  const files = new Map<string, string>([[CONFIG, ""]]);
  world(on, files);
  on("classic.PostToolUse", () => {
    files.set(STATUS, JSON.stringify({ format: "bounded-prereqs-status/1", outcome: "unread", readingStartedAt: at(T0 + 1), why: "bounded/prereqs.rules: the records are locked", projectRoot: ROOT }));
    return {};
  });
  await finish($);
  for (const texts of await drawn($)) {
    expect(texts.join("\n")).toContain("prereqs status unavailable: bounded/prereqs.rules: the records are locked");
    for (const text of texts) expect([text, MARKS.test(text)]).toEqual([text, false]);
  }
});

test("when drawing fails, the band says unavailable", async ($, on) => {
  mock.clock(on, { now: T0 });
  on("session.root", () => ({ deny: "the session's root is withheld" }));
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: ENGINE_OWN });
  });
  for (const texts of await drawn($)) {
    expect(texts.join("\n")).toContain("prereqs status unavailable");
    for (const text of texts) expect([text, MARKS.test(text)]).toEqual([text, false]);
  }
});
