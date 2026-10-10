import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ports } from "bounded/domain";
import { fileSetFingerprintsPort, prerequisiteRecordsPort, prerequisiteStatusSnapshotsPort } from "../../application/check-prerequisites/check-prerequisites.contract.ts";
import { prereqsPortProvisions, prereqsStatusSnapshotPortProvisions } from "./port-provisions.ts";
import { FileSystemPrerequisiteStatusSnapshots } from "./prerequisite-status-snapshots/prerequisite-status-snapshots.ts";

describe("prereqsPortProvisions", () => {
  test("provides the two ports, frozen", () => {
    const provisions = prereqsPortProvisions();
    expect(provisions.length).toBe(2);
    expect(Object.isFrozen(provisions)).toBe(true);
    const ports = Ports.forProject(mkdtempSync(join(tmpdir(), "prereqs-provisions-")), provisions);
    expect(ports.ok).toBe(true);
    if (!ports.ok) return;
    expect(ports.value.provides(fileSetFingerprintsPort)).toBe(true);
    expect(ports.value.get(fileSetFingerprintsPort).ok).toBe(true);
    expect(ports.value.provides(prerequisiteRecordsPort)).toBe(true);
    expect(ports.value.get(prerequisiteRecordsPort).ok).toBe(true);
  });
});

describe("prereqsStatusSnapshotPortProvisions (ADR 2026-026)", () => {
  test("the snapshot provisions give the optional port, frozen, and prereqsPortProvisions still gives the two required ports", () => {
    const provisions = prereqsStatusSnapshotPortProvisions();
    expect(provisions.length).toBe(1);
    expect(Object.isFrozen(provisions)).toBe(true);
    const ports = Ports.forProject(mkdtempSync(join(tmpdir(), "prereqs-provisions-")), provisions);
    expect(ports.ok).toBe(true);
    if (!ports.ok) return;
    expect(ports.value.provides(prerequisiteStatusSnapshotsPort)).toBe(true);
    const snapshots = ports.value.get(prerequisiteStatusSnapshotsPort);
    expect(snapshots.ok && snapshots.value).toBeInstanceOf(FileSystemPrerequisiteStatusSnapshots);
    expect(ports.value.provides(fileSetFingerprintsPort)).toBe(false);
    const required = Ports.forProject(mkdtempSync(join(tmpdir(), "prereqs-provisions-")), prereqsPortProvisions());
    expect(required.ok && [required.value.provides(fileSetFingerprintsPort), required.value.provides(prerequisiteRecordsPort), required.value.provides(prerequisiteStatusSnapshotsPort)]).toEqual([true, true, false]);
  });
});
