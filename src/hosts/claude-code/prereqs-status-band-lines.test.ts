// What the prereqs status band draws from a status file (ADR 2026-027): the
// freshness rule and the lines, pure, so they are tested here without the
// engine. Only a fresh read snapshot draws a status mark.
import { describe, expect, test } from "bun:test";
import { freshnessOf, statusLines } from "./prereqs-status-band/hooks/prereqs-status-band-lines.ts";
import { readStatusFile } from "./prereqs-status-band/hooks/prereqs-status-file.ts";

const STARTED = "2026-10-08T14:02:11.000Z";
const STARTED_MS = Date.parse(STARTED);
const MARKS = /[✓✗·◷]/;

const key = (agent: string, patterns: readonly string[]): string => JSON.stringify([agent, [...new Set(patterns)].sort()]);
const requirement = (agent: string, patterns: string[], status: string, filesMatched = 2, pendingRun: object | null = null) => ({ key: key(agent, patterns), requiredAgent: agent, unchangedSince: patterns, status, filesMatched, pendingRun });
const planHolds = requirement("plan-reviewer", [".agent-state/*/plan.md"], "holds");
const specStale = requirement("spec-reviewer", ["spec.md"], "stale");
const infraMissing = requirement("infra-reviewer", ["infra/**"], "missing");
const docsPending = requirement("docs-reviewer", ["docs/**"], "pending", 5, { agentRunId: "a6eef1505a0b443a2", startedAt: "2026-10-08T13:58:07.000Z" });
const rule = (before: object, requirementKey: string, allows: boolean) => ({ contributedBy: "bounded/project", before, requirementKey, allows });

/** A file in the band's file form, read by the band. */
function file(changes: object = {}) {
  const raw = { format: "bounded-prereqs-status/1", outcome: "read", readingStartedAt: STARTED, requirements: [planHolds], rules: [rule({ delegate: "builder" }, planHolds.key, true)], projectRoot: "/p", ...changes };
  const reading = readStatusFile(JSON.stringify(raw));
  if (!reading.ok) throw new Error(reading.why);
  return reading;
}
const fresh = { lastFinishSeenAt: STARTED_MS - 1, now: STARTED_MS + 5 };

