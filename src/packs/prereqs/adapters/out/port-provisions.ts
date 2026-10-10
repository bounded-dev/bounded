import { type PortProvision, Ports } from "bounded/domain";
import { fileSetFingerprintsPort, prerequisiteRecordsPort, prerequisiteStatusSnapshotsPort } from "../../application/check-prerequisites/check-prerequisites.contract.ts";
import { FileSystemFileSetFingerprints } from "./file-set-fingerprints/file-set-fingerprints.ts";
import { FileSystemPrerequisiteRecords } from "./prerequisite-records/prerequisite-records.ts";
import { FileSystemPrerequisiteStatusSnapshots } from "./prerequisite-status-snapshots/prerequisite-status-snapshots.ts";

/**
 * Every port bounded/prereqs requires, for a host's composition root: the
 * fingerprints of each project's files, and its records and starts in the
 * project's `.bounded/prereqs/`.
 */
export function prereqsPortProvisions(): readonly PortProvision[] {
  return Object.freeze([
    Ports.provide(fileSetFingerprintsPort, (projectRoot) => new FileSystemFileSetFingerprints(projectRoot)),
    Ports.provide(prerequisiteRecordsPort, (projectRoot) => new FileSystemPrerequisiteRecords(projectRoot)),
  ]);
}

/**
 * The optional port bounded/prereqs may use (ADR 2026-026), for a host that
 * shows the pack's status: the status snapshot in each project's
 * `.bounded/prereqs/status.json`, saved after every call and every finish.
 * Pass it beside prereqsPortProvisions(); the pack works the same without it.
 */
export function prereqsStatusSnapshotPortProvisions(): readonly PortProvision[] {
  return Object.freeze([Ports.provide(prerequisiteStatusSnapshotsPort, (projectRoot) => new FileSystemPrerequisiteStatusSnapshots(projectRoot))]);
}
