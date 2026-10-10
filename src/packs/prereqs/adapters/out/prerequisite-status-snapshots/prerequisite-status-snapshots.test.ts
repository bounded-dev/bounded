import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prerequisiteStatusSnapshotsConformance, snapshotAt } from "../../../application/check-prerequisites/check-prerequisites.prerequisite-status-snapshots.test-support.ts";
import { FileSystemPrerequisiteStatusSnapshots } from "./prerequisite-status-snapshots.ts";

const projectRoot = (): string => mkdtempSync(join(tmpdir(), "prereqs-status-"));
const statusFile = (root: string): string => join(root, ".bounded", "prereqs", "status.json");
const readKept = (root: string): unknown => (existsSync(statusFile(root)) ? JSON.parse(readFileSync(statusFile(root), "utf8")) : undefined);

// Hooks run as separate processes, so a new instance over the same root must see what another wrote.
prerequisiteStatusSnapshotsConformance("FileSystemPrerequisiteStatusSnapshots", async () => {
  const root = projectRoot();
  let failing = false;
  const blocked = join(root, "blocked-temporary");
  const snapshots = new FileSystemPrerequisiteStatusSnapshots(root, { temporaryNameOf: (dir) => (failing ? blocked : join(dir, `status.json.${crypto.randomUUID()}.tmp`)) });
  return {
    snapshots,
    projectRoot: root,
    kept: async () => readKept(root),
    failSaves: async () => {
      // A directory where the temporary file would go: the write fails.
      mkdirSync(blocked, { recursive: true });
      failing = true;
    },
  };
});

describe("FileSystemPrerequisiteStatusSnapshots — the status snapshot in the project's .bounded/prereqs/status.json", () => {
  test("status.json holds the file form: the snapshot and the project's root, written whole", async () => {
    const root = projectRoot();
    const snapshot = snapshotAt("2026-10-10T12:00:00.000Z");
    await new FileSystemPrerequisiteStatusSnapshots(root).save(snapshot);
    const text = readFileSync(statusFile(root), "utf8");
    expect(JSON.parse(text)).toEqual({ ...snapshot.toJSON(), projectRoot: root });
    expect(text.endsWith("\n")).toBe(true);
    // Written to a temporary file, then renamed: nothing else is left beside it.
    expect(readdirSync(join(root, ".bounded", "prereqs"))).toEqual(["status.json"]);
  });

  test("temporary files older than a minute are swept on save; newer ones are left", async () => {
    const root = projectRoot();
    const dir = join(root, ".bounded", "prereqs");
    mkdirSync(dir, { recursive: true });
    const old = join(dir, "status.json.old.tmp");
    const fresh = join(dir, "status.json.fresh.tmp");
    writeFileSync(old, "{");
    writeFileSync(fresh, "{");
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
    utimesSync(old, twoMinutesAgo, twoMinutesAgo);
    await new FileSystemPrerequisiteStatusSnapshots(root).save(snapshotAt("2026-10-10T12:00:00.000Z"));
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(join(dir, "records.jsonl"))).toBe(false);
  });

  test("a failed save removes the old status.json and rejects", async () => {
    const root = projectRoot();
    const blocked = join(root, "blocked");
    let block = false;
    const snapshots = new FileSystemPrerequisiteStatusSnapshots(root, { temporaryNameOf: (dir) => (block ? blocked : join(dir, "status.json.next.tmp")) });
    await snapshots.save(snapshotAt("2026-10-10T12:00:00.000Z"));
    expect(existsSync(statusFile(root))).toBe(true);
    mkdirSync(blocked);
    block = true;
    await expect(snapshots.save(snapshotAt("2026-10-10T12:00:01.000Z"))).rejects.toThrow();
    expect(existsSync(statusFile(root))).toBe(false);
  });

  test("a kept file that cannot be read is replaced", async () => {
    const root = projectRoot();
    mkdirSync(join(root, ".bounded", "prereqs"), { recursive: true });
    writeFileSync(statusFile(root), "not json");
    const snapshot = snapshotAt("2026-10-10T12:00:00.000Z");
    await new FileSystemPrerequisiteStatusSnapshots(root).save(snapshot);
    expect(readKept(root)).toEqual({ ...snapshot.toJSON(), projectRoot: root });
  });

  test("now() is an ISO time", () => {
    const now = new FileSystemPrerequisiteStatusSnapshots(projectRoot()).now();
    expect(typeof now === "string" && new Date(now).toISOString() === now).toBe(true);
  });
});
