import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callIdOf, prerequisiteRecordsConformance, recordOf, startOf } from "../../../application/check-prerequisites/check-prerequisites.prerequisite-records.test-support.ts";
import { FileSystemPrerequisiteRecords } from "./prerequisite-records.ts";

const projectRoot = (): string => mkdtempSync(join(tmpdir(), "prereqs-records-"));

// Hooks run as separate processes, so a new instance over the same root must see what another wrote.
prerequisiteRecordsConformance("FileSystemPrerequisiteRecords", async () => {
  const root = projectRoot();
  const writer = new FileSystemPrerequisiteRecords(root);
  const reader = new FileSystemPrerequisiteRecords(root);
  return {
    append: (record) => writer.append(record),
    readAll: () => reader.readAll(),
    saveStartedForCall: (callId, starts) => writer.saveStartedForCall(callId, starts),
    takeStartedForCall: (callId) => reader.takeStartedForCall(callId),
  };
});

describe("FileSystemPrerequisiteRecords — records in the project, starts beside them", () => {
  test("records persist across instances", async () => {
    const root = projectRoot();
    await new FileSystemPrerequisiteRecords(root).append(recordOf("plan-reviewer", "c1"));
    expect(await new FileSystemPrerequisiteRecords(root).readAll()).toEqual([recordOf("plan-reviewer", "c1").toJSON()]);
  });

  test("records are kept in .bounded/prereqs/records.jsonl", async () => {
    const root = projectRoot();
    await new FileSystemPrerequisiteRecords(root).append(recordOf("plan-reviewer", "c1"));
    expect(readFileSync(join(root, ".bounded", "prereqs", "records.jsonl"), "utf8")).toBe(`${JSON.stringify(recordOf("plan-reviewer", "c1"))}\n`);
  });

  test("concurrent appends from two instances each land as one whole line", async () => {
    const root = projectRoot();
    const [one, two] = [new FileSystemPrerequisiteRecords(root), new FileSystemPrerequisiteRecords(root)];
    await Promise.all(Array.from({ length: 50 }, (_, i) => (i % 2 === 0 ? one : two).append(recordOf("plan-reviewer", `c${i}`))));
    const lines = readFileSync(join(root, ".bounded", "prereqs", "records.jsonl"), "utf8").split("\n").filter((line) => line !== "");
    expect(lines).toHaveLength(50);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    expect((await one.readAll()).length).toBe(50);
  });

  test("a torn last line is ignored, and the next append starts on a line of its own", async () => {
    const root = projectRoot();
    const records = new FileSystemPrerequisiteRecords(root);
    await records.append(recordOf("plan-reviewer", "c1"));
    appendFileSync(join(root, ".bounded", "prereqs", "records.jsonl"), '{"delegate":"plan-rev');
    expect(await records.readAll()).toEqual([recordOf("plan-reviewer", "c1").toJSON()]);
    await records.append(recordOf("spec-reviewer", "c2"));
    expect(await records.readAll()).toEqual([recordOf("plan-reviewer", "c1").toJSON(), recordOf("spec-reviewer", "c2").toJSON()]);
  });

  test("a malformed complete line makes readAll reject", async () => {
    const root = projectRoot();
    const records = new FileSystemPrerequisiteRecords(root);
    await records.append(recordOf("plan-reviewer", "c1"));
    appendFileSync(join(root, ".bounded", "prereqs", "records.jsonl"), "not json\n");
    await expect(records.readAll()).rejects.toThrow();
  });

  test("a start is written whole", async () => {
    const root = projectRoot();
    const records = new FileSystemPrerequisiteRecords(root);
    await records.saveStartedForCall(callIdOf("c1"), [startOf("plan-reviewer")]);
    const dir = join(root, ".bounded", "prereqs", "started", "calls");
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.json$/);
    expect(JSON.parse(readFileSync(join(dir, files[0] ?? ""), "utf8"))).toEqual([startOf("plan-reviewer").toJSON()]);
  });

  test("a start older than a day is not given back", async () => {
    const root = projectRoot();
    const records = new FileSystemPrerequisiteRecords(root);
    await records.saveStartedForCall(callIdOf("old"), [startOf("plan-reviewer")]);
    const dir = join(root, ".bounded", "prereqs", "started", "calls");
    const [file] = readdirSync(dir);
    const dayAndAnHourAgo = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
    utimesSync(join(dir, file ?? ""), dayAndAnHourAgo, dayAndAnHourAgo);
    expect(await records.takeStartedForCall(callIdOf("old"))).toBeUndefined();
    expect(existsSync(join(dir, file ?? ""))).toBe(false);
    // Saving sweeps away starts older than a day, such as those of calls whose result never came.
    await records.saveStartedForCall(callIdOf("abandoned"), [startOf("plan-reviewer")]);
    const [abandoned] = readdirSync(dir);
    utimesSync(join(dir, abandoned ?? ""), dayAndAnHourAgo, dayAndAnHourAgo);
    await records.saveStartedForCall(callIdOf("next"), [startOf("plan-reviewer")]);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  test("a start that is not JSON makes takeStartedForCall reject, so the handler treats it as altered", async () => {
    const root = projectRoot();
    const records = new FileSystemPrerequisiteRecords(root);
    await records.saveStartedForCall(callIdOf("c1"), [startOf("plan-reviewer")]);
    const dir = join(root, ".bounded", "prereqs", "started", "calls");
    const [file] = readdirSync(dir);
    writeFileSync(join(dir, file ?? ""), "{garbled");
    await expect(records.takeStartedForCall(callIdOf("c1"))).rejects.toThrow();
  });
});
