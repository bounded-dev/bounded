import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Decision, SessionStart, Verdict } from "bounded/domain";
import { decisionLogConformance } from "../../../../application/judging/judge-event/judge-event.decision-log.test-support.ts";
import { FileSystemDecisionLog } from "./decision-log.ts";

const lines = (file: string): unknown[] => {
  try {
    return readFileSync(file, "utf8").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};

decisionLogConformance("FileSystemDecisionLog", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "decision-log-")), ".bounded", "guard-log.jsonl");
  return { log: new FileSystemDecisionLog(file), recorded: async () => lines(file) };
});

const started = SessionStart.parse({ role: null });
if (!started.ok) throw new Error(started.error);
const decision = Decision.of("2026-10-07T12:00:00.000Z", started.value, { verdict: Verdict.allow, refusedBy: null });

describe("FileSystemDecisionLog", () => {
  test("creates the folders on the way to its file", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "decision-log-")), "a", "b", "log.jsonl");
    await new FileSystemDecisionLog(file).record(decision);
    expect(lines(file)).toEqual([JSON.parse(JSON.stringify(decision))]);
  });

  test("appends one JSON line per decision, keeping what the file already holds", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "decision-log-")), "log.jsonl");
    writeFileSync(file, '{"earlier":true}\n');
    await new FileSystemDecisionLog(file).record(decision);
    expect(readFileSync(file, "utf8")).toBe(`{"earlier":true}\n${JSON.stringify(decision)}\n`);
  });

  test("rejects when the file cannot be written", async () => {
    const blocker = join(mkdtempSync(join(tmpdir(), "decision-log-")), "file");
    writeFileSync(blocker, "");
    await expect(new FileSystemDecisionLog(join(blocker, "log.jsonl")).record(decision)).rejects.toThrow();
  });
});