describe("the prereqs status band's lines", () => {
  test("freshness: no reading yet, fresh, updating for 30 s, then unavailable", () => {
    expect(freshnessOf({ readingStartedAt: STARTED, lastFinishSeenAt: undefined, now: STARTED_MS })).toBe("no-reading-yet");
    expect(freshnessOf({ readingStartedAt: STARTED, lastFinishSeenAt: null, now: STARTED_MS })).toBe("no-reading-yet");
    expect(freshnessOf({ readingStartedAt: STARTED, lastFinishSeenAt: STARTED_MS, now: STARTED_MS + 60_000 })).toBe("fresh");
    expect(freshnessOf({ readingStartedAt: STARTED, lastFinishSeenAt: STARTED_MS - 1, now: STARTED_MS + 60_000 })).toBe("fresh");
    const mark = STARTED_MS + 1;
    for (const since of [0, 29_999, 30_000]) expect(freshnessOf({ readingStartedAt: STARTED, lastFinishSeenAt: mark, now: mark + since })).toBe("updating");
    expect(freshnessOf({ readingStartedAt: STARTED, lastFinishSeenAt: mark, now: mark + 30_001 })).toBe("unavailable");
  });

  test("a fresh read snapshot shows the time, each requirement once, and the next action", () => {
    const requirements = [planHolds, specStale, infraMissing, docsPending];
    const rules = [rule({ delegate: "builder" }, planHolds.key, true), rule({ write: "src/**" }, specStale.key, false), rule({ execute: "terraform apply" }, infraMissing.key, false), rule({ delegate: "publisher" }, docsPending.key, false)];
    const lines = statusLines(file({ requirements, rules }), fresh);
    expect(lines[0]).toContain("14:02:11 UTC");
    const requirementLines = lines.slice(1, 5);
    expect(requirementLines.map((line) => line.slice(0, 1))).toEqual(["✓", "✗", "·", "◷"]);
    expect(requirementLines.map((line) => line.slice(2).split(" ")[0])).toEqual(["plan-reviewer", "spec-reviewer", "infra-reviewer", "docs-reviewer"]);
    expect(requirementLines[1]).toContain("stale");
    expect(requirementLines[3]).toContain("13:58:07 UTC");
    expect(lines.filter((line) => line.includes("plan-reviewer") && !line.startsWith("→"))).toHaveLength(1);
    expect(lines.at(-1)).toStartWith("→");
  });

  test("a requirement whose patterns match no file says so (minor 3)", () => {
    const none = requirement("infra-reviewer", ["infra/**", "terraform/*.tf"], "missing", 0);
    const lines = statusLines(file({ requirements: [none], rules: [rule({ execute: "terraform apply" }, none.key, false)] }), fresh);
    expect(lines).toContain("· infra-reviewer  infra/**, terraform/*.tf match no file yet");
  });

  test("the next line runs up to the first blocked rule, naming each action", () => {
    const requirements = [planHolds, specStale, infraMissing];
    const rules = [rule({ delegate: "builder" }, planHolds.key, true), rule({ write: "src/**" }, planHolds.key, true), rule({ execute: "terraform apply" }, infraMissing.key, false), rule({ delegate: "test-writer" }, specStale.key, false)];
    const next = statusLines(file({ requirements, rules }), fresh).at(-1) ?? "";
    expect(next).toContain("delegating to builder needs plan-reviewer ✓");
    expect(next).toContain("writing src/** needs plan-reviewer ✓");
    expect(next).toContain("executing terraform apply needs infra-reviewer ✗");
    expect(next).not.toContain("test-writer");
    const allowed = statusLines(file({ requirements: [planHolds], rules: [rule({ delegate: "builder" }, planHolds.key, true)] }), fresh).at(-1) ?? "";
    expect(allowed).toContain("nothing is blocked");
    const none = statusLines(file({ requirements: [], rules: [] }), fresh).at(-1) ?? "";
    expect(none).toContain("no rules");
  });

  test("nothing but a fresh read snapshot draws a mark", () => {
    const mark = STARTED_MS + 1;
    const unread = readStatusFile(JSON.stringify({ format: "bounded-prereqs-status/1", outcome: "unread", readingStartedAt: STARTED, why: "the records are locked", projectRoot: "/p" }));
    const drawn: { lines: string[]; says: RegExp }[] = [
      { lines: statusLines(file(), { lastFinishSeenAt: undefined, now: STARTED_MS }), says: /no reading yet/ },
      { lines: statusLines(file(), { lastFinishSeenAt: null, now: STARTED_MS }), says: /no reading yet/ },
      { lines: statusLines(file(), { lastFinishSeenAt: mark, now: mark + 10 }), says: /updating/ },
      { lines: statusLines(file(), { lastFinishSeenAt: mark, now: mark + 30_001 }), says: /unavailable/ },
      { lines: statusLines(unread, fresh), says: /unavailable.*the records are locked/ },
      { lines: statusLines(readStatusFile("{"), fresh), says: /unavailable/ },
      { lines: statusLines(readStatusFile(JSON.stringify({ format: "bounded-prereqs-status/2" })), fresh), says: /unavailable/ },
      { lines: statusLines(readStatusFile(JSON.stringify({ format: "bounded-prereqs-status/1", outcome: "partial" })), fresh), says: /unavailable/ },
    ];
    for (const { lines, says } of drawn) {
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect([line, MARKS.test(line)]).toEqual([line, false]);
      expect(lines.join("\n")).toMatch(says);
      expect(lines.join("\n")).not.toContain("…");
    }
  });
});
