import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Decision, DecisionId, SessionStart, Verdict } from "bounded/domain";
import { projectBoundedLogsConformance } from "../../../application/project-config/open-project/open-project.project-bounded-logs.test-support.ts";
import { FileSystemProjectBoundedLogs } from "./project-bounded-logs.ts";

const lines = (file: string): unknown[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));

projectBoundedLogsConformance("FileSystemProjectBoundedLogs", async () => {
  const root = mkdtempSync(join(tmpdir(), "bounded-project-"));
  return {
    logs: new FileSystemProjectBoundedLogs(),
    root,
    recorded: async () => lines(join(root, ".bounded", "log.jsonl")),
  };
});

describe("FileSystemProjectBoundedLogs", () => {
  test("records a project's decisions in .bounded/log.jsonl and leaves an existing .bounded/guard-log.jsonl as it was", async () => {
    const root = mkdtempSync(join(tmpdir(), "bounded-project-"));
    mkdirSync(join(root, ".bounded"));
    const old = join(root, ".bounded", "guard-log.jsonl");
    writeFileSync(old, '{"earlier":true}\n');
    chmodSync(old, 0o644);
    const id = DecisionId.parse("d-1");
    const start = SessionStart.parse({ role: null });
    if (!id.ok || !start.ok) throw new Error("expected a decision id and an event");
    const decision = Decision.of(id.value, "2026-10-07T12:00:00.000Z", start.value, { verdict: Verdict.allow, refusedBy: null });

    await new FileSystemProjectBoundedLogs().forProject(root).record(decision);

    expect(readFileSync(old, "utf8")).toBe('{"earlier":true}\n');
    expect(statSync(old).mode & 0o777).toBe(0o644);
    expect(lines(join(root, ".bounded", "log.jsonl"))).toEqual([JSON.parse(JSON.stringify(decision))]);
  });
});
