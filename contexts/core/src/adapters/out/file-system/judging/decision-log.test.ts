import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Decision, DecisionId, SessionStart, Verdict } from "bounded/domain";
import { decisionLogConformance } from "../../../../application/judging/judge-event/judge-event.decision-log.test-support.ts";
import { FileSystemDecisionLog } from "./decision-log.ts";

/** A decision id from known-good text. */
function decisionId(text: string): DecisionId {
  const parsed = DecisionId.parse(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

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
const decision = Decision.of(decisionId("d-1"), "2026-10-07T12:00:00.000Z", started.value, { verdict: Verdict.allow, refusedBy: null });

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

  test("creates its file readable and writable by its owner only", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "decision-log-")), "log.jsonl");
    await new FileSystemDecisionLog(file).record(decision);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("makes an existing log file readable and writable by its owner only", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "decision-log-")), "log.jsonl");
    writeFileSync(file, "", { mode: 0o644 });
    await new FileSystemDecisionLog(file).record(decision);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("two processes appending at once leave only whole lines", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "decision-log-")), "log.jsonl");
    const worker = join(import.meta.dir, "../../../../../test/fixtures/append-worker.ts");
    const runs = [1, 2].map((n) => Bun.spawn(["bun", worker, file, String(n), "200"], { stdout: "ignore", stderr: "inherit" }));
    expect(await Promise.all(runs.map((run) => run.exited))).toEqual([0, 0]);
    const text = readFileSync(file, "utf8");
    const all = text.split("\n").filter((line) => line !== "");
    expect(all.length).toBe(400);
    expect(all.every((line) => typeof JSON.parse(line).id === "string")).toBe(true);
    expect(text.endsWith("\n")).toBe(true);
  }, 30_000);

  test("rejects when the file cannot be written", async () => {
    const blocker = join(mkdtempSync(join(tmpdir(), "decision-log-")), "file");
    writeFileSync(blocker, "");
    await expect(new FileSystemDecisionLog(join(blocker, "log.jsonl")).record(decision)).rejects.toThrow();
  });
});
